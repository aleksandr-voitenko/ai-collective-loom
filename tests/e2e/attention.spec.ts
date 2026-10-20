import {randomUUID} from 'node:crypto';
import {mkdir,copyFile} from 'node:fs/promises';
import type {Page,Route} from '@playwright/test';
import {test,expect} from '../helpers/browser-fixtures.js';
import {setup,api,journal} from '../helpers/change-browser.js';
import {plain} from '../helpers/references.js';
import {editUpdatesToken} from '../helpers/updates-token.js';
import {mentioned} from '../helpers/notifications.js';
import {NativeSearchWorker} from '../../scripts/lib/native-search-worker.js';
const endpoint='/api/v1/me/attention/private',previews='/api/v1/me/attention/previews';
for(const kind of ['area','discussion','artifact','overview'] as const)test(`authorization boundary withdraws the full ${kind} host after source suppression`,async({page,context,server})=>{
  const f=await setup(page,context,server);
  let id=kind==='area'?f.area:f.target.resource_id,title=kind==='area'?'General':'Target R1';
  if(kind==='discussion'){
    const opening=await api(page,'/api/v1/discussions',{idempotency_key:randomUUID(),area_id:f.area,title:'Protected discussion',content:plain('Protected opening body')});
    id=(await api(page,'/api/v1/resources/'+opening.resource_id)).discussion_id;title='Protected discussion';
  }
  if(kind==='overview'){
    id=(await api(page,'/api/v1/community')).overview.resource_id;
    title=(await api(page,'/api/v1/resources/'+id)).title;
  }
  const target={kind:kind==='overview'?'artifact':kind,resource_id:id};
  await api(page,endpoint+'/mutes/state',{target,muted:true,include_descendants:false,expected_version:0,idempotency_key:randomUUID()});
  await page.goto(server.origin+'/loom/'+(kind==='overview'?'overview':(kind==='artifact'?'resource':kind)+'/'+id));
  await expect(page.getByRole('heading',{name:title,exact:true})).toBeVisible();
  if(kind==='overview')await expect(page.getByRole('button',{name:'Suggest an organizational change'})).toBeVisible();
  await page.getByText('Routine attention',{exact:true}).click();
  const control=page.locator('[data-mute-target]');
  await expect(control.getByRole('button',{name:'Unmute routine updates'})).toHaveAttribute('aria-disabled','false');
  const instance=(await api(page,'/api/v1/community')).instance_id,prefix=`loom.intent.v1:${server.origin}:${instance}:${f.person}:`;
  for(const transition of ['first','repeated'] as const){
    void transition;
    await overlappingLookups({page,id,path:previews,
      start:()=>control.getByRole('button',{name:'Refresh mute state'}).click(),
      suppress:async()=>{await server.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='suppressed' WHERE id=$1",[id]));},
      withdrawn:async()=>{await expect(page.getByRole('heading',{name:title,exact:true})).toHaveCount(0);
        if(kind==='overview')await expect(page.getByRole('button',{name:'Suggest an organizational change'})).toHaveCount(0);}});
    await server.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='active' WHERE id=$1",[id]));
    await page.getByRole('button',{name:'Retry protected view'}).click();
    await expect(page.getByRole('heading',{name:title,exact:true})).toBeVisible();
    await page.getByText('Routine attention',{exact:true}).click();
    await expect(control.getByRole('button',{name:'Unmute routine updates'})).toHaveAttribute('aria-disabled','false');
  }
  await server.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='suppressed' WHERE id=$1",[id]));
  await control.getByRole('button',{name:'Refresh mute state'}).click();
  await expect(page.getByRole('heading',{name:title,exact:true})).toHaveCount(0);
  if(kind==='artifact'||kind==='discussion')await expect(page.getByText(kind==='artifact'?'Original target text':'Protected opening body',{exact:true})).toHaveCount(0);
  if(kind==='overview'){
    await expect(page.getByText('Overview',{exact:true})).toHaveCount(0);
    await expect(page.getByRole('button',{name:'Suggest an organizational change'})).toHaveCount(0);
  }
  await expect(page.getByRole('alert')).toBeFocused();
  await server.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='active' WHERE id=$1",[id]));
  await page.getByRole('button',{name:'Retry protected view'}).click();
  await expect(page.getByRole('heading',{name:title,exact:true})).toBeVisible();
  expect((await server.observer.query('SELECT muted,version FROM loom.attention_mutes WHERE participant_id=$1 AND resource_id=$2',[f.person,id])).rows).toEqual([{muted:true,version:1}]);
  for(const path of ['lookup','state','status','retry'] as const){
    await page.getByText('Routine attention',{exact:true}).click();
    const change=control.getByRole('button',{name:/^(Mute|Unmute) routine updates$/});
    await expect(change).toHaveAttribute('aria-disabled','false');
    if(path==='status'||path==='retry'){
      await page.route('**'+endpoint+'/mutes/state',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'service_unavailable',message:'Synthetic response loss',operation_outcome:'unknown'}})}),{times:1});
      await change.click();await expect(control.getByRole('button',{name:'Check attention outcome'})).toBeVisible();
    }
    const active=(await server.observer.query("SELECT id FROM loom.participant_credentials WHERE participant_id=$1 AND state='active'",[f.person])).rows.map(r=>r.id);
    await server.database.transaction(tx=>tx.query("UPDATE loom.participant_credentials SET state='revoked' WHERE id=ANY($1::uuid[])",[active]));
    const action=path==='lookup'?'Refresh mute state':path==='status'?'Check attention outcome':path==='retry'?'Retry same attention change':await change.textContent();
    await control.getByRole('button',{name:action!,exact:true}).click();
    await expect(page.getByRole('heading',{name:title,exact:true})).toHaveCount(0);
    await expect(page.getByRole('button',{name:'Sign in with passkey',exact:true})).toBeVisible();
    const retained=await intents(page);
    expect(retained).toHaveLength(path==='lookup'?0:1);
    await server.database.transaction(tx=>tx.query("UPDATE loom.participant_credentials SET state='active' WHERE id=ANY($1::uuid[])",[active]));
    await page.reload();
    await expect(page.getByRole('heading',{name:title,exact:true})).toBeVisible();
    if(retained.length){
      await page.getByText('Routine attention',{exact:true}).click();
      const sent=page.waitForRequest(r=>r.url().endsWith(endpoint+'/mutes/state'));
      await control.getByRole('button',{name:'Retry same attention change'}).click();
      expect((await sent).postDataJSON()).toEqual(retained[0].command.body);
      await expect.poll(()=>intents(page)).toEqual([]);
      await page.getByText('Routine attention',{exact:true}).click();
    }
  }
  const followControl=page.locator('[data-follow-target]');
  const followingBase='/api/v1/me/following/private',pattern='**'+followingBase+'/*';
  const hold=(path:string)=>({path,entered:false,release:barrier(),finished:barrier()});
  let armed:ReturnType<typeof hold>|undefined,loseMutation=false,captured=0;
  // Do not expire/reinstall the last interception route between fault and hold.
  // Each phase explicitly arms one request and waits for handler completion.
  const handler=async(route:Route)=>{
    const path=new URL(route.request().url()).pathname;
    if(loseMutation&&path===followingBase+'/state'){
      loseMutation=false;await route.fetch();
      await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'service_unavailable',message:'Synthetic response loss'}})});return;
    }
    const held=armed;
    if(!held||held.entered||held.path!==path){await route.continue();return;}
    held.entered=true;captured++;
    try{await held.release.promise;await route.continue();}finally{held.finished.release();}
  };
  await page.route(pattern,handler);
  try{
  for(const path of ['lookup','state','status','retry'] as const){
    const change=followControl.getByRole('button',{name:/^(Unfollow|Follow)$/});await expect(change).toBeEnabled();
    if(path==='status'||path==='retry'){
      loseMutation=true;
      await change.click();await expect(followControl.getByRole('button',{name:'Check follow status'})).toBeVisible();
    }
    const active=(await server.observer.query("SELECT id FROM loom.participant_credentials WHERE participant_id=$1 AND state='active'",[f.person])).rows.map(r=>r.id);
    const routePath=followingBase+'/'+(path==='status'?'status':path==='lookup'?'lookup':'state'),held=hold(routePath);armed=held;
    try{
      // Capture the intended request before revoking credentials. A discussion's
      // independent background read must not remove the button before dispatch.
      if(path==='lookup')await page.evaluate(prefix=>window.dispatchEvent(new CustomEvent('loom-following-change',{detail:prefix})),prefix);
      else await followControl.getByRole('button',{name:path==='status'?'Check follow status':path==='retry'?'Retry same follow change':(await change.textContent())!,exact:true}).click();
      await expect.poll(()=>held.entered).toBe(true);
      await server.database.transaction(tx=>tx.query("UPDATE loom.participant_credentials SET state='revoked' WHERE id=ANY($1::uuid[])",[active]));
      const refused=page.waitForResponse(r=>r.url().endsWith(routePath)&&r.status()>=400);held.release.release();await refused;await held.finished.promise;
    }finally{held.release.release();armed=undefined;}
    await expect(page.getByRole('heading',{name:title,exact:true})).toHaveCount(0);
    await expect(page.getByRole('button',{name:'Sign in with passkey',exact:true})).toBeVisible();
    const retained=await journal(page,'following.set');expect(!!retained).toBe(path!=='lookup');
    await server.database.transaction(tx=>tx.query("UPDATE loom.participant_credentials SET state='active' WHERE id=ANY($1::uuid[])",[active]));
    await page.reload();await expect(page.getByRole('heading',{name:title,exact:true})).toBeVisible();
    if(retained){
      const sent=page.waitForRequest(r=>r.url().endsWith('/api/v1/me/following/private/state'));
      await followControl.getByRole('button',{name:'Retry same follow change'}).click();expect((await sent).postDataJSON()).toEqual(retained.body);
      await expect.poll(()=>journal(page,'following.set')).toBeUndefined();
    }
  }
  expect(captured).toBe(4);
  }finally{armed?.release.release();await page.unroute(pattern,handler);}
});
const intents=(page:Page)=>page.evaluate(()=>Object.entries(localStorage).filter(([k])=>k.startsWith('loom.attention:')&&k.includes(':intent:')).map(([k,v])=>({key:k,...JSON.parse(v)})));
function barrier(){let release!:()=>void;const promise=new Promise<void>(r=>release=r);return {promise,release};}
async function overlappingLookups({page,path,id,start,suppress,withdrawn}:{page:Page;path:string;id:string;
  start:()=>Promise<unknown>;suppress:()=>Promise<void>;withdrawn:()=>Promise<void>}){
  const firstEntered=barrier(),sendFirst=barrier(),firstDone=barrier(),secondReady=barrier(),sendSecond=barrier(),secondDone=barrier();
  let requests=0;
  await page.route('**'+path,async route=>{
    if(!route.request().postDataJSON().targets.some((v:any)=>v.resource_id===id)){await route.continue();return;}
    const attempt=++requests;
    if(attempt===1){firstEntered.release();await sendFirst.promise;}
    const response=await route.fetch();
    if(attempt===2){expect((await response.json()).items.find((v:any)=>v.target.resource_id===id).source.state).toBe('available');secondReady.release();await sendSecond.promise;}
    if(attempt===1){expect(response.status()===404||(await response.json()).items.find((v:any)=>v.target.resource_id===id).source.state==='unavailable').toBe(true);}
    await route.fulfill({response});
    if(attempt===1)firstDone.release();if(attempt===2)secondDone.release();
  });
  try{
    // Delay the first dispatch so the newer request reads before suppression.
    // Its available response remains in flight when the first refuses access.
    await start();await firstEntered.promise;await start();await secondReady.promise;
    await suppress();sendFirst.release();await firstDone.promise;await withdrawn();
    sendSecond.release();await secondDone.promise;
    await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
    await withdrawn();
  }finally{sendFirst.release();sendSecond.release();await page.unrouteAll({behavior:'wait'});}
}
async function ready(page:Page){
  await expect(page.getByRole('heading',{name:'Updates',exact:true})).toBeVisible();
  await expect(page.getByText('Interval, coverage and recovery',{exact:true})).toBeVisible();
  for(let i=0;i<12;i++){
    await expect(page.getByRole('button',{name:'Refresh scope from retained history'})).toHaveAttribute('aria-disabled','false');
    const more=page.getByRole('button',{name:'Continue preparing Updates'});if(!await more.isVisible())return;await more.click();
  }throw new Error('Synthetic preparation exceeded twelve steps');
}
async function follow(page:Page,id:string){await api(page,'/api/v1/me/following/private/state',{target:{kind:'artifact',resource_id:id},include_descendants:false,preferences:['artifact_revisions'],following:true,expected_version:0,idempotency_key:randomUUID()});}
async function open(page:Page){await page.getByRole('link',{name:'Updates',exact:true}).click();await ready(page);await page.getByText('Attention controls',{exact:true}).click();}

