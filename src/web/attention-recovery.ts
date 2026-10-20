import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { closed } from '../contracts/participation.js';
import { MuteUpdate,DismissUpdate,attentionLimits,type AttentionInputView } from '../contracts/attention.js';
import { contentKey } from './protected-content.js';
const AttentionCommand=Type.Union([Type.Object({kind:Type.Literal('mute'),body:MuteUpdate},closed),Type.Object({kind:Type.Literal('dismissal'),group_id:Type.Optional(Type.String({pattern:'^[a-f0-9-]{36}$'})),body:DismissUpdate},closed)]);
export type AttentionCommandView=Static<typeof AttentionCommand>;
// Comparison keys follow server UUID identity; never normalize the retained
// command, whose spelling and ordering must survive exact retry unchanged.
export const attentionInputKey=(input:AttentionInputView)=>input.kind+':'+input.id.toLowerCase();
export function commandTargets(command:AttentionCommandView){return command.kind==='mute'?[contentKey(command.body.target)]:command.body.inputs.map(attentionInputKey);}
import { identityGeneration } from './participation-client.js';

const RecordSchema=Type.Object({version:Type.Literal(1),command:AttentionCommand,attempts:Type.Integer({minimum:0}),
  state:Type.Union([Type.Literal('uncertain'),Type.Literal('rejected'),Type.Literal('conflicted')])},closed);
export type AttentionIntent=Static<typeof RecordSchema>;
export function exportAttentionRecovery(instance:string,participant:string){
  const journal=new AttentionRecovery(instance,participant);
  const blob=new Blob([JSON.stringify({origin:location.origin,instance_id:instance,participant_id:participant,intents:journal.all()},null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download='loom-attention-recovery.json';link.click();URL.revokeObjectURL(url);
}
const bytes=(value:string)=>new TextEncoder().encode(value).length;
export class AttentionRecovery {
  readonly prefix:string;
  private readonly owner=identityGeneration();
  constructor(instance:string,participant:string,private readonly storage:Storage=localStorage){
    this.prefix=`loom.attention:${location.origin}:${instance}:${participant}:`;
  }
  all():AttentionIntent[]{
    const result:AttentionIntent[]=[];let total=0;
    for(let i=0;i<this.storage.length;i++){
      const key=this.storage.key(i);if(!key?.startsWith(this.prefix+'intent:'))continue;
      const raw=this.storage.getItem(key)!;total+=bytes(raw);
      if(bytes(raw)>attentionLimits.requestBytes||total>attentionLimits.localBytes||result.length>=attentionLimits.localOperations)
        throw new Error('Attention recovery exceeds its synthetic limit. Preserve it before continuing.');
      let record:unknown;try{record=JSON.parse(raw);}catch{throw new Error('Attention recovery is unreadable. Preserve it before continuing.');}
      if(!Value.Check(RecordSchema,record)||key!==this.prefix+'intent:'+record.command.body.idempotency_key)
        throw new Error('Attention recovery is incompatible. Preserve it before continuing.');
      result.push(record);
    }
    return result;
  }
  private async locked<T>(work:()=>T){
    if(!navigator.locks)throw new Error('Attention changes require Web Locks to protect recovery across tabs.');
    return navigator.locks.request(this.prefix,async()=>{
      if(this.owner!==identityGeneration())throw new DOMException('Identity changed.','AbortError');
      return work();
    });
  }
  private changed(){window.dispatchEvent(new Event('loom-attention'));}
  private write(record:AttentionIntent){
    const key=this.prefix+'intent:'+record.command.body.idempotency_key,raw=JSON.stringify(record),previous=this.storage.getItem(key);
    const others=this.all().filter(r=>r.command.body.idempotency_key!==record.command.body.idempotency_key);
    if(!Value.Check(RecordSchema,record)||bytes(raw)>attentionLimits.requestBytes||others.length>=attentionLimits.localOperations||
      others.reduce((n,r)=>n+bytes(JSON.stringify(r)),bytes(raw))>attentionLimits.localBytes)throw new Error('Attention recovery is full. Resolve existing changes before creating more.');
    try{this.storage.setItem(key,raw);if(this.storage.getItem(key)!==raw)throw new Error();}
    catch{
      try{if(previous===null)this.storage.removeItem(key);else this.storage.setItem(key,previous);}catch{/* The exact previous intent is never replaced with different semantics. */}
      throw new Error(record.state==='conflicted'
        ?'Attention conflict could not be saved. The exact change remains in recovery; check its outcome again.'
        :'Attention intent could not be saved. No new request was sent.');
    }
    this.changed();return record;
  }
  save(command:AttentionCommandView,active:()=>boolean){return this.locked(()=>{
    if(!active())throw new DOMException('View changed.','AbortError');
    if(this.all().some(r=>r.command.body.idempotency_key===command.body.idempotency_key))throw new Error('Attention operation already exists. Recover its exact request.');
    if(this.all().some(r=>r.state==='uncertain'&&commandTargets(r.command).some(k=>commandTargets(command).includes(k))))throw new Error('Resolve the existing attention change for these inputs before choosing another action.');
    return this.write({version:1,command,attempts:0,state:'uncertain'});
  });}
  begin(record:AttentionIntent){return this.locked(()=>{
    const current=this.all().find(r=>r.command.body.idempotency_key===record.command.body.idempotency_key);
    if(!current||current.state!=='uncertain'||JSON.stringify(current.command)!==JSON.stringify(record.command))throw new Error('Attention intent changed. Refresh recovery.');
    return this.write({...current,attempts:current.attempts+1});
  });}
  rejectFirst(record:AttentionIntent){return this.locked(()=>{
    const current=this.all().find(r=>r.command.body.idempotency_key===record.command.body.idempotency_key);
    if(current?.state==='uncertain'&&current.attempts===1&&record.attempts===1)this.write({...current,state:'rejected'});
  });}
  recordConflict(record:AttentionIntent){return this.locked(()=>{
    const current=this.all().find(r=>r.command.body.idempotency_key===record.command.body.idempotency_key);
    if(!current)return;
    if(JSON.stringify(current.command)!==JSON.stringify(record.command))throw new Error('Attention intent changed. Refresh recovery.');
    // Keep exact, bounded feedback until explicitly dismissed. A late duplicate
    // response must not recreate a notice another tab has already dismissed.
    if(current.state==='uncertain')this.write({...current,state:'conflicted'});
  });}
  finish(record:AttentionIntent,resolvedOnly=false){return this.locked(()=>{
    const current=this.all().find(r=>r.command.body.idempotency_key===record.command.body.idempotency_key);
    if(!current)return;
    if(JSON.stringify(current.command)!==JSON.stringify(record.command)||(resolvedOnly&&current.state==='uncertain'))throw new Error('Attention intent changed. Refresh recovery.');
    this.storage.removeItem(this.prefix+'intent:'+record.command.body.idempotency_key);this.changed();
  });}
  clear(){return this.locked(()=>{
    for(const record of this.all())this.storage.removeItem(this.prefix+'intent:'+record.command.body.idempotency_key);
    this.changed();
  });}
}
