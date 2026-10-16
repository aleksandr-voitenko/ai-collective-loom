import { Type,type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { closed,UUID } from '../contracts/participation.js';
import type { SharedOptions,SharedPageView,SharedScopeView } from '../contracts/following.js';
import { identityGeneration } from './participation-client.js';

const Request=Type.Object({cursor:Type.String({minLength:1,maxLength:16384}),limit:Type.Integer({minimum:1,maximum:25}),
  max_response_bytes:Type.Integer({minimum:4096,maximum:131072})},closed);
const Record=Type.Object({version:Type.Literal(1),sequence:Type.Integer({minimum:1}),request:Request,
  previous_request:Type.Optional(Request),recent_event_ids:Type.Array(UUID,{maxItems:100,uniqueItems:true})},closed);
const Records=Type.Record(Type.String({maxLength:512}),Record,{maxProperties:16});
type Saved=Static<typeof Record>;
export const sharedScopeKey=(scope:SharedScopeView)=>JSON.stringify(scope);
export const sharedToken=(options:SharedOptions)=>options.cursor??options.checkpoint??options.recovery?.token;
export class SharedRecovery {
  readonly prefix:string;
  private readonly owner=identityGeneration();
  constructor(instance:string,participant:string,private readonly storage:Storage=localStorage){this.prefix=`loom.shared-pages:${location.origin}:${instance}:${participant}`;}
  private records():Record<string,Saved>{
    const raw=this.storage.getItem(this.prefix);if(raw===null)return {};
    try{if(new TextEncoder().encode(raw).length>524288)throw new Error();const records:unknown=JSON.parse(raw);
      if(!Value.Check(Records,records)||Object.keys(records).length>16||Object.values(records).some(r=>new TextEncoder().encode(JSON.stringify(r)).length>32768))throw new Error();
      return records;
    }catch{throw new Error('Saved shared-change recovery is incompatible. Explicitly clear shared change views to start retained history again.');}
  }
  read(key:string){return this.records()[key];}
  async save(key:string,page:SharedPageView,expected:number,active:()=>boolean){
    if(!navigator.locks)throw new Error('This browser needs Web Locks to retain shared change recovery.');
    return navigator.locks.request(this.prefix,()=>{
      if(!active()||this.owner!==identityGeneration())throw new DOMException('View changed.','AbortError');
      const records=this.records(),previous=records[key],original=this.storage.getItem(this.prefix);
      if((previous?.sequence??0)!==expected)throw new Error('Another tab changed this shared view. Reload before continuing.');
      const record:Saved={version:1,sequence:expected+1,request:{cursor:page.page_cursor,limit:page.limit,max_response_bytes:page.max_response_bytes},
        ...(previous?{previous_request:previous.request}:{}),recent_event_ids:[...new Set([...(previous?.recent_event_ids??[]),...page.items.map(i=>i.event_id)])].slice(-100)};
      records[key]=record;
      const raw=JSON.stringify(records);
      if(Object.keys(records).length>16||new TextEncoder().encode(JSON.stringify(record)).length>32768||new TextEncoder().encode(raw).length>524288)
        throw new Error('Shared recovery is full. Clear saved shared change views explicitly; other recovery records remain independent.');
      try{this.storage.setItem(this.prefix,raw);if(this.storage.getItem(this.prefix)!==raw)throw new Error();}
      catch{
        // Keep the previous request recoverable even when read-back fails after
        // a write. No successor is exposed by the view until this resolves.
        try{if(original===null)this.storage.removeItem(this.prefix);else this.storage.setItem(this.prefix,original);}catch{/* The new bounded record also retains previous_request. */}
        throw new Error('Shared recovery could not be saved. The successor has not been exposed; retry this page.');
      }
      return record;
    });
  }
  async clear(active:()=>boolean=()=>true){
    if(!navigator.locks)throw new Error('Shared recovery cleanup requires Web Locks.');
    await navigator.locks.request(this.prefix,()=>{
      if(!active()||this.owner!==identityGeneration())throw new DOMException('Identity changed.','AbortError');
      this.storage.removeItem(this.prefix);
    });
  }
}