test('Following withdraws enclosing source metadata after a newer mute lookup and rejects an older list',async({page,context,server})=>{
  const f=await setup(page,context,server);await follow(page,f.target.resource_id);
  await page.getByRole('link',{name:'Following',exact:true}).click();
  const row=page.locator('.following-row'),control=page.locator(`[data-mute-target="artifact:${f.target.resource_id}"]`);
  await expect(row.getByRole('heading',{name:'Target R1'})).toBeVisible();await row.getByText('Routine attention',{exact:true}).click();
  await expect(control.getByRole('button',{name:'Mute routine updates',exact:true})).toHaveAttribute('aria-disabled','false');
  const instance=(await api(page,'/api/v1/community')).instance_id,prefix=`loom.intent.v1:${server.origin}:${instance}:${f.person}:`;
  for(const transition of ['first','repeated'] as const){
    void transition;
    await overlappingLookups({page,id:f.target.resource_id,path:previews,
      start:()=>control.getByRole('button',{name:'Refresh mute state'}).click(),
      suppress:async()=>{await server.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='suppressed' WHERE id=$1",[f.target.resource_id]));},
      withdrawn:async()=>{await expect(row.getByRole('heading',{name:'Target R1'})).toHaveCount(0);await expect(row.getByText('General',{exact:true})).toHaveCount(0);
        await expect(control.getByText(/Routine artifact updates · Target R1/)).toHaveCount(0);}});
    await expect(row.getByRole('button',{name:'Unfollow',exact:true})).toBeEnabled();
    await server.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='active' WHERE id=$1",[f.target.resource_id]));
    await page.getByRole('button',{name:'Retry following page'}).click();
    await expect(row.getByRole('heading',{name:'Target R1'})).toBeVisible();
    await expect(control.getByRole('button',{name:'Mute routine updates',exact:true})).toHaveAttribute('aria-disabled','false');
  }
  const entered=barrier(),release=barrier();
  await page.route('**/api/v1/me/following/private?*',async route=>{const response=await route.fetch();entered.release();await release.promise;await route.fulfill({response});});
  try{
    await page.getByRole('button',{name:'Refresh following',exact:true}).click();await entered.promise;
    await server.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='suppressed' WHERE id=$1",[f.target.resource_id]));
    await control.getByRole('button',{name:'Refresh mute state'}).click();
    await expect(row.getByRole('heading',{name:'Target R1'})).toHaveCount(0);await expect(row.getByText('General',{exact:true})).toHaveCount(0);
    await expect(row.getByRole('button',{name:'Unfollow',exact:true})).toBeEnabled();await expect(page.getByRole('button',{name:'Retry following page'})).toBeVisible();
    release.release();await page.unrouteAll({behavior:'wait'});await expect(row.getByRole('heading',{name:'Target R1'})).toHaveCount(0);
    await page.getByRole('button',{name:'Retry following page'}).click();
    await expect(row.getByRole('heading',{name:'Followed target unavailable'})).toBeVisible();
    await expect(row.getByRole('button',{name:'Unfollow',exact:true})).toBeEnabled();
    await expect(row.getByText('General',{exact:true})).toHaveCount(0);await expect(page.getByRole('heading',{name:'Target R1'})).toHaveCount(0);
    expect((await server.observer.query('SELECT following,version FROM loom.following_targets WHERE participant_id=$1',[f.person])).rows).toEqual([{following:true,version:1}]);
  }finally{release.release();await page.unrouteAll({behavior:'wait'});}
  await server.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='active' WHERE id=$1",[f.target.resource_id]));
  const sibling=await api(page,'/api/v1/artifacts',{idempotency_key:randomUUID(),area_id:f.area,title:'Following sibling source',content:plain('Synthetic Following sibling')});
  await follow(page,sibling.resource_id);
  const first=page.locator('.following-row').filter({has:page.locator(`[data-follow-target="artifact:${f.target.resource_id}"]`)});
  const second=page.locator('.following-row').filter({has:page.locator(`[data-follow-target="artifact:${sibling.resource_id}"]`)});
  const phase=(path:string)=>({path,heldMute:barrier(),heldList:barrier(),release:barrier(),muteDone:barrier(),listDone:barrier(),muteHeld:false,listHeld:false});
  let pending:ReturnType<typeof phase>|undefined,loseMutation=false;
  // One handler spans response loss and all five hold/release phases. A one-shot
  // route followed by immediate reinstallation previously missed requests in CI.
  await page.route('**/api/v1/**',async route=>{
    const path=new URL(route.request().url()).pathname;
    if(loseMutation&&path==='/api/v1/me/following/private/state'){
      loseMutation=false;await route.fetch();await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'service_unavailable',message:'Committed response lost'}})});return;
    }
    const held=pending;
    if(held&&path===previews&&!held.muteHeld&&route.request().postDataJSON().targets.some((v:any)=>v.resource_id===sibling.resource_id)){
      held.muteHeld=true;try{const response=await route.fetch();held.heldMute.release();await held.release.promise;await route.fulfill({response});}finally{held.muteDone.release();}return;
    }
    if(held&&held.path!=='collection'&&path==='/api/v1/me/following/private'&&!held.listHeld){
      held.listHeld=true;try{const response=await route.fetch();held.heldList.release();await held.release.promise;await route.fulfill({response});}finally{held.listDone.release();}return;
    }
    if(held&&['mutation','status','retry'].includes(held.path)&&path==='/api/v1/me/following/private/lookup')await held.release.promise;
    await route.continue();
  });
  try{
  for(const path of ['collection','lookup','mutation','status','retry'] as const){
    await server.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='active' WHERE id=$1",[f.area]));
    const current=await api(page,'/api/v1/me/following/private/lookup',{kind:'artifact',resource_id:f.target.resource_id});
    if(!current.following)await api(page,'/api/v1/me/following/private/state',{target:current.target,following:true,include_descendants:false,preferences:current.preferences,expected_version:current.version,idempotency_key:randomUUID()});
    await page.getByRole('button',{name:'Refresh following',exact:true}).click();
    await expect(first.getByRole('heading',{name:'Target R1'})).toBeVisible();await expect(second.getByRole('heading',{name:'Following sibling source'})).toBeVisible();
    for(const item of [first,second]){
      if(!await item.getByRole('button',{name:'Refresh mute state'}).isVisible())await item.getByText('Routine attention',{exact:true}).click();
      await item.getByRole('button',{name:'Refresh mute state'}).click();
    }
    await expect(first.getByText('Routine artifact updates · Target R1',{exact:true})).toBeVisible();
    await expect(second.getByText('Routine artifact updates · Following sibling source',{exact:true})).toBeVisible();
    if(path==='status'||path==='retry'){
      loseMutation=true;
      await first.getByRole('button',{name:'Unfollow',exact:true}).click();await expect(first.getByRole('button',{name:'Check follow status'})).toBeVisible();
    }
    const held=phase(path);pending=held;
    try{
      await second.getByRole('button',{name:'Refresh mute state'}).click();await held.heldMute.promise;
      if(path!=='collection'){await page.getByRole('button',{name:'Refresh following',exact:true}).click();await held.heldList.promise;}
      await server.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='suppressed' WHERE id=$1",[f.area]));
      if(path==='collection')await page.getByRole('button',{name:'Refresh following',exact:true}).click();
      else if(path==='lookup')await page.evaluate(prefix=>window.dispatchEvent(new CustomEvent('loom-following-change',{detail:prefix})),prefix);
      else await first.getByRole('button',{name:path==='mutation'?'Unfollow':path==='status'?'Check follow status':'Retry same follow change',exact:true}).click();
      // Private removal/recovery carries no visibility observation. Check source access explicitly.
      if(path!=='collection')await first.getByRole('button',{name:'Refresh mute state'}).click();
      for(const item of [first,second]){
        await expect(item.getByRole('heading',{name:'Followed target unavailable'})).toBeVisible();
        await expect(item.getByText('General',{exact:true})).toHaveCount(0);
      }
      await expect(page.getByText('Routine artifact updates · Target R1',{exact:true})).toHaveCount(0);
      await expect(page.getByText('Routine artifact updates · Following sibling source',{exact:true})).toHaveCount(0);
      held.release.release();await held.muteDone.promise;if(path!=='collection')await held.listDone.promise;
      await expect(first.getByRole('heading',{name:'Target R1'})).toHaveCount(0);await expect(second.getByRole('heading',{name:'Following sibling source'})).toHaveCount(0);
      if(path==='mutation'||path==='status'||path==='retry'){
        await expect.poll(()=>journal(page,'following.set')).toBeUndefined();await expect(first.getByRole('status')).toContainText('Explicit follow removed');
      }
      await expect(second.getByRole('button',{name:'Unfollow',exact:true})).toBeEnabled();
    }finally{held.release.release();pending=undefined;}
  }
  }finally{pending?.release.release();await page.unrouteAll({behavior:'wait'});}
  await second.getByRole('button',{name:'Unfollow',exact:true}).click();await expect(second.getByRole('status')).toContainText('Explicit follow removed');
  await expect.poll(()=>journal(page,'following.set')).toBeUndefined();
});

