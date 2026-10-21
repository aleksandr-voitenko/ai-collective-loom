import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createApplication} from '../../src/server/http/app.js';
import type {ParticipationServices} from '../../src/server/http/participation.js';
import {responseContracts,responseContract,classifyError,classifyResponse} from '../../src/web/response-contracts.js';
import {Value} from '@sinclair/typebox/value';
import {Onboarding} from '../../src/contracts/participation.js';
import {ProposalRoute} from '../../src/contracts/organization.js';
import {ApiError} from '../../src/web/request-context.js';

type Schema={const?:unknown;enum?:unknown[];$ref?:string;properties?:Record<string,Schema>;items?:Schema;
 anyOf?:Schema[];oneOf?:Schema[];allOf?:Schema[]};
function unavailablePaths(schema:Schema,resolve:(ref:string)=>Schema,path='',result=new Set<string>()){
 if(schema.$ref)return unavailablePaths(resolve(schema.$ref),resolve,path,result);
 if(schema.const==='unavailable'||schema.enum?.includes('unavailable'))result.add(path);
 for(const [key,value] of Object.entries(schema.properties??{}))unavailablePaths(value,resolve,path?path+'.'+key:key,result);
 if(schema.items)unavailablePaths(schema.items,resolve,path+'[]',result);
 for(const value of [...schema.anyOf??[],...schema.oneOf??[],...schema.allOf??[]])unavailablePaths(value,resolve,path,result);
 return result;
}

test('every actual JSON endpoint and every negative success field has an explicit authorization meaning',async t=>{
 // Register real routes without dispatching handlers or opening a database.
 const participation={database:{transaction:async()=>{throw new Error('This inventory must not execute SQL.');}},
  authentication:{policy:{origin:'https://loom.test'}},administration:{}} as unknown as ParticipationServices;
 const app=await createApplication({logger:false,database:{isReady:async()=>true,close:async()=>{}},participation});
 t.after(()=>app.close());await app.ready();
 const document=app.swagger() as unknown as {paths:Record<string,Record<string,{responses:Record<string,{content?:Record<string,{schema:Schema}>}>}>>;components:{schemas:Record<string,Schema>}};
 const resolve=(ref:string)=>{assert.ok(ref.startsWith('#/components/schemas/'));const value=document.components.schemas[ref.split('/').at(-1)!];assert.ok(value);return value;};
 const actual=new Set(['GET /api/v1/openapi.json']);
 for(const [path,methods] of Object.entries(document.paths))for(const [method,operation] of Object.entries(methods)){
  const route=method.toUpperCase()+' '+path;actual.add(route);
  const contract=responseContracts.get(route);assert.ok(contract,`Unclassified endpoint: ${route}`);
  assert.ok(['unrelated','discovery','authenticated'].includes(contract.errors.session),route+' requires explicit session semantics');
  for(const code of ['forbidden','unavailable'] as const)assert.ok(['retain','withdraw'].includes(contract.errors[code]),route+' requires explicit content semantics for '+code);
  const fields=new Set<string>();
  for(const [status,response] of Object.entries(operation.responses))if(status.startsWith('2')){
   const schema=response.content?.['application/json']?.schema;
   if(schema)unavailablePaths(schema,resolve,'',fields);
  }
  const rule=contract.rule;
  assert.deepEqual([...fields].sort(),rule.kind==='classified'?[...rule.source,...Object.keys(rule.local)].sort():[],route);
  if(rule.kind==='classified'){
   assert.deepEqual([...unavailablePaths(rule.schema as Schema,()=>{throw new Error('Unexpected unresolved browser schema.');})].sort(),[...fields].sort(),route+' browser schema drift');
   for(const reason of Object.values(rule.local))assert.ok(reason.trim().length>20,route+' requires a local-absence rationale');
  }else assert.ok(rule.reason.trim().length>20);
  const concrete=path.replace(/\{\w+\}/g,'12345678-abcd-1234-abcd-123456789abc');
  assert.equal(responseContract(concrete+'?cursor=CaseSensitive',method.toUpperCase() as 'GET'|'POST'),contract);
 }
 assert.deepEqual([...responseContracts.keys()].sort(),[...actual].sort(),'Removed routes must not remain as transport escape hatches.');
});

test('identical error codes have endpoint-specific session, authority, source and local meanings',()=>{
 const cases=[
  ['GET','/health/ready','unauthenticated','local'],
  ['GET','/api/v1/identity/self','unauthenticated','anonymous'],
  ['POST','/api/v1/identity/register/start','unauthenticated','local'],
  ['POST','/api/v1/identity/register/finish','invalid_actor','local'],
  ['POST','/api/v1/identity/signin/start','forbidden','local'],
  ['POST','/api/v1/identity/signin/finish','unavailable','local'],
  ['POST','/api/v1/identity/logout','unauthenticated','revoke-owner'],
  ['POST','/api/v1/identity/revoke','unavailable','local'],
  ['GET','/api/v1/identity/credentials','forbidden','withdraw-source'],
  ['POST','/api/v1/identity/accounts','forbidden','withdraw-source'],
  ['POST','/api/v1/replies','forbidden','local'],
  ['POST','/api/v1/organization/changes','forbidden','withdraw-source'],
  ['POST','/api/v1/operations/status','unavailable','withdraw-source'],
  ['GET','/api/v1/community','invalid_actor','revoke-owner'],
  ['GET','/api/v1/community','unavailable','withdraw-source'],
  ['GET','/api/v1/me/following/private','unavailable','local'],
  ['POST','/api/v1/me/following/private/state','unavailable','withdraw-source'],
  ['POST','/api/v1/me/saved-items/status','unavailable','withdraw-source'],
  ['POST','/api/v1/me/reading/state','invalid_actor','revoke-owner'],
 ] as const;
 const effect=(name:string)=>({session:name==='revoke-owner'?'revoke':name==='anonymous'?'anonymous':'retain',content:['revoke-owner','withdraw-source'].includes(name)?'withdraw':'retain'});
 for(const [method,path,code,expected] of cases)assert.deepEqual(classifyError(responseContract(path,method),new ApiError(code,'Refused.')),effect(expected),path);
 for(const contract of responseContracts.values())for(const code of ['invalid_proof','service_unavailable','rate_limited','invalid_request','unknown'])
  assert.deepEqual(classifyError(contract,new ApiError(code,'Local failure.')),effect('local'));
});

