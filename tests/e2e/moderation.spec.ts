import {test,expect} from '../helpers/browser-fixtures.js';
import type {Page,BrowserContext} from '@playwright/test';
import {randomUUID} from 'node:crypto';
import {mkdir} from 'node:fs/promises';
import type {syntheticServer} from '../helpers/participation-server.js';
const base='/api/v1/admin/moderation';
const text=(text:string)=>({format:'loom-markdown-v1',text,mentions:[]});
function barrier(){let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};}
async function api(page:Page,path:string,body?:unknown){
  const self=await(await page.request.get(new URL('/api/v1/identity/self',page.url()).href)).json();
  const r=body===undefined?await page.request.get(new URL(path,page.url()).href):await page.request.post(new URL(path,page.url()).href,{data:body,headers:{origin:new URL(page.url()).origin,'x-loom-csrf':self.csrf}});
  expect(r.ok()).toBe(true);return r.json();
}
async function setup(page:Page,context:BrowserContext,server:Awaited<ReturnType<typeof syntheticServer>>){
  const cdp=await context.newCDPSession(page);await cdp.send('WebAuthn.enable');await cdp.send('WebAuthn.addVirtualAuthenticator',{options:{protocol:'ctap2',transport:'internal',hasResidentKey:true,hasUserVerification:true,isUserVerified:true,automaticPresenceSimulation:true}});
  await page.goto(server.origin+'/loom');await page.getByText('Set up an admitted account',{exact:true}).click();await page.getByLabel('Enrollment ticket',{exact:true}).fill(server.ticket);
  await page.getByRole('button',{name:'Create passkey',exact:true}).click();await expect(page.getByText('Your passkey is ready. Sign in to continue.')).toBeVisible();
  await page.getByRole('button',{name:'Sign in with passkey'}).click();await expect(page.getByRole('heading',{name:'Set up your community',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Create community',exact:true}).click();await expect(page.getByRole('heading',{name:'Topics',exact:true})).toBeVisible();await page.getByRole('link',{name:'Administration',exact:true}).click();await expect(page.getByText('Community configuration',{exact:true})).toBeVisible();
  const area=(await api(page,'/api/v1/areas')).items.find((r:any)=>r.title==='General').id;
  const opening=await api(page,'/api/v1/discussions',{idempotency_key:randomUUID(),area_id:area,title:'Moderation discussion',content:text('Opening to preserve')});
  const discussion=(await api(page,'/api/v1/resources/'+opening.resource_id)).discussion_id;
  const comment=await api(page,'/api/v1/replies',{idempotency_key:randomUUID(),discussion_id:discussion,parent_id:opening.resource_id,content:text('Comment to withhold')});
  const reply=await api(page,'/api/v1/replies',{idempotency_key:randomUUID(),discussion_id:discussion,parent_id:comment.resource_id,content:text('Independent reply')});
  const artifact=await api(page,'/api/v1/artifacts',{idempotency_key:randomUUID(),area_id:area,title:'Moderation artifact',content:text('Artifact text')});
  return {opening,discussion,comment,reply,artifact};
}
async function records(page:Page){return page.evaluate(()=>Object.keys(localStorage).filter(k=>k.startsWith('loom.intent.')).map(k=>JSON.parse(localStorage.getItem(k)!)).filter(r=>r.kind==='moderation.set'));}
const row=(page:Page,id:string)=>page.locator('.moderation-target').filter({hasText:id}).first();
async function change(page:Page,id:string,suppressed:boolean){
  const current=await api(page,base+'/resources/'+id);
  return api(page,base+'/state',{idempotency_key:randomUUID(),target:current.target,suppressed,expected_version:current.version});
}
async function choose(page:Page,id:string,action:'Suppress'|'Restore'){
  await row(page,id).getByRole('button',{name:new RegExp('^'+action+' ')}).click();
  await page.getByRole('button',{name:action==='Suppress'?'Confirm suppression':'Confirm restoration',exact:true}).click();
  await expect(page.getByText('Moderation decision recorded.',{exact:false})).toBeVisible();
}

test('displayed source suppression, independent restoration, keyboard cancellation and narrow management',async({page,context,server})=>{
  const d=await setup(page,context,server);
  await page.goto(server.origin+'/loom/discussion/'+d.discussion);
  await expect(page.getByText('Comment to withhold',{exact:true})).toBeVisible();
  await page.getByRole('link',{name:'Suppress comment',exact:true}).first().click();
  const button=row(page,d.comment.resource_id).getByRole('button',{name:'Suppress comment',exact:true});
  await button.focus();await page.keyboard.press('Enter');await expect(page.getByRole('dialog')).toContainText('Replies remain independently eligible');
  await expect(page.getByRole('button',{name:'Cancel',exact:true})).toBeFocused();await page.keyboard.press('Escape');await expect(button).toBeFocused();
  await choose(page,d.comment.resource_id,'Suppress');
  expect((await api(page,base+'/resources/'+d.comment.resource_id)).local_state).toBe('suppressed');
  await page.goto(server.origin+'/loom/discussion/'+d.discussion);await expect(page.getByText('Comment to withhold',{exact:true})).toHaveCount(0);
  await page.goto(server.origin+'/loom/moderation?target='+d.discussion);await choose(page,d.discussion,'Suppress');
  await page.getByRole('link',{name:'Content moderation',exact:true}).click();await page.getByRole('button',{name:'Refresh control state'}).click();
  await expect(row(page,d.discussion)).toBeVisible();await choose(page,d.discussion,'Restore');
  await page.getByRole('button',{name:'Refresh control state'}).click();await expect(row(page,d.comment.resource_id)).toContainText('suppressed');
  expect((await api(page,'/api/v1/resources/'+d.opening.resource_id)).content.text).toBe('Opening to preserve');
  await page.goto(server.origin+'/loom/discussion/'+d.discussion);
  await expect(page.getByText('Comment to withhold',{exact:true})).toHaveCount(0);
  // Restore the child under a separately suppressed owner: local removal is not exposure.
  await change(page,d.discussion,true);await page.goto(server.origin+'/loom/moderation?target='+d.comment.resource_id);
  await choose(page,d.comment.resource_id,'Restore');await page.getByRole('button',{name:'Refresh control state'}).click();
  await expect(row(page,d.comment.resource_id)).toContainText('Ordinary content remains unavailable');
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  if(process.env.LOOM_MODERATION_REVIEW_SCREENS==='1'){
    await mkdir('/tmp/loom-moderation-review',{recursive:true});
    await page.screenshot({path:'/tmp/loom-moderation-review/management-mobile.png',fullPage:true});
  }
  const restore=row(page,d.discussion).getByRole('button',{name:'Restore discussion'});
  await restore.scrollIntoViewIfNeeded();const scroll=await page.evaluate(()=>scrollY);
  await restore.click();await page.keyboard.press('Escape');await expect(restore).toBeFocused();
  expect(await page.evaluate(()=>scrollY)).toBe(scroll);
});

test('lost response, reload and stale tab preserve immutable exact retry and newer restoration',async({page,context,server})=>{
  const d=await setup(page,context,server);await page.goto(server.origin+'/loom/resource/'+d.artifact.resource_id);
  await page.getByRole('link',{name:'Suppress artifact',exact:true}).click();
  const other=await context.newPage();await other.goto(page.url());await expect(row(other,d.artifact.resource_id)).toBeVisible();
  const done=barrier();let original:any;
  await page.route('**'+base+'/state',async route=>{original=route.request().postDataJSON();const response=await route.fetch();expect(response.status()).toBe(200);await route.abort('connectionfailed');done.release();});
  await row(page,d.artifact.resource_id).getByRole('button',{name:'Suppress artifact',exact:true}).click();await page.getByRole('button',{name:'Confirm suppression'}).click();await done.promise;
  await expect(page.getByRole('button',{name:'Retry exact moderation command'})).toBeVisible();
  await expect(row(other,d.artifact.resource_id).getByRole('button',{name:'Suppress artifact',exact:true})).toBeDisabled();
  await change(page,d.artifact.resource_id,false);await page.unrouteAll({behavior:'wait'});await page.reload();
  let retried:any;page.on('request',r=>{if(r.url().endsWith(base+'/state'))retried=r.postDataJSON();});
  await page.getByRole('button',{name:'Retry exact moderation command'}).click();
  await expect(page.getByText('Moderation decision recorded.',{exact:false})).toBeVisible();expect(retried).toEqual(original);
  expect((await api(page,base+'/resources/'+d.artifact.resource_id)).local_state).toBe('active');
  expect((await records(page))[0].body).toEqual(original);
  await page.getByRole('button',{name:'Refresh control state'}).click();await expect(row(page,d.artifact.resource_id)).toContainText('Local restriction: removed');
  await page.getByRole('button',{name:'Dismiss resolved command'}).click();await expect.poll(()=>records(page)).toHaveLength(0);await other.close();
});

test('reloaded recovery identifies opposite saved commands and retries only the selected exact request',async({page,context,server})=>{
  const d=await setup(page,context,server);
  await change(page,d.discussion,true);
  const original:string[]=[];
  // Neither first send reaches the server, so Retry will make the actual choice.
  await page.route('**'+base+'/state',async route=>{
    original.push(route.request().postData()!);await route.abort('connectionfailed');
  });
  await page.goto(server.origin+'/loom/moderation?target='+d.artifact.resource_id);
  await row(page,d.artifact.resource_id).getByRole('button',{name:'Suppress artifact',exact:true}).click();
  await page.getByRole('button',{name:'Confirm suppression'}).click();await expect(page.getByRole('alert')).toBeVisible();
  await page.goto(server.origin+'/loom/moderation?target='+d.discussion);
  await row(page,d.discussion).getByRole('button',{name:'Restore discussion',exact:true}).click();
  await page.getByRole('button',{name:'Confirm restoration'}).click();await expect(page.getByRole('alert')).toBeVisible();
  expect(original).toHaveLength(2);
  const saved=await records(page);
  expect(saved).toHaveLength(2);expect(saved.every((r:any)=>r.state==='uncertain')).toBe(true);
  const suppress=saved.find((r:any)=>r.body.suppressed),restore=saved.find((r:any)=>!r.body.suppressed);
  expect(suppress.body).toEqual(JSON.parse(original[0]!));expect(restore.body).toEqual(JSON.parse(original[1]!));
  const untouched=await page.evaluate(key=>localStorage.getItem(Object.keys(localStorage).find(k=>k.startsWith('loom.intent.')&&k.endsWith(key))!),suppress.key);
  expect(untouched).not.toBeNull();
  await page.unrouteAll({behavior:'wait'});
  await page.goto(server.origin+'/loom/moderation');await page.reload();
  const recovery=page.getByRole('region',{name:'Moderation recovery'});
  const suppression=recovery.getByRole('group',{name:'Suppress artifact '+d.artifact.resource_id,exact:true});
  const restoration=recovery.getByRole('group',{name:'Restore discussion '+d.discussion,exact:true});
  await expect(suppression).toBeVisible();await expect(restoration).toBeVisible();
  for(const [entry,record,label] of [[suppression,suppress,'Suppress artifact'],[restoration,restore,'Restore discussion']] as const){
    await expect(entry.getByRole('heading',{name:label,exact:true})).toBeVisible();
    await expect(entry.getByText(record.body.target.resource_id,{exact:true})).toBeVisible();
    await expect(entry.getByText('Awaiting confirmation',{exact:true})).toBeVisible();
    await entry.getByText('Recovery details',{exact:true}).click();
    await expect(entry.getByText('Expected lifecycle version '+record.body.expected_version,{exact:true})).toBeVisible();
    await expect(entry.getByText('Operation '+record.key,{exact:true})).toBeVisible();
  }
  await expect(page.getByText('Moderation discussion',{exact:true})).toHaveCount(0);
  await expect(page.getByText('Opening to preserve',{exact:true})).toHaveCount(0);
  await expect(page.getByText('Moderation artifact',{exact:true})).toHaveCount(0);
  await expect(page.getByText('Artifact text',{exact:true})).toHaveCount(0);
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  if(process.env.LOOM_MODERATION_REVIEW_SCREENS==='1'){
    await mkdir('/tmp/loom-moderation-review',{recursive:true});
    await page.screenshot({path:'/tmp/loom-moderation-review/recovery-mobile.png',fullPage:true});
  }
  // The intent-specific route must retain the same identifying context too.
  await page.goto(server.origin+'/loom/moderation?intent='+restore.key);
  await expect(restoration.getByText('Selected command · Awaiting confirmation',{exact:true})).toBeVisible();
  const retried:string[]=[];
  page.on('request',request=>{if(request.url().endsWith(base+'/state'))retried.push(request.postData()!);});
  await restoration.getByRole('button',{name:'Retry exact moderation command'}).click();
  await expect(page.getByText('Moderation decision recorded.',{exact:false})).toBeVisible();
  expect(retried).toEqual([original[1]]);
  const after=await records(page);
  expect(after).toHaveLength(2);
  expect(after.find((r:any)=>r.key===restore.key)).toMatchObject({state:'committed',body:restore.body});
  expect(await page.evaluate(key=>localStorage.getItem(Object.keys(localStorage).find(k=>k.startsWith('loom.intent.')&&k.endsWith(key))!),suppress.key)).toBe(untouched);
  await expect(suppression.getByText('Awaiting confirmation',{exact:true})).toBeVisible();
  expect((await api(page,base+'/resources/'+d.discussion)).local_state).toBe('active');
  expect((await api(page,base+'/resources/'+d.artifact.resource_id)).local_state).toBe('active');
});

test('late receipt withdraws source after navigation before a blocked journal can settle',async({page,context,server})=>{
  const d=await setup(page,context,server);await page.goto(server.origin+'/loom/moderation?target='+d.artifact.resource_id);
  const entered=barrier(),release=barrier(),finished=barrier();
  await page.route('**'+base+'/state',async route=>{
    const response=await route.fetch();entered.release();await release.promise;await route.fulfill({response});finished.release();
  });
  try {
    await row(page,d.artifact.resource_id).getByRole('button',{name:'Suppress artifact',exact:true}).click();await page.getByRole('button',{name:'Confirm suppression'}).click();await entered.promise;
    await change(page,d.artifact.resource_id,false);
    await page.getByRole('link',{name:'Artifacts',exact:true}).first().click();await page.locator(`a[href="/loom/resource/${d.artifact.resource_id}"]`).click();
    await expect(page.getByText('Artifact text',{exact:true})).toBeVisible();
    await page.evaluate(async()=>{
      const key=Object.keys(localStorage).find(k=>k.startsWith('loom.intent.'))!,record=JSON.parse(localStorage.getItem(key)!);
      const prefix=key.slice(0,-record.key.length);
      await new Promise<void>(resolve=>{void navigator.locks.request(prefix,()=>new Promise<void>(unlock=>{(window as any).moderationUnlock=unlock;resolve();}));});
    });
    release.release();await finished.promise;
    await expect(page.getByText('Artifact text',{exact:true})).toHaveCount(0);
    expect((await records(page))[0].state).toBe('uncertain');
    await page.evaluate(()=>(window as any).moderationUnlock());
    await expect.poll(async()=>(await records(page))[0].state).toBe('committed');
  }finally{release.release();await page.evaluate(()=>(window as any).moderationUnlock?.());}
});

test('role loss withdraws administrative projections while retaining exact custody; overview suppression remains recoverable',async({page,context,server})=>{
  const d=await setup(page,context,server);
  const overview=(await api(page,'/api/v1/community')).overview.resource_id;
  await page.goto(server.origin+'/loom/overview');await page.goto(server.origin+'/loom/moderation?target='+overview);await choose(page,overview,'Suppress');
  await page.reload();await page.getByRole('button',{name:'Refresh control state'}).click();await expect(row(page,overview)).toBeVisible();
  await choose(page,overview,'Restore');
  await page.goto(server.origin+'/loom/moderation?target='+d.artifact.resource_id);
  await page.route('**'+base+'/state',route=>route.abort('connectionfailed'));
  await row(page,d.artifact.resource_id).getByRole('button',{name:'Suppress artifact'}).click();await page.getByRole('button',{name:'Confirm suppression'}).click();
  await expect(page.getByRole('button',{name:'Retry exact moderation command'})).toBeVisible();
  const prior=(await records(page)).find((r:any)=>r.state==='uncertain');
  await server.database.transaction(tx=>tx.query("UPDATE loom.participants SET role='participant' WHERE id=$1",[server.administratorId]));
  await page.getByRole('button',{name:'Check moderation outcome'}).click();
  await expect(row(page,d.artifact.resource_id)).toHaveCount(0);
  expect((await records(page)).find((r:any)=>r.key===prior.key).body).toEqual(prior.body);
  await server.database.transaction(tx=>tx.query("UPDATE loom.participants SET role='administrator' WHERE id=$1",[server.administratorId]));
  await page.unrouteAll({behavior:'wait'});
  await page.getByRole('button',{name:'Retry exact moderation command'}).click();
  await expect(page.getByText('Moderation decision recorded.',{exact:false})).toBeVisible();
});

test('stale confirmation is retained as rejected; a fresh deliberate choice uses inspected versions',async({page,context,server})=>{
  const d=await setup(page,context,server);await page.goto(server.origin+'/loom/moderation?target='+d.artifact.resource_id);
  await row(page,d.artifact.resource_id).getByRole('button',{name:'Suppress artifact'}).click();
  await change(page,d.artifact.resource_id,false);
  await page.getByRole('button',{name:'Confirm suppression'}).click();await expect(page.getByRole('alert')).toContainText('lifecycle version changed');
  expect((await records(page))[0].state).toBe('rejected');
  await page.reload();await expect(page.getByText('Rejected command',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Dismiss resolved command'}).click();await choose(page,d.artifact.resource_id,'Suppress');
});

test('summary control, absent status, lost acknowledgement status and bounded audit stay separate from source content',async({page,context,server})=>{
  const d=await setup(page,context,server);
  const preparation=await api(page,'/api/v1/summary-preparations',{idempotency_key:randomUUID(),discussion_id:d.discussion,scope:'full'});
  const summary=await api(page,'/api/v1/summaries',{idempotency_key:randomUUID(),discussion_id:d.discussion,title:'Moderation summary',
    content:{format:'loom-markdown-v2',text:'Independent synthesis',mentions:[],references:[]},coverage:{preparation_id:preparation.preparation_id}});
  await page.goto(server.origin+'/loom/resource/'+summary.resource_id);
  await page.getByRole('link',{name:'Suppress summary',exact:true}).click();
  await page.route('**'+base+'/state',route=>route.abort('connectionfailed'));
  await row(page,summary.resource_id).getByRole('button',{name:'Suppress summary'}).click();await page.getByRole('button',{name:'Confirm suppression'}).click();
  await expect(page.getByRole('button',{name:'Check moderation outcome'})).toBeVisible();
  await page.getByRole('button',{name:'Check moderation outcome'}).click();await expect(page.getByRole('status')).toContainText('No recorded outcome');
  expect((await records(page))[0].state).toBe('uncertain');
  await page.unrouteAll({behavior:'wait'});
  await page.route('**'+base+'/state',async route=>{await route.fetch();await route.abort('connectionfailed');});
  await page.getByRole('button',{name:'Retry exact moderation command'}).click();await expect(page.getByRole('alert')).toBeVisible();
  await page.getByRole('button',{name:'Check moderation outcome'}).click();await expect(page.getByRole('status')).toContainText('Moderation decision recorded');
  expect((await records(page))[0].state).toBe('committed');
  for(let i=0;i<13;i++)await change(page,d.artifact.resource_id,false);
  await page.getByRole('button',{name:'Show moderation audit'}).click();
  const audit=page.getByRole('region',{name:'Moderation audit'});
  await expect(audit.locator('.moderation-target')).toHaveCount(12);
  await page.getByRole('button',{name:'Next moderation page'}).click();await expect(audit.locator('.moderation-target')).toHaveCount(2);
  await page.getByRole('button',{name:'Show suppressed targets'}).click();
  await expect(page.getByRole('region',{name:'Suppressed targets'})).toContainText('summary');
  await expect(page.getByText('Independent synthesis',{exact:true})).toHaveCount(0);
});