test('a child settings credential refusal withdraws sibling previews and fences a delayed collection response',async({page,context,server})=>{
  const f=await setup(page,context,server),other=await api(page,'/api/v1/artifacts',{idempotency_key:randomUUID(),area_id:f.area,title:'Second protected title',content:plain('Synthetic second source')});
  for(const id of [f.target.resource_id,other.resource_id])await api(page,endpoint+'/mutes/state',{idempotency_key:randomUUID(),target:{kind:'artifact',resource_id:id},include_descendants:false,muted:true,expected_version:0});
  await page.getByRole('link',{name:'Attention settings',exact:true}).click();
  await expect(page.getByText(/Routine artifact updates · Second protected title/)).toBeVisible();
  const control=page.locator(`[data-mute-target="artifact:${f.target.resource_id}"]`),entered=barrier(),release=barrier();
  await expect(control.getByRole('button',{name:'Unmute routine updates'})).toHaveAttribute('aria-disabled','false');
  await overlappingLookups({page,id:f.target.resource_id,path:previews,
    start:()=>control.getByRole('button',{name:'Refresh mute state'}).click(),
    suppress:async()=>{await server.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='suppressed' WHERE id=$1",[f.area]));},
    withdrawn:async()=>{await expect(page.getByText(/Routine artifact updates · (Target R1|Second protected title)/)).toHaveCount(0);}});
  await expect(control.getByRole('button',{name:'Unmute routine updates'})).toHaveAttribute('aria-disabled','false');
  await server.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='active' WHERE id=$1",[f.area]));
  await page.getByRole('button',{name:'Refresh attention settings'}).click();
  await expect(page.getByText(/Routine artifact updates · Second protected title/)).toBeVisible();
  await expect(control.getByText(/Routine artifact updates · Target R1/)).toBeVisible();
  await page.route('**'+endpoint+'/list',async route=>{const response=await route.fetch();entered.release();await release.promise;await route.fulfill({response});});
  try{
    await page.getByRole('button',{name:'Refresh attention settings'}).click();await entered.promise;
    await server.database.transaction(tx=>tx.query("UPDATE loom.participant_credentials SET state='revoked' WHERE participant_id=$1",[f.person]));
    const sent=page.waitForRequest(r=>r.url().endsWith(endpoint+'/mutes/state'));await control.getByRole('button',{name:'Unmute routine updates'}).click();const command=(await sent).postDataJSON();
    await expect(page.locator('[data-mute-target]')).toHaveCount(0);await expect(page.getByText(/Second protected title/)).toHaveCount(0);
    await expect.poll(async()=>(await intents(page))[0]?.state).toBe('uncertain');expect((await intents(page))[0].command.body).toEqual(command);
    release.release();await page.unrouteAll({behavior:'wait'});await expect(page.locator('[data-mute-target]')).toHaveCount(0);
    await expect(page.getByRole('button',{name:'Sign in with passkey',exact:true})).toBeVisible();
  }finally{release.release();await page.unrouteAll({behavior:'wait'});}
});

test('direct attention withdrawal clears the notification host and rejects an earlier page without losing its retained position',async({page,context,server})=>{
  const f=await setup(page,context,server),publication=await f.admin.call('/api/v1/artifacts',{idempotency_key:randomUUID(),area_id:f.area,title:'Protected direct signal',content:mentioned(f.person),change_note:null,change_account:null});
  expect(publication.status).toBe(201);
  const worker=new NativeSearchWorker(server.configuration,'notifications');await worker.start();
  try{await worker.observeUntil(async()=>(await server.observer.query('SELECT count(*)::int n FROM loom.personal_deliveries WHERE recipient_id=$1',[f.person])).rows[0].n===1);}finally{await worker.stop();}
  await page.goto(server.origin+'/loom/notifications');
  await expect(page.getByRole('heading',{name:'Protected direct signal',exact:true})).toBeVisible();
  await page.getByText('Attention controls',{exact:true}).click();
  const stored=await page.evaluate(()=>Object.entries(localStorage).filter(([key])=>key.startsWith('loom.notifications:')));
  const entered=barrier(),release=barrier();
  await page.route('**/api/v1/me/notifications/query',async route=>{const response=await route.fetch();entered.release();await release.promise;await route.fulfill({response});});
  try{
    await page.getByRole('button',{name:'Check for newer signals',exact:true}).click();await entered.promise;
    await server.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='suppressed' WHERE id=$1",[publication.body.resource_id]));
    await page.getByRole('button',{name:'Dismiss these source inputs',exact:true}).click();
    await expect(page.getByRole('heading',{name:'Protected direct signal',exact:true})).toHaveCount(0);
    await expect(page.getByRole('alert')).toBeFocused();
    release.release();await page.unrouteAll({behavior:'wait'});
    await expect(page.getByRole('heading',{name:'Protected direct signal',exact:true})).toHaveCount(0);
    expect(await page.evaluate(()=>Object.entries(localStorage).filter(([key])=>key.startsWith('loom.notifications:')))).toEqual(stored);
    expect(await intents(page)).toEqual([]);
    await server.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='active' WHERE id=$1",[publication.body.resource_id]));
    await page.getByRole('button',{name:'Retry notification page',exact:true}).click();
    await page.getByRole('button',{name:'Replay retained history',exact:true}).click();
    await expect(page.getByRole('heading',{name:'Protected direct signal',exact:true})).toBeVisible();
  }finally{release.release();await page.unrouteAll({behavior:'wait'});}
});

test('replacing Complete source records with routine personal inputs requires a new exact dismissal selection',async({page,context,server})=>{
  const f=await setup(page,context,server),published=await f.admin.call('/api/v1/artifacts',{idempotency_key:randomUUID(),area_id:f.area,title:'Mixed source',content:mentioned(f.person),change_note:null,change_account:null});expect(published.status).toBe(201);
  const source=published.body;await follow(page,source.resource_id);
  await api(page,endpoint+'/mutes/state',{idempotency_key:randomUUID(),target:{kind:'artifact',resource_id:source.resource_id},include_descendants:false,muted:true,expected_version:0});
  const worker=new NativeSearchWorker(server.configuration,'notifications');await worker.start();try{await worker.observeUntil(async()=>(await server.observer.query('SELECT count(*)::int n FROM loom.personal_deliveries WHERE recipient_id=$1',[f.person])).rows[0].n===1);}finally{await worker.stop();}
  await open(page);await page.getByText('Interval, coverage and recovery',{exact:true}).click();await page.getByRole('button',{name:'Inspect all source records'}).click();
  const expanded=page.getByRole('complementary',{name:'Expanded changes'});await expect(expanded.getByText(/Included shared change; independently available personal signal/)).toBeVisible();
  await expanded.getByText('Dismiss selected source inputs',{exact:true}).click();await expanded.getByRole('button',{name:'Dismiss these source inputs'}).click();
  await expect(expanded.getByText(/1 shared event and 1 personal signal/)).toBeVisible();await expect(expanded.getByRole('button',{name:'Confirm dismissal'})).toBeVisible();
  await page.getByRole('button',{name:'Inspect changes',exact:true}).click();await expect(expanded.getByText(/No shared input in this selection/)).toBeVisible();
  await expect(expanded.getByRole('button',{name:'Confirm dismissal'})).toHaveCount(0);
  await expanded.getByRole('button',{name:'Dismiss these source inputs'}).click();await expect(expanded.getByText(/0 shared events and 1 personal signal/)).toBeVisible();
  const sent=page.waitForRequest(r=>r.url().endsWith(endpoint+'/dismissals/state'));await expanded.getByRole('button',{name:'Confirm dismissal'}).click();const command=(await sent).postDataJSON();
  const delivery=(await server.observer.query('SELECT id FROM loom.personal_deliveries WHERE recipient_id=$1',[f.person])).rows[0].id;
  expect(command.inputs).toEqual([{kind:'personal_delivery',id:delivery,dismissed:true,expected_version:0}]);await expect.poll(()=>intents(page)).toEqual([]);
  expect((await server.observer.query('SELECT input_kind,input_id,dismissed,version FROM loom.attention_dismissals WHERE participant_id=$1',[f.person])).rows).toEqual([{input_kind:'personal_delivery',input_id:delivery,dismissed:true,version:1}]);
});

test('selection preparation detects a remote policy change and explicitly refreshes the same frozen interval',async({page,context,server})=>{
  const f=await setup(page,context,server);await follow(page,f.target.resource_id);await open(page);
  const current=await page.evaluate(()=>Object.values(JSON.parse(Object.entries(localStorage).find(([k])=>k.startsWith('loom.routine-updates-pages:'))![1]))[0] as any);
  const before=await api(page,'/api/v1/me/routine-updates/query',current.request);
  await api(page,endpoint+'/mutes/state',{idempotency_key:randomUUID(),target:{kind:'artifact',resource_id:f.target.resource_id},include_descendants:false,muted:false,expected_version:0});
  await page.getByRole('button',{name:'Dismiss this update'}).click();
  const recover=page.getByRole('alert').filter({has:page.getByRole('button',{name:'Refresh attention selection',exact:true})});await expect(recover).toBeVisible();
  expect(await intents(page)).toEqual([]);const sent=page.waitForRequest(r=>r.url().endsWith('/routine-updates/query')&&r.postDataJSON().recovery?.action==='attention_refresh');
  await recover.getByRole('button',{name:'Refresh attention selection',exact:true}).click();expect((await sent).postDataJSON()).toEqual({recovery:{action:'attention_refresh',token:current.request.cursor},limit:before.limit,max_response_bytes:before.max_response_bytes});await ready(page);
  const next=await page.evaluate(()=>Object.values(JSON.parse(Object.entries(localStorage).find(([k])=>k.startsWith('loom.routine-updates-pages:'))![1]))[0] as any),after=await api(page,'/api/v1/me/routine-updates/query',next.request);
  expect(after.traversal.id).toBe(before.traversal.id);expect(after.traversal.shared).toEqual(before.traversal.shared);expect(after.traversal.personal).toEqual(before.traversal.personal);expect(after.attention.policy_version).toBeGreaterThan(before.attention.policy_version);
  const detail=page.locator('.updates-list details').filter({has:page.getByText('Attention controls',{exact:true})});if(await detail.getAttribute('open')===null)await detail.getByText('Attention controls',{exact:true}).click();
  await page.getByRole('button',{name:'Dismiss this update'}).click();await expect(page.getByRole('button',{name:'Confirm dismissal'})).toBeVisible();
});

test('a mute committed after same-owner navigation notifies the newly mounted Updates view',async({page,context,server})=>{
  const f=await setup(page,context,server);await follow(page,f.target.resource_id);await open(page);
  const entered=barrier(),release=barrier();
  // Hold dispatch, not its already committed response, so the replacement view
  // really loads the old policy before the original control completes.
  await page.route('**'+endpoint+'/mutes/state',async route=>{entered.release();await release.promise;const response=await route.fetch();await route.fulfill({response});});
  try{
    await page.getByRole('button',{name:'Mute routine updates',exact:true}).click();await entered.promise;
    await page.getByRole('link',{name:'Attention settings',exact:true}).first().click();await expect(page.getByRole('heading',{name:'Attention settings',exact:true})).toBeVisible();
    await page.getByRole('link',{name:'Updates',exact:true}).click();await ready(page);await page.getByText('Attention controls',{exact:true}).click();
    await expect(page.getByRole('heading',{name:'Target R1'})).toBeVisible();await expect(page.getByText(/Attention choices changed/)).toHaveCount(0);
    release.release();await expect.poll(()=>intents(page)).toEqual([]);await expect(page.getByText(/Attention choices changed/)).toBeVisible();
    await expect(page.getByRole('button',{name:'Unmute routine updates'})).toHaveAttribute('aria-disabled','false');
    await page.getByRole('button',{name:'Refresh attention selection',exact:true}).click();await ready(page);await expect(page.locator('.updates-list > li')).toHaveCount(0);
    expect((await server.observer.query('SELECT muted,version FROM loom.attention_mutes WHERE participant_id=$1',[f.person])).rows).toEqual([{muted:true,version:1}]);
  }finally{release.release();await page.unrouteAll({behavior:'wait'});}
});

test('prior saved Updates views keep their original contract and captured scope alongside new routine custody',async({page,context,server})=>{
  const f=await setup(page,context,server);await follow(page,f.target.resource_id);
  await page.goto(server.origin+'/loom/updates?contract=legacy');await ready(page);await expect(page.locator('.updates-list > li')).toHaveCount(1);
  const legacy=await page.evaluate(()=>Object.entries(localStorage).filter(([k])=>k.startsWith('loom.updates-pages:')).map(([k,v])=>({key:k,value:JSON.parse(v)})));
  await api(page,'/api/v1/me/following/private/state',{target:{kind:'artifact',resource_id:f.target.resource_id},include_descendants:false,preferences:['artifact_revisions'],following:false,expected_version:1,idempotency_key:randomUUID()});
  await page.getByRole('link',{name:'Open routine Updates with attention controls'}).click();
  await expect(page.getByText('Counts describe remaining routine inputs.',{exact:true})).toBeVisible();await ready(page);
  await expect(page.getByText('Nothing in this routine view. Complete / all retained updates remain available.',{exact:true})).toBeVisible();
  await expect(page.locator('.updates-list > li')).toHaveCount(0);
  expect(await page.evaluate(()=>Object.keys(localStorage).some(k=>k.startsWith('loom.routine-updates-pages:')))).toBe(true);
  await page.getByRole('link',{name:'Open prior saved Updates views'}).click();
  await expect(page.getByText('Counts describe remaining routine inputs.',{exact:true})).toHaveCount(0);await ready(page);await expect(page.locator('.updates-list > li')).toHaveCount(1);
  const current=await page.evaluate(key=>JSON.parse(localStorage.getItem(key)!),legacy[0]!.key),old=Object.values(legacy[0]!.value)[0] as any,now=Object.values(current)[0] as any;
  expect(now.request.limit).toBe(old.request.limit);await expect(page.getByText(/earlier Following settings/)).toBeVisible();
  await page.getByRole('button',{name:'Inspect changes',exact:true}).click();await expect(page.getByRole('link',{name:'Exact revision 1',exact:true})).toHaveAttribute('href',`/loom/resource/${f.target.resource_id}/${f.target.revision_id}`);
});

test('exact dismissal and keyboard Undo preserve focus, viewport, mute independence and complete history at desktop and narrow widths',async({page,context,server},info)=>{
  const f=await setup(page,context,server);await follow(page,f.target.resource_id);await open(page);
  const bounds=(await server.observer.query('SELECT shared_position FROM loom.community_clocks')).rows;
  const dismiss=page.getByRole('button',{name:'Dismiss this update'});await dismiss.focus();await page.keyboard.press('Enter');
  await expect(page.getByText(/1 shared event and 0 personal signals/)).toBeVisible();
  const confirm=page.getByRole('button',{name:'Confirm dismissal'});await confirm.focus();const scroll=await page.evaluate(()=>scrollY);await page.keyboard.press('Enter');
  const undo=page.getByRole('button',{name:'Undo dismissal / restore these inputs'});await expect(undo).toBeFocused();expect(Math.abs(await page.evaluate(()=>scrollY)-scroll)).toBeLessThan(3);
  await expect(page.locator('.updates-list > li')).toHaveCount(1);expect((await intents(page)).length).toBe(0);
  await page.getByRole('button',{name:'Mute routine updates',exact:true}).click();await expect(page.getByRole('button',{name:'Unmute routine updates'})).toHaveAttribute('aria-disabled','false');
  await undo.focus();const restoreScroll=await page.evaluate(()=>scrollY);await page.keyboard.press('Enter');await expect(page.getByText(/Restoration saved. Independent mutes still apply/)).toBeVisible();await expect(dismiss).toBeFocused();
  expect(Math.abs(await page.evaluate(()=>scrollY)-restoreScroll)).toBeLessThan(3);
  for(const [name,width,height] of [['desktop',1440,1000],['narrow',390,844]] as const){
    await page.setViewportSize({width,height});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    if(process.env.LOOM_ATTENTION_REVIEW_SCREENS==='1'){await mkdir('docs/development/evidence/attention',{recursive:true});const path=info.outputPath('attention-'+name+'.png');await page.screenshot({path,fullPage:true});await copyFile(path,'docs/development/evidence/attention/attention-'+name+'.png');}
  }
  await page.getByRole('button',{name:'Refresh attention selection',exact:true}).click();await ready(page);await expect(page.getByText(/Nothing in this routine view/)).toBeVisible();
  await page.getByRole('button',{name:'Show all matching groups in this interval'}).click();await ready(page);await expect(page.locator('.updates-list > li')).toHaveCount(1);
  await page.getByRole('button',{name:'Inspect changes',exact:true}).click();await expect(page.getByRole('link',{name:'Exact revision 1',exact:true})).toHaveAttribute('href',`/loom/resource/${f.target.resource_id}/${f.target.revision_id}`);
  expect((await server.observer.query('SELECT shared_position FROM loom.community_clocks')).rows).toEqual(bounds);
  expect((await server.observer.query('SELECT dismissed,version FROM loom.attention_dismissals WHERE participant_id=$1',[f.person])).rows).toEqual([{dismissed:false,version:2}]);
  expect((await server.observer.query('SELECT muted,version FROM loom.attention_mutes WHERE participant_id=$1',[f.person])).rows).toEqual([{muted:true,version:1}]);
  expect((await server.observer.query('SELECT count(*)::int n FROM loom.reading_states')).rows[0].n).toBe(0);
});

test('switching a mounted card to Complete during preparation allows a fresh explicit selection',async({page,context,server})=>{
  const f=await setup(page,context,server);await follow(page,f.target.resource_id);await open(page);
  const entered=barrier(),release=barrier(),requests:any[]=[];
  await page.route('**/api/v1/me/routine-updates/selection',async route=>{
    requests.push(route.request().postDataJSON());const response=await route.fetch();
    if(requests.length===1){entered.release();await release.promise;}await route.fulfill({response});
  });
  try{
    await page.getByRole('button',{name:'Dismiss this update'}).click();await entered.promise;
    await page.getByRole('button',{name:'Show all matching groups in this interval'}).click();await ready(page);
    release.release();await page.unrouteAll({behavior:'wait'});
    await expect(page.getByRole('button',{name:'Confirm dismissal'})).toHaveCount(0);
    const dismiss=page.getByRole('button',{name:'Dismiss this update'});await expect(dismiss).toHaveAttribute('aria-disabled','false');
    const fresh=page.waitForRequest(r=>r.url().endsWith('/routine-updates/selection'));
    await dismiss.click();const command=(await fresh).postDataJSON();expect(command.group_id).toBe(requests[0].group_id);expect(command.cursor).not.toBe(requests[0].cursor);
    await expect(page.getByRole('button',{name:'Confirm dismissal'})).toBeVisible();expect(await intents(page)).toEqual([]);
    expect((await server.observer.query('SELECT count(*)::int n FROM loom.attention_operations')).rows[0].n).toBe(0);
  }finally{release.release();}
});

test('successful Undo permits another keyboard dismissal with a fresh selection and version on the same card',async({page,context,server})=>{
  const f=await setup(page,context,server);await follow(page,f.target.resource_id);await open(page);
  await page.getByRole('button',{name:'Show all matching groups in this interval'}).click();await ready(page);
  const commands:any[]=[];page.on('request',r=>{if(r.url().endsWith(endpoint+'/dismissals/state'))commands.push(r.postDataJSON());});
  await page.getByRole('button',{name:'Dismiss this update'}).click();await page.getByRole('button',{name:'Confirm dismissal'}).click();
  const undo=page.getByRole('button',{name:'Undo dismissal / restore these inputs'});await expect(undo).toHaveAttribute('aria-disabled','false');
  await undo.focus();await page.keyboard.press('Enter');
  const dismiss=page.getByRole('button',{name:'Dismiss this update'});await expect(dismiss).toBeFocused();await expect(dismiss).toHaveAttribute('aria-disabled','false');
  expect(commands).toHaveLength(2);await page.keyboard.press('Enter');
  const confirm=page.getByRole('button',{name:'Confirm dismissal'});await confirm.focus();await page.keyboard.press('Enter');await expect(undo).toBeFocused();
  expect(commands).toHaveLength(3);expect(new Set(commands.map(c=>c.idempotency_key)).size).toBe(3);
  expect(commands.map(c=>c.inputs[0].expected_version)).toEqual([0,1,2]);expect(commands.map(c=>c.inputs[0].dismissed)).toEqual([true,false,true]);
  expect(new Set(commands.map(c=>c.inputs[0].id)).size).toBe(1);expect(await intents(page)).toEqual([]);
  expect((await server.observer.query('SELECT dismissed,version FROM loom.attention_dismissals WHERE participant_id=$1',[f.person])).rows).toEqual([{dismissed:true,version:3}]);
});

test('a mute authority refusal withdraws cached source details and retains the exact refused command',async({page,context,server})=>{
  const f=await setup(page,context,server);await follow(page,f.target.resource_id);await open(page);
  const control=page.locator(`[data-mute-target="artifact:${f.target.resource_id}"]`),button=control.getByRole('button',{name:'Mute routine updates',exact:true}),entered=barrier(),release=barrier();
  await expect(button).toHaveAttribute('aria-disabled','false');await expect(control.getByText(/Target R1/)).toBeVisible();
  await page.route('**/api/v1/me/routine-updates/members',async route=>{const response=await route.fetch();entered.release();await release.promise;await route.fulfill({response});});
  try{
    await page.getByRole('button',{name:'Inspect changes',exact:true}).click();await entered.promise;
    await server.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='suppressed' WHERE id=$1",[f.target.resource_id]));
    const sent=page.waitForRequest(r=>r.url().endsWith(endpoint+'/mutes/state'));await button.click();const command=(await sent).postDataJSON();
    await expect(page.locator('.updates-list > li')).toHaveCount(0);await expect(control).toHaveCount(0);await expect(page.getByRole('alert')).toBeFocused();
    await expect.poll(async()=>(await intents(page))[0]?.state).toBe('rejected');expect((await intents(page))[0].command.body).toEqual(command);
    release.release();await page.unrouteAll({behavior:'wait'});
    await expect(page.getByRole('complementary',{name:'Expanded changes'})).toHaveCount(0);await expect(page.getByRole('heading',{name:'Target R1'})).toHaveCount(0);
    expect((await server.observer.query('SELECT count(*)::int n FROM loom.attention_operations')).rows[0].n).toBe(0);
    await server.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='active' WHERE id=$1",[f.target.resource_id]));
    await page.getByRole('button',{name:'Retry Updates'}).click();await page.getByRole('button',{name:'Replay both retained streams'}).click();await ready(page);
    await page.getByText('Attention controls',{exact:true}).click();await expect(control.getByText(/Target R1/)).toBeVisible();
    expect((await intents(page))[0].command.body).toEqual(command);await expect(button).toHaveAttribute('aria-disabled','true');
    await expect(control.getByText(/Attention change was refused/)).toBeVisible();
  }finally{release.release();await page.unrouteAll({behavior:'wait'});}
});

test('a delayed mute decision cannot restore metadata withdrawn by a newer lookup',async({page,context,server})=>{
  const f=await setup(page,context,server);await follow(page,f.target.resource_id);await open(page);
  const control=page.locator(`[data-mute-target="artifact:${f.target.resource_id}"]`),entered=barrier(),release=barrier();
  await expect(control.getByRole('button',{name:'Mute routine updates',exact:true})).toHaveAttribute('aria-disabled','false');
  await overlappingLookups({page,id:f.target.resource_id,path:previews,
    start:()=>control.getByRole('button',{name:'Refresh mute state'}).click(),
    suppress:async()=>{await server.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='suppressed' WHERE id=$1",[f.target.resource_id]));},
    withdrawn:async()=>{await expect(page.locator('.updates-list > li')).toHaveCount(0);await expect(control).toHaveCount(0);}});
  await server.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='active' WHERE id=$1",[f.target.resource_id]));
  await page.getByRole('button',{name:'Retry Updates'}).click();await page.getByRole('button',{name:'Replay both retained streams'}).click();await ready(page);
  await page.getByText('Attention controls',{exact:true}).click();
  await expect(control.getByRole('button',{name:'Mute routine updates',exact:true})).toHaveAttribute('aria-disabled','false');
  await page.route('**'+endpoint+'/mutes/state',async route=>{const response=await route.fetch();entered.release();await release.promise;await route.fulfill({response});});
  try{
    await control.getByRole('button',{name:'Mute routine updates',exact:true}).click();await entered.promise;
    await server.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='suppressed' WHERE id=$1",[f.target.resource_id]));
    await control.getByRole('button',{name:'Refresh mute state'}).click();
    await expect(page.locator('.updates-list > li')).toHaveCount(0);await expect(control).toHaveCount(0);
    release.release();await expect.poll(()=>intents(page)).toEqual([]);
    await expect(page.getByRole('heading',{name:'Target R1'})).toHaveCount(0);
    expect((await server.observer.query('SELECT muted,version FROM loom.attention_mutes WHERE participant_id=$1',[f.person])).rows).toEqual([{muted:true,version:1}]);
    await page.getByRole('link',{name:'Attention settings',exact:true}).first().click();
    await expect(control.getByRole('button',{name:'Unmute routine updates'})).toHaveAttribute('aria-disabled','false');
    await expect(control.getByText(/Current source unavailable/)).toBeVisible();await expect(control.getByText(/Target R1/)).toHaveCount(0);
  }finally{release.release();await page.unrouteAll({behavior:'wait'});}
});

test('a delayed settings list requires a fresh source lookup after metadata withdrawal',async({page,context,server})=>{
  const f=await setup(page,context,server);
  await api(page,endpoint+'/mutes/state',{idempotency_key:randomUUID(),target:{kind:'artifact',resource_id:f.target.resource_id},include_descendants:false,muted:true,expected_version:0});
  await page.getByRole('link',{name:'Attention settings',exact:true}).click();
  const control=page.locator(`[data-mute-target="artifact:${f.target.resource_id}"]`),entered=barrier(),release=barrier(),lookupEntered=barrier(),lookupRelease=barrier();
  await expect(control.getByText(/Target R1/)).toBeVisible();
  await page.route('**'+endpoint+'/list',async route=>{const response=await route.fetch();entered.release();await release.promise;await route.fulfill({response});});
  try{
    await page.getByRole('button',{name:'Refresh attention settings'}).click();await entered.promise;
    await server.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='suppressed' WHERE id=$1",[f.target.resource_id]));
    await control.getByRole('button',{name:'Refresh mute state'}).click();await expect(control.getByText(/Current source unavailable/)).toBeVisible();
    await page.route('**'+endpoint+'/mutes/lookup',async route=>{const response=await route.fetch();lookupEntered.release();await lookupRelease.promise;await route.fulfill({response});});
    const oldResponse=page.waitForResponse(r=>r.url().endsWith(endpoint+'/list'));
    release.release();await (await oldResponse).finished();
    await expect(control.getByText(/Target R1/)).toHaveCount(0);
    // A pending private list retains settings without requesting metadata. Only an
    // explicit protected refresh may authorize another preview after withdrawal.
    await control.getByRole('button',{name:'Refresh mute state'}).click();await lookupEntered.promise;
    await expect(control.getByText(/Target R1/)).toHaveCount(0);
    lookupRelease.release();await expect(control.getByRole('button',{name:'Unmute routine updates'})).toHaveAttribute('aria-disabled','false');
    await expect(control.getByText(/Target R1/)).toHaveCount(0);
  }finally{release.release();lookupRelease.release();await page.unrouteAll({behavior:'wait'});}
});

test('global attention recovery withdraws settings on credential revocation and rejects an older list',async({page,context,server})=>{
  const f=await setup(page,context,server);
  await api(page,endpoint+'/mutes/state',{idempotency_key:randomUUID(),target:{kind:'artifact',resource_id:f.target.resource_id},include_descendants:false,muted:true,expected_version:0});
  await page.getByRole('link',{name:'Attention settings',exact:true}).click();
  await expect(page.getByText(/Routine artifact updates · Target R1/)).toBeVisible();
  await page.route('**'+endpoint+'/mutes/state',route=>route.abort('failed'));
  await page.getByRole('button',{name:'Unmute routine updates'}).click();await expect(page.getByText(/Attention outcome is unconfirmed/).first()).toBeVisible();
  const saved=(await intents(page))[0];await page.unrouteAll({behavior:'wait'});
  const entered=barrier(),release=barrier();
  await page.route('**'+endpoint+'/list',async route=>{const response=await route.fetch();entered.release();await release.promise;await route.fulfill({response});});
  try{
    await page.getByRole('button',{name:'Refresh attention settings'}).click();await entered.promise;
    await server.database.transaction(tx=>tx.query("UPDATE loom.participant_credentials SET state='revoked' WHERE participant_id=$1",[f.person]));
    const summary=page.getByText('Attention recovery (1)',{exact:true});await summary.click();
    await summary.locator('..').getByRole('button',{name:'Check attention outcome'}).click();
    await expect(page.getByText(/Routine artifact updates · Target R1/)).toHaveCount(0);
    const old=page.waitForResponse(r=>r.url().endsWith(endpoint+'/list'));release.release();await (await old).finished();
    await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
    await expect(page.locator('[data-mute-target]')).toHaveCount(0);
    expect((await intents(page))[0].command).toEqual(saved.command);expect((await intents(page))[0].state).toBe('uncertain');
  }finally{release.release();await page.unrouteAll({behavior:'wait'});}
});

test('an overlapping new traversal recovers the original subset and can dismiss its remaining input after refresh',async({page,context,server})=>{
  const f=await setup(page,context,server);await follow(page,f.target.resource_id);await open(page);
  await page.getByRole('button',{name:'Dismiss this update'}).click();await expect(page.getByRole('button',{name:'Confirm dismissal'})).toBeVisible();
  await page.route('**'+endpoint+'/dismissals/state',route=>route.abort('failed'));
  await page.getByRole('button',{name:'Confirm dismissal'}).click();await expect(page.getByText(/Attention outcome is unconfirmed/)).toBeVisible();
  const saved=(await intents(page))[0];await page.unrouteAll({behavior:'wait'});
  const revision=await f.admin.call('/api/v1/revisions',{idempotency_key:randomUUID(),resource_id:f.target.resource_id,expected_revision_id:f.target.revision_id,title:'Target R2',content:plain('Later independently eligible')});expect(revision.status).toBe(201);
  await page.getByRole('button',{name:'Refresh scope from retained history'}).click();await ready(page);await page.getByText('Attention controls',{exact:true}).click();
  expect(await page.locator('[data-dismiss-group]').getAttribute('data-dismiss-group')).not.toBe(saved.command.group_id);
  await page.getByRole('button',{name:'Dismiss this update'}).click();
  await expect(page.getByRole('button',{name:'Check attention outcome'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Confirm dismissal'})).toHaveAttribute('aria-disabled','true');
  await expect(page.getByText(/2 shared events and 0 personal signals/)).toBeVisible();
  const retry=page.waitForRequest(r=>r.url().endsWith(endpoint+'/dismissals/state'));
  await page.getByRole('button',{name:'Retry same attention change'}).click();expect((await retry).postDataJSON()).toEqual(saved.command.body);
  await expect(page.getByRole('button',{name:'Undo dismissal / restore these inputs'})).toBeVisible();expect(await intents(page)).toEqual([]);
  expect((await server.observer.query('SELECT input_id,dismissed,version FROM loom.attention_dismissals WHERE participant_id=$1',[f.person])).rows).toEqual([{input_id:saved.command.body.inputs[0].id,dismissed:true,version:1}]);
  const current=await page.evaluate(()=>Object.values(JSON.parse(Object.entries(localStorage).find(([k])=>k.startsWith('loom.routine-updates-pages:'))![1]))[0] as any);
  // Another client can complete the shared projection before this tab refreshes.
  // The ready response then preserves the mounted card and its old Undo receipt.
  let refreshed=await api(page,'/api/v1/me/routine-updates/query',{recovery:{action:'attention_refresh',token:current.request.cursor}});
  for(let i=0;refreshed.stage==='preparing'&&i<12;i++)refreshed=await api(page,'/api/v1/me/routine-updates/query',{cursor:refreshed.next_cursor});
  expect(refreshed.stage).toBe('ready');expect(refreshed.items[0].counts.shared_changes).toBe(1);
  await page.getByRole('button',{name:'Refresh attention selection',exact:true}).click();await ready(page);
  await expect(page.getByRole('button',{name:'Undo dismissal / restore these inputs'})).toBeVisible();
  await page.getByRole('button',{name:'Dismiss this update'}).click();await expect(page.getByText(/1 shared event and 0 personal signals/)).toBeVisible();
  const fresh=page.waitForRequest(r=>r.url().endsWith(endpoint+'/dismissals/state'));await page.getByRole('button',{name:'Confirm dismissal'}).click();const next=(await fresh).postDataJSON();
  const later=(await server.observer.query('SELECT id FROM loom.shared_activity WHERE revision_id=$1',[revision.body.revision_id])).rows[0].id;
  expect(next.idempotency_key).not.toBe(saved.command.body.idempotency_key);expect(next.inputs).toEqual([{kind:'shared_event',id:later,dismissed:true,expected_version:0}]);
  await expect.poll(()=>intents(page)).toEqual([]);
  expect((await server.observer.query('SELECT input_id,dismissed,version FROM loom.attention_dismissals WHERE participant_id=$1 ORDER BY input_id',[f.person])).rows)
    .toEqual([saved.command.body.inputs[0].id,later].sort().map(input_id=>({input_id,dismissed:true,version:1})));
});

test('an older ready page cannot acknowledge a mute committed while its response is delayed',async({page,context,server})=>{
  const f=await setup(page,context,server);await follow(page,f.target.resource_id);await open(page);
  const entered=barrier(),release=barrier();let before:any;
  await page.route('**/api/v1/me/routine-updates/query',async route=>{const response=await route.fetch();before=await response.json();entered.release();await release.promise;await route.fulfill({response});});
  try{
    await page.evaluate(()=>window.dispatchEvent(new Event('loom-attention-policy')));
    await page.getByRole('button',{name:'Refresh attention selection',exact:true}).click();await entered.promise;expect(before.stage).toBe('ready');
    await page.getByRole('button',{name:'Mute routine updates',exact:true}).click();await expect(page.getByRole('button',{name:'Unmute routine updates'})).toHaveAttribute('aria-disabled','false');
    const old=page.waitForResponse(r=>r.url().endsWith('/routine-updates/query'));release.release();await (await old).finished();await page.unrouteAll({behavior:'wait'});
    await expect(page.getByRole('button',{name:'Refresh scope from retained history'})).toHaveAttribute('aria-disabled','false');
    await expect(page.getByText(/Attention choices changed/)).toBeVisible();await expect(page.getByRole('heading',{name:'Target R1'})).toBeVisible();
    await page.getByRole('button',{name:'Refresh attention selection',exact:true}).click();await ready(page);
    await expect(page.locator('.updates-list > li')).toHaveCount(0);await expect(page.getByText(/Attention choices changed/)).toHaveCount(0);
    const current=await page.evaluate(()=>Object.values(JSON.parse(Object.entries(localStorage).find(([k])=>k.startsWith('loom.routine-updates-pages:'))![1]))[0] as any);
    const after=await api(page,'/api/v1/me/routine-updates/query',current.request);
    expect(after.traversal.id).toBe(before.traversal.id);expect(after.traversal.shared).toEqual(before.traversal.shared);expect(after.traversal.personal).toEqual(before.traversal.personal);
    expect(after.attention.policy_version).toBeGreaterThan(before.attention.policy_version);
  }finally{release.release();await page.unrouteAll({behavior:'wait'});}
});

test('failed durable save prevents dispatch; lost COMMIT response and reload retain a frozen command while a later revision stays eligible',async({page,context,server})=>{
  const f=await setup(page,context,server);await follow(page,f.target.resource_id);await open(page);
  await page.getByRole('button',{name:'Dismiss this update'}).click();await expect(page.getByRole('button',{name:'Confirm dismissal'})).toBeVisible();
  let sends=0;page.on('request',r=>{if(r.url().endsWith(endpoint+'/dismissals/state'))sends++;});
  await page.evaluate(()=>{const original=Storage.prototype.setItem;(window as any).restoreAttentionStorage=()=>Storage.prototype.setItem=original;Storage.prototype.setItem=function(k,v){if(k.startsWith('loom.attention:'))throw new Error('Synthetic storage full');return original.call(this,k,v);};});
  await page.getByRole('button',{name:'Confirm dismissal'}).click();await expect(page.getByText(/could not be saved/)).toBeVisible();expect(sends).toBe(0);await page.evaluate(()=>(window as any).restoreAttentionStorage());
  const committed=barrier();await page.route('**'+endpoint+'/dismissals/state',async route=>{await route.fetch();committed.release();await route.abort('failed');});
  await page.getByRole('button',{name:'Confirm dismissal'}).click();await committed.promise;await expect(page.getByText(/Attention outcome is unconfirmed/)).toBeVisible();
  const saved=(await intents(page))[0];expect(saved.command.body.inputs).toHaveLength(1);await page.unrouteAll({behavior:'wait'});
  const revised=await f.admin.call('/api/v1/revisions',{idempotency_key:randomUUID(),resource_id:f.target.resource_id,expected_revision_id:f.target.revision_id,title:'Target R2',content:plain('Later independently eligible')});expect(revised.status).toBe(201);
  await page.reload();await page.getByRole('navigation',{name:'Community navigation'}).getByRole('link',{name:'Attention settings',exact:true}).click();await expect(page.getByRole('heading',{name:'Attention settings'})).toBeVisible();
  await page.getByText('Attention recovery (1)',{exact:true}).click();expect((await intents(page))[0].command).toEqual(saved.command);
  let retried:any;page.on('request',r=>{if(r.url().endsWith(endpoint+'/dismissals/state'))retried=r.postDataJSON();});
  await page.getByRole('button',{name:'Retry same attention change'}).click();await expect.poll(()=>intents(page)).toEqual([]);expect(retried).toEqual(saved.command.body);
  await page.getByRole('link',{name:'Updates',exact:true}).click();await expect(page.getByRole('button',{name:'Refresh scope from retained history'})).toHaveAttribute('aria-disabled','false');await page.getByRole('button',{name:'Refresh scope from retained history'}).click();await ready(page);
  await page.getByRole('button',{name:'Inspect changes',exact:true}).click();await expect(page.getByRole('link',{name:'Exact revision 2',exact:true})).toHaveAttribute('href',`/loom/resource/${f.target.resource_id}/${revised.body.revision_id}`);
  await expect(page.getByRole('link',{name:'Exact revision 1',exact:true})).toHaveCount(0);
  expect((await server.observer.query('SELECT input_id FROM loom.attention_dismissals WHERE participant_id=$1',[f.person])).rows.map(v=>v.input_id)).toEqual(saved.command.body.inputs.map((v:any)=>v.id));
});

test('old Undo cannot replace a newer dismissal; acknowledged conflict allows a new choice on the same card',async({page,context,server})=>{
  const f=await setup(page,context,server);await follow(page,f.target.resource_id);await open(page);
  await page.getByRole('button',{name:'Show all matching groups in this interval'}).click();await ready(page);
  await page.getByRole('button',{name:'Dismiss this update'}).click();await page.getByRole('button',{name:'Confirm dismissal'}).click();
  const undo=page.getByRole('button',{name:'Undo dismissal / restore these inputs'});await expect(undo).toHaveAttribute('aria-disabled','false');
  const id=(await server.observer.query('SELECT id FROM loom.shared_activity WHERE revision_id=$1',[f.target.revision_id])).rows[0].id;
  const change=(dismissed:boolean,expected_version:number)=>api(page,endpoint+'/dismissals/state',{idempotency_key:randomUUID(),inputs:[{kind:'shared_event',id,dismissed,expected_version}]});
  await change(false,1);await change(true,2);
  await undo.click();await expect(page.getByText(/Attention change conflicted/)).toBeVisible();
  expect((await server.observer.query('SELECT dismissed,version FROM loom.attention_dismissals WHERE participant_id=$1',[f.person])).rows).toEqual([{dismissed:true,version:3}]);
  const conflict=(await intents(page))[0];expect(conflict.command.body.inputs).toEqual([{kind:'shared_event',id,dismissed:false,expected_version:1}]);
  await page.getByRole('button',{name:'Dismiss attention conflict notice'}).click();await expect.poll(()=>intents(page)).toEqual([]);
  await expect(page.getByRole('button',{name:'Dismiss this update'})).toHaveAttribute('aria-disabled','false');
  await page.getByRole('button',{name:'Dismiss this update'}).click();await page.getByRole('button',{name:'Confirm dismissal'}).click();
  await expect(page.getByText(/Dismissal saved for these exact inputs/)).toBeVisible();
  expect((await server.observer.query('SELECT dismissed,version FROM loom.attention_dismissals WHERE participant_id=$1',[f.person])).rows).toEqual([{dismissed:true,version:4}]);
});

test('active Attention settings mutes can be unmuted by keyboard on first load',async({page,context,server})=>{
  const f=await setup(page,context,server);
  await api(page,endpoint+'/mutes/state',{idempotency_key:randomUUID(),target:{kind:'artifact',resource_id:f.target.resource_id},include_descendants:false,muted:true,expected_version:0});
  await page.getByRole('link',{name:'Attention settings',exact:true}).click();
  const unmute=page.getByRole('button',{name:'Unmute routine updates'});await expect(unmute).toHaveAttribute('aria-disabled','false');
  await unmute.focus();await page.keyboard.press('Enter');await expect(page.getByRole('button',{name:'Mute routine updates',exact:true})).toHaveAttribute('aria-disabled','false');
  expect((await server.observer.query('SELECT muted,version FROM loom.attention_mutes WHERE participant_id=$1',[f.person])).rows).toEqual([{muted:false,version:2}]);
});

test('expired routine view recovers changed policy without replacing its frozen interval or Following definition',async({page,context,server})=>{
  const f=await setup(page,context,server);await follow(page,f.target.resource_id);await open(page);
  const saved=await page.evaluate(()=>Object.entries(localStorage).filter(([key])=>key.startsWith('loom.routine-updates-pages:')).map(([key,value])=>({key,records:JSON.parse(value)})));
  const key=(await server.observer.query('SELECT cursor_key FROM loom.updates_state')).rows[0].cursor_key;
  for(const entry of saved)for(const record of Object.values(entry.records) as any[])record.request.cursor=editUpdatesToken(record.request.cursor,key,b=>b.expires=0,'combined-updates-2');
  await api(page,endpoint+'/mutes/state',{idempotency_key:randomUUID(),target:{kind:'artifact',resource_id:f.target.resource_id},include_descendants:false,muted:true,expected_version:0});
  await api(page,'/api/v1/me/following/private/state',{idempotency_key:randomUUID(),target:{kind:'artifact',resource_id:f.target.resource_id},include_descendants:false,preferences:['artifact_revisions'],following:false,expected_version:1});
  const revision=await f.admin.call('/api/v1/revisions',{idempotency_key:randomUUID(),resource_id:f.target.resource_id,expected_revision_id:f.target.revision_id,title:'Later R2',content:plain('Outside the captured interval')});expect(revision.status).toBe(201);
  await page.evaluate(entries=>{for(const entry of entries)localStorage.setItem(entry.key,JSON.stringify(entry.records));},saved);
  await page.reload();await page.getByRole('button',{name:'Renew fixed Updates view'}).click();
  await page.getByRole('button',{name:'Refresh attention selection',exact:true}).click();await ready(page);
  await expect(page.getByText(/Nothing in this routine view/)).toBeVisible();await expect(page.getByText(/earlier Following settings/)).toBeVisible();
  await page.getByRole('button',{name:'Show all matching groups in this interval'}).click();await ready(page);
  await page.getByRole('button',{name:'Inspect changes',exact:true}).click();
  await expect(page.getByRole('link',{name:'Exact revision 1',exact:true})).toHaveAttribute('href',`/loom/resource/${f.target.resource_id}/${f.target.revision_id}`);
  await expect(page.getByRole('link',{name:'Exact revision 2',exact:true})).toHaveCount(0);
});

test('stale tab choice yields a retained conflict and sign-out fences a late response before real Web Lock cleanup',async({page,context,server})=>{
  const f=await setup(page,context,server);await follow(page,f.target.resource_id);await open(page);
  const stale=await context.newPage();await stale.goto(server.origin+'/loom/updates');await ready(stale);await stale.getByText('Attention controls',{exact:true}).click();
  await expect(stale.getByRole('button',{name:'Mute routine updates',exact:true})).toHaveAttribute('aria-disabled','false');
  await page.getByRole('button',{name:'Mute routine updates',exact:true}).click();await expect(page.getByRole('button',{name:'Unmute routine updates'})).toHaveAttribute('aria-disabled','false');
  await expect.poll(()=>intents(page)).toEqual([]);await stale.getByRole('button',{name:'Mute routine updates',exact:true}).click();await expect(stale.getByText(/Attention change conflicted/)).toBeVisible();
  await stale.getByRole('button',{name:'Dismiss attention conflict notice'}).click();await expect.poll(()=>intents(stale)).toEqual([]);
  const committed=barrier(),release=barrier();await page.route('**'+endpoint+'/mutes/state',async route=>{const response=await route.fetch();committed.release();await release.promise;await route.fulfill({response});});
  try{
    await page.getByRole('button',{name:'Unmute routine updates'}).click();await committed.promise;
    const lock=await page.evaluate(async()=>{
      const key=Object.keys(localStorage).find(k=>k.startsWith('loom.attention:')&&k.includes(':intent:'))!,prefix=key.slice(0,key.indexOf('intent:'));
      localStorage.setItem('unrelated-attention-test','preserve');let unlock!:()=>void;const held=new Promise<void>(resolve=>unlock=resolve);(window as any).releaseAttentionLock=unlock;
      let acquired!:()=>void;const ready=new Promise<void>(resolve=>acquired=resolve);void navigator.locks.request(prefix,async()=>{acquired();await held;});await ready;return prefix;
    });
    await page.getByRole('button',{name:'Sign out',exact:true}).click();await expect(page.getByRole('button',{name:'Export attention recovery',exact:true})).toBeVisible();
    await page.getByRole('button',{name:'Clear local drafts and sign out',exact:true}).click();await expect(page.getByRole('heading',{name:'Welcome to the Loom'})).toBeVisible();
    release.release();await page.unrouteAll({behavior:'wait'});await page.evaluate(()=>(window as any).releaseAttentionLock());
    await expect.poll(()=>page.evaluate(prefix=>Object.keys(localStorage).filter(k=>k.startsWith(prefix)).length,lock)).toBe(0);
    expect(await page.evaluate(()=>localStorage.getItem('unrelated-attention-test'))).toBe('preserve');
    expect((await server.observer.query('SELECT muted,version FROM loom.attention_mutes WHERE participant_id=$1',[f.person])).rows).toEqual([{muted:false,version:2}]);
    await expect(stale.getByRole('heading',{name:'Welcome to the Loom'})).toBeVisible();
  }finally{release.release();await page.evaluate(()=>(window as any).releaseAttentionLock?.()).catch(()=>{});}
});

test('settings reauthorization cannot exempt a later source withdrawal from clearing sibling previews',async({page,context,server})=>{
  const f=await setup(page,context,server);
  const other=(await f.admin.call('/api/v1/artifacts',{idempotency_key:randomUUID(),area_id:f.area,title:'Sibling protected title',content:plain('Sibling private context')})).body;
  const targets=[{kind:'artifact',resource_id:f.target.resource_id},{kind:'artifact',resource_id:other.resource_id}];
  for(const target of targets)await api(page,endpoint+'/mutes/state',{idempotency_key:randomUUID(),target,muted:true,include_descendants:false,expected_version:0});
  await server.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='suppressed' WHERE id=$1",[f.area]));
  await page.goto(server.origin+'/loom/attention');
  for(const target of targets)await expect(page.locator(`[data-mute-target="artifact:${target.resource_id}"]`).getByRole('button',{name:'Unmute routine updates'})).toHaveAttribute('aria-disabled','false');
  const first=page.locator(`[data-mute-target="artifact:${f.target.resource_id}"]`);
  const sibling=page.locator(`[data-mute-target="artifact:${other.resource_id}"]`);
  const heldRead=()=>({entered:false,release:barrier(),finished:barrier()});
  let listHold:ReturnType<typeof heldRead>|undefined,lookupHold:ReturnType<typeof heldRead>|undefined,loseMutation=false;
  const holds:ReturnType<typeof heldRead>[]=[];
  // Keep interception installed until every response settles. Expiring the last
  // route between iterations races a new barrier with interception cleanup.
  const pattern='**'+endpoint+'/**';
  await page.route(pattern,async route=>{
    const path=new URL(route.request().url()).pathname;
    if(path===endpoint+'/mutes/state'&&loseMutation){loseMutation=false;await route.fetch();
      await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'service_unavailable',message:'Synthetic lost response',operation_outcome:'unknown'}})});return;}
    const held=path===endpoint+'/list'?listHold:path===endpoint+'/mutes/lookup'?lookupHold:undefined;
    if(!held){await route.fallback();return;}
    if(path===endpoint+'/list')listHold=undefined;else lookupHold=undefined;
    try{const response=await route.fetch();held.entered=true;await held.release.promise;await route.fulfill({response});}
    finally{held.finished.release();}
  });
  try{
  for(const path of ['lookup','mutation','status','retry'] as const){
    await server.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='active' WHERE id=$1",[f.area]));
    const current=await api(page,endpoint+'/mutes/lookup',targets[0]);
    if(!current.muted)await api(page,endpoint+'/mutes/state',{idempotency_key:randomUUID(),target:targets[0],muted:true,include_descendants:false,expected_version:current.version});
    for(const control of [first,sibling]){
      await control.getByRole('button',{name:'Refresh mute state'}).click();
      await expect(control.getByText(control===first?/Target R1/:/Sibling protected title/)).toBeVisible();
      await expect(control.getByRole('button',{name:'Unmute routine updates'})).toHaveAttribute('aria-disabled','false');
    }
    if(path==='status'||path==='retry'){
      loseMutation=true;
      await first.getByRole('button',{name:'Unmute routine updates'}).click();
      await expect(first.getByRole('button',{name:'Check attention outcome'})).toBeVisible();
    }
    const list=heldRead(),lookup=heldRead();holds.push(list,lookup);listHold=list;
    try{
      await page.getByRole('button',{name:'Refresh attention settings',exact:true}).click();await expect.poll(()=>list.entered).toBe(true);
      lookupHold=lookup;
      await sibling.getByRole('button',{name:'Refresh mute state'}).click();await expect.poll(()=>lookup.entered).toBe(true);
      await server.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='suppressed' WHERE id=$1",[f.area]));
      expect((await api(page,previews,{targets:[targets[1]]})).items[0].source).toEqual({state:'unavailable'});
      await first.getByRole('button',{name:path==='lookup'?'Refresh mute state':path==='mutation'?'Unmute routine updates':path==='status'?'Check attention outcome':'Retry same attention change'}).click();
      if(path!=='lookup')await first.getByRole('button',{name:'Refresh mute state'}).click();
      await expect(first.getByText(/Target R1/)).toHaveCount(0);await expect(sibling.getByText(/Sibling protected title/)).toHaveCount(0);
      list.release.release();lookup.release.release();await Promise.all([list.finished.promise,lookup.finished.promise]);
      await expect(first.getByText(/Target R1/)).toHaveCount(0);await expect(sibling.getByText(/Sibling protected title/)).toHaveCount(0);
      await expect.poll(()=>intents(page)).toEqual([]);
      await expect(page.getByRole('button',{name:'Refresh attention settings',exact:true})).toHaveAttribute('aria-disabled','false');
    }finally{list.release.release();lookup.release.release();}
  }
  }finally{for(const held of holds)held.release.release();await page.unrouteAll({behavior:'wait'});}
  await expect(sibling.getByRole('button',{name:'Unmute routine updates'})).toHaveAttribute('aria-disabled','false');
  await sibling.getByRole('button',{name:'Unmute routine updates'}).click();
  await expect(sibling.getByRole('button',{name:'Mute routine updates'})).toHaveAttribute('aria-disabled','false');
  expect((await api(page,endpoint+'/mutes/lookup',targets[1])).muted).toBe(false);
});