test('endpoint classification rejects unknown paths and methods without normalizing request bytes',()=>{
 for(const path of ['/api/v1/unknown','https://loom.test/api/v1/me/saved-items','/api/v1/openapiXjson','/api/v1/resources/a/extra','/api/v1/resources/a#fragment'])
  assert.throws(()=>responseContract(path,'GET'),/classification/);
 assert.throws(()=>responseContract('/api/v1/me/saved-items/state','GET'),/classification/);
 assert.throws(()=>responseContract('/api/v1/me/saved-items','POST'),/classification/);
 assert.equal(responseContract('/api/v1/resources/ABC/revisions/DEF','GET').revisionMiss,true);
 assert.equal(responseContract('/api/v1/resources/ABC/history','GET').revisionMiss,false);
});

test('only certified posting closure is local; missing or unreadable proposal sources still revoke content',()=>{
 for(const [path,schema,field] of [['/api/v1/community',Onboarding,'proposal_area'],['/api/v1/areas/source/proposal-route',ProposalRoute,'']] as const){
  const properties={...schema.properties} as Record<string,any>;
  for(const key of ['instance_id','affected_area_id'])if(properties[key])properties[key]={...properties[key],default:'12345678-abcd-1234-abcd-123456789abc'};
  if(properties.destination)properties.destination={...properties.destination,default:null};
  const value=Value.Create({...schema,properties}) as Record<string,unknown>;
  const contract=responseContract(path,'GET');
  if(path.endsWith('community'))value.overview={state:'setup_incomplete'};
  if(!field)value.affected_area_id='12345678-abcd-1234-abcd-123456789abc';
  const designation=field?(value[field]={state:'unavailable'}) as Record<string,unknown>:value;
  designation.state='unavailable';
  if(!field)value.destination=null;
  assert.equal(classifyResponse(contract,value).denied,true);
  designation.unavailable_reason='publication_closed';
  assert.equal(classifyResponse(contract,value).denied,false);
  delete designation.unavailable_reason;
  assert.equal(classifyResponse(contract,value).denied,true);
 }
});

test('shared role and editor capabilities withdraw content independently of session and receipt access',()=>{
 const paths=['identity/accounts','identity/credentials','identity/state','identity/rename','identity/revoke','identity/reconcile',
  'community/setup','community/settings','editors','summaries/editors','revisions','summary-revisions',
  'organization/changes','organization/status','admin/search/retry','admin/search/rebuild','admin/notifications/retry','admin/notifications/reconcile'];
 for(const path of paths){
  const contract=responseContract('/api/v1/'+path,'POST');
  assert.deepEqual(classifyError(contract,new ApiError('forbidden','Capability removed.')),{session:'retain',content:'withdraw'},path);
  assert.ok(['receipt','boundary-receipt'].includes(contract.access),path+' must still settle privately');
 }
 for(const contract of responseContracts.values())if(contract.errors.session==='authenticated')for(const code of ['unauthenticated','invalid_actor'])
  assert.deepEqual(classifyError(contract,new ApiError(code,'Identity removed.')),{session:'revoke',content:'withdraw'});
});

test('moderation control metadata never grants source access; every recorded lifecycle receipt fences older content',()=>{
 const target={kind:'artifact',resource_id:'12345678-abcd-1234-abcd-123456789abc'};
 const current={target,local_state:'active',version:2,owner_id:null,ordinary_read_available:true};
 for(const path of ['state','status']){
  const contract=responseContract('/api/v1/admin/moderation/'+path,'POST');
  assert.equal(contract.access,'boundary-receipt');
  for(const suppressed of [true,false])for(const ordinary_read_available of [true,false]){
   assert.equal(classifyResponse(contract,{operation_state:'recorded',operation_id:target.resource_id,idempotency:'created',
    outcome:{target,suppressed,version:2},current:{...current,ordinary_read_available}}).denied,true);
  }
  assert.equal(classifyResponse(contract,{operation_state:'not_recorded'}).denied,false);
  assert.deepEqual(classifyError(contract,new ApiError('forbidden','Administrator role removed.')),{session:'retain',content:'withdraw'});
 }
 for(const path of ['resources/ABC','targets','audit']){
  const contract=responseContract('/api/v1/admin/moderation/'+path,'GET');
  assert.equal(classifyResponse(contract,path==='targets'?{items:[current],next_cursor:null,complete:true}:
    path==='audit'?{items:[],next_cursor:null,complete:true}:current).denied,false);
  assert.deepEqual(classifyError(contract,new ApiError('forbidden','Administrator role removed.')),{session:'retain',content:'withdraw'});
 }
});
