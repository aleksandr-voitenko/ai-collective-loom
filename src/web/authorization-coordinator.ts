import {ContentCoordinator} from './protected-content.js';
import {ApiError,identityGeneration,invalidateIdentity,settleAnonymous} from './request-context.js';
import {classifyError,type ResponseContract} from './response-contracts.js';

let coordinator:ContentCoordinator|undefined;
export function identityContent(){
  if(!coordinator?.current())coordinator=new ContentCoordinator(identityGeneration(),identityGeneration);
  return coordinator;
}
export function observeRequestFailure(owner:number,contract:ResponseContract,error:unknown){
  if(owner!==identityGeneration()||!(error instanceof ApiError))return;
  const effects=classifyError(contract,error);
  switch(effects.session){
    case 'retain':
      if(effects.content==='withdraw')coordinator?.withdraw(error);
      return;
    case 'anonymous':{
      const established=settleAnonymous();
      // Even an unresolved session must fence an existing protected host. A
      // retained coordinator from a revoked owner must not trigger another event.
      if(!established&&!(coordinator?.current()&&coordinator.retained.regions>0))return;
      break;
    }
    case 'revoke':break;
  }
  coordinator?.invalidate(error);invalidateIdentity();
}
export function observeSourceDenial(owner:number){
  if(owner===identityGeneration())coordinator?.withdraw(new ApiError('unavailable','Current source unavailable. Reauthorize the displayed view.'));
}
