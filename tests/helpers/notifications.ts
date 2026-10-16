import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import { fixture as participationFixture } from './summaries.js';
import { NotificationWorker } from '../../src/server/modules/notifications/worker.js';
import { NotificationPage, type NotificationOptions, type NotificationPageView } from '../../src/contracts/notifications.js';
import { Value } from '@sinclair/typebox/value';
import type { AuthoredContent } from '../../src/contracts/participation.js';

export const mentioned=(recipient:string,format:AuthoredContent['format']='loom-markdown-v3',prefix='Please inspect'):AuthoredContent=>{
  const common={text:`${prefix} [[mention:a]] and [[mention:b]].`,mentions:[{token:'a',participant_id:recipient},{token:'b',participant_id:recipient}]};
  return format==='loom-markdown-v1'?{...common,format}:{...common,format,references:[]};
};
export const fields=(content:AuthoredContent)=>content.format==='loom-markdown-v3'?{change_note:null,change_account:null}:{};
export async function fixture(t:TestContext,options:Parameters<typeof participationFixture>[1]={}){
  const f=await participationFixture(t,options),worker=new NotificationWorker(f.database);
  const publish=async(client:typeof f.admin,path:string,body:Record<string,unknown>)=>{
    const response=await client.call(path,{idempotency_key:randomUUID(),...body});
    assert.equal(response.status,201,JSON.stringify(response.body));return response.body as {resource_id:string;revision_id:string;operation_id:string};
  };
  const page=async(client:typeof f.admin,options:NotificationOptions={})=>{
    const response=await client.call('/api/v1/me/notifications/query',options);
    assert.equal(response.status,200,JSON.stringify(response.body));
    assert.ok(Value.Check(NotificationPage,response.body),JSON.stringify(response.body));
    return response.body as NotificationPageView;
  };
  const drain=async()=>{
    for(let cycle=0;cycle<100;cycle++){
      await worker.tick();
      const pending=(await f.observer.query("SELECT id FROM loom.notification_jobs WHERE state IN ('pending','running') LIMIT 1")).rowCount;
      const scan=(await f.observer.query('SELECT scan_complete FROM loom.notification_state')).rows[0].scan_complete;
      if(!pending&&scan)return;
    }
    assert.fail('Notification fixture did not reach a terminal job state within 100 bounded cycles.');
  };
  return {...f,worker,publish,page,drain};
}
