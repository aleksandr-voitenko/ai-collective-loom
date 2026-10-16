import { randomUUID,randomBytes,createCipheriv,createDecipheriv } from 'node:crypto';
import { mkdir,copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test,expect } from '../helpers/browser-fixtures.js';
import { setup,api,journal } from '../helpers/change-browser.js';
import type { Page,BrowserContext } from '@playwright/test';
import type { syntheticServer } from '../helpers/participation-server.js';
import { eventPreferences } from '../../src/contracts/following.js';
import { authored } from '../helpers/references.js';
function barrier(){let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};}
const control=(page:Page,kind:string,id:string)=>page.locator(`[data-follow-target="${kind}:${id}"]`);
const recovery=(page:Page)=>page.evaluate(()=>Object.entries(localStorage).filter(([key])=>key.startsWith('loom.shared-pages:')).map(([key,value])=>({key,records:JSON.parse(value)})));
async function material(page:Page,context:BrowserContext,server:Awaited<ReturnType<typeof syntheticServer>>,extra=12){
  const f=await setup(page,context,server);
  for(let n=0;n<extra;n++)expect((await f.admin.call('/api/v1/artifacts',{idempotency_key:randomUUID(),area_id:f.area,title:'Shared work '+n,content:{format:'loom-markdown-v3',text:'Synthetic shared content',mentions:[],references:[]},change_note:n===0?{format:'loom-markdown-v2',text:'Changed this exact revision.',mentions:[],references:[]}:null,change_account:null})).status).toBe(201);
  await api(page,'/api/v1/me/following/state',{target:{kind:'area',resource_id:f.area},include_descendants:false,preferences:['artifact_revisions'],following:true,expected_version:0,idempotency_key:randomUUID()});
  return f;
}

test('Follow/edit/unfollow preserves parent and same-name child choices, unavailable removal, keyboard and narrow paths',async({page,context,server},info)=>{
  const f=await setup(page,context,server),other=(await f.admin.call('/api/v1/areas')).body.items.find((r:any)=>r.title==='Proposals').id;
  const children:string[]=[];for(const parent of [f.area,other]){const state=(await f.admin.call('/api/v1/organization/resources/'+parent)).body;
    const r=await f.admin.call('/api/v1/organization/changes',{kind:'area.create',parent_id:parent,title:'Same leaf',description:'Independent scope',expected_hierarchy_version:state.hierarchy_version,idempotency_key:randomUUID()});expect(r.status).toBe(200);children.push(r.body.outcome.resource_id);}
  await page.goto(server.origin+'/loom/following');await expect(page.getByRole('heading',{name:'No explicit follows'})).toBeVisible();
  await page.goto(server.origin+'/loom/area/'+f.area);const parent=control(page,'area',f.area);
  await expect(parent.getByRole('button',{name:'Follow',exact:true})).toBeEnabled();await parent.getByRole('button',{name:'Follow',exact:true}).focus();await page.keyboard.press('Enter');
  await expect(parent.getByRole('button',{name:'Unfollow',exact:true})).toBeEnabled();await parent.getByText('Follow settings',{exact:true}).click();await parent.getByLabel('Include subtopics').check();
  await parent.getByLabel('Opening edits').uncheck();await parent.getByRole('button',{name:'Save follow settings'}).click();await expect(parent.getByRole('button',{name:'Unfollow',exact:true})).toBeEnabled();
  for(const child of children)await api(page,'/api/v1/me/following/state',{target:{kind:'area',resource_id:child},include_descendants:false,preferences:[...eventPreferences],following:true,expected_version:0,idempotency_key:randomUUID()});
  await page.getByRole('link',{name:'Following',exact:true}).click();await expect(page.locator('.following-row')).toHaveCount(3);
  await expect(page.getByText('General › Same leaf',{exact:true})).toBeVisible();await expect(page.getByText('Proposals › Same leaf',{exact:true})).toBeVisible();await expect(page.getByText(/Including subtopics · New discussions/)).toBeVisible();
  for(const [name,width,height] of [['desktop',1440,1000],['mobile',390,844]] as const){await page.setViewportSize({width,height});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    if(process.env.LOOM_FOLLOWING_REVIEW_SCREENS==='1'){const destination=fileURLToPath(new URL('../../docs/development/evidence/following/',import.meta.url));await mkdir(destination,{recursive:true});const path=info.outputPath('following-'+name+'.png');await page.screenshot({path,fullPage:true});await copyFile(path,destination+'following-'+name+'.png');}}
  await control(page,'area',f.area).getByRole('button',{name:'Unfollow',exact:true}).click();await expect(control(page,'area',f.area).getByRole('status')).toContainText('Explicit follow removed');await page.getByRole('button',{name:'Refresh following'}).click();await expect(page.locator('.following-row')).toHaveCount(2);
  const closed=(await f.admin.call('/api/v1/organization/resources/'+f.area)).body;
  expect((await f.admin.call('/api/v1/organization/changes',{kind:'area.close',resource_id:f.area,expected_version:closed.version,expected_hierarchy_version:closed.hierarchy_version,idempotency_key:randomUUID()})).status).toBe(200);
  await page.goto(server.origin+'/loom/area/'+f.area);await control(page,'area',f.area).getByRole('button',{name:'Follow',exact:true}).click();await expect(control(page,'area',f.area).getByRole('button',{name:'Unfollow',exact:true})).toBeVisible();
  const lookupEntered=barrier(),lookupRelease=barrier();
  await page.route('**/api/v1/me/following/lookup',async route=>{
    if(route.request().postDataJSON().resource_id===children[1]!){lookupEntered.release();await lookupRelease.promise;}
    await route.continue();
  });
  try{
    await page.goto(server.origin+'/loom/following');await lookupEntered.promise;
    await expect(page.getByText('Proposals › Same leaf',{exact:true})).toBeVisible();
    await server.observer.query("UPDATE loom.resources SET state='suppressed' WHERE id=$1",[children[1]!]);lookupRelease.release();
    await expect(page.getByRole('heading',{name:'Followed target unavailable'})).toBeVisible();await expect(page.getByText('Proposals › Same leaf',{exact:true})).toHaveCount(0);
  }finally{lookupRelease.release();await page.unrouteAll({behavior:'wait'});}
  await control(page,'area',children[1]!).getByRole('button',{name:'Unfollow',exact:true}).click();await expect(control(page,'area',children[1]!).getByRole('status')).toContainText('Explicit follow removed');await page.getByRole('button',{name:'Refresh following'}).click();await expect(page.locator('.following-row')).toHaveCount(2);
  expect((await server.observer.query('SELECT count(*)::int n FROM loom.saved_items')).rows[0].n).toBe(0);
});

test('failed Following intent writes dispatch nothing; lost committed responses survive reload and stale tabs',async({page,context,server})=>{
  const f=await setup(page,context,server);await page.goto(server.origin+'/loom/resource/'+f.target.resource_id);const follow=control(page,'artifact',f.target.resource_id);await expect(follow.getByRole('button',{name:'Follow',exact:true})).toBeEnabled();
  let sent=0,lose=true;await page.route('**/api/v1/me/following/state',async route=>{sent++;if(lose){lose=false;await route.fetch();await route.abort('failed');}else await route.continue();});
  await page.evaluate(()=>{const original=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key.startsWith('loom.intent.v1:')){Storage.prototype.setItem=original;throw new DOMException('Following intent not saved','QuotaExceededError');}original.call(this,key,value);};});
  await follow.getByRole('button',{name:'Follow',exact:true}).click();await expect(follow.getByRole('alert')).toContainText('Following intent not saved');expect(sent).toBe(0);
  await follow.getByRole('button',{name:'Refresh follow state'}).click();await follow.getByRole('button',{name:'Follow',exact:true}).click();await expect(follow.getByRole('button',{name:'Check follow status'})).toBeVisible();const original=await journal(page,'following.set');expect(original.state).toBe('uncertain');
  await page.reload();await expect(control(page,'artifact',f.target.resource_id).getByRole('button',{name:'Retry same follow change'})).toBeVisible();expect((await journal(page,'following.set')).key).toBe(original.key);
  // Another legitimate client changes state while the browser still owns K1.
  await api(page,'/api/v1/me/following/state',{...original.body,following:false,expected_version:1,idempotency_key:randomUUID()});
  await control(page,'artifact',f.target.resource_id).getByRole('button',{name:'Retry same follow change'}).click();await expect(control(page,'artifact',f.target.resource_id).getByRole('status')).toContainText('newer Following state is preserved');
  expect(await journal(page,'following.set')).toBeUndefined();expect((await api(page,'/api/v1/me/following/lookup',original.body.target)).following).toBe(false);
  const second=await context.newPage();try{await second.goto(server.origin+'/loom/resource/'+f.target.resource_id);await expect(control(second,'artifact',f.target.resource_id).getByRole('button',{name:'Follow',exact:true})).toBeEnabled();
    await control(page,'artifact',f.target.resource_id).getByRole('button',{name:'Follow',exact:true}).click();await expect(control(second,'artifact',f.target.resource_id).getByRole('button',{name:'Unfollow',exact:true})).toBeEnabled();
    await control(second,'artifact',f.target.resource_id).getByRole('button',{name:'Unfollow',exact:true}).click();await expect(control(page,'artifact',f.target.resource_id).getByRole('button',{name:'Follow',exact:true})).toBeEnabled();
  }finally{await second.close();}
});

test('Following refresh adopts another client settings and saves from their current version',async({page,context,server})=>{
  const f=await material(page,context,server,0);
  await page.goto(server.origin+'/loom/following');const follow=control(page,'area',f.area);
  await expect(follow.getByRole('button',{name:'Unfollow',exact:true})).toBeEnabled();
  await follow.getByText('Follow settings',{exact:true}).click();
  await api(page,'/api/v1/me/following/state',{target:{kind:'area',resource_id:f.area},include_descendants:true,preferences:['replies'],following:true,expected_version:1,idempotency_key:randomUUID()});
  await page.getByRole('button',{name:'Refresh following'}).click();
  await expect(page.getByText('Including subtopics · Replies and reply edits',{exact:true})).toBeVisible();
  await expect(follow.getByLabel('Include subtopics')).toBeVisible();
  await expect(follow.getByLabel('Include subtopics')).toBeChecked();
  await expect(follow.getByLabel('Replies and reply edits')).toBeChecked();
  await expect(follow.getByLabel('Artifact publications')).not.toBeChecked();
  await follow.getByLabel('Artifact publications').check();
  await follow.getByRole('button',{name:'Save follow settings'}).click();
  await expect(follow.getByRole('status')).toContainText('Following settings saved');
  const current=await api(page,'/api/v1/me/following/lookup',{kind:'area',resource_id:f.area});
  expect({version:current.version,include_descendants:current.include_descendants,preferences:current.preferences}).toEqual({version:3,include_descendants:true,preferences:['replies','artifact_revisions']});
});

test('chronological Changes freezes displayed pages, replays reload/back, resizes exact successors and shows older settings',async({page,context,server},info)=>{
  const f=await material(page,context,server);await page.goto(server.origin+'/loom/changes');await expect(page.locator('.notification-list > li')).toHaveCount(12);
  const first=await page.locator('.notification-list h2').allTextContents();await page.locator('.notification-list').getByRole('link',{name:'Exact revision 1'}).first().click();await expect(page.getByRole('heading',{name:'Community overview',exact:true})).toBeVisible();await page.goBack();await expect(page.locator('.notification-list > li')).toHaveCount(12);expect(await page.locator('.notification-list h2').allTextContents()).toEqual(first);
  await page.reload();await expect(page.locator('.notification-list > li')).toHaveCount(12);
  const saved=await api(page,'/api/v1/me/following/lookup',{kind:'area',resource_id:f.area});await api(page,'/api/v1/me/following/state',{target:saved.target,include_descendants:true,preferences:['summaries'],following:true,expected_version:saved.version,idempotency_key:randomUUID()});
  await page.getByLabel('Next page size').selectOption('5');await page.getByRole('button',{name:'Continue shared interval'}).focus();await page.keyboard.press('Enter');await expect(page.locator('.notification-list > li')).toHaveCount(2);await expect(page.getByText(/This view uses older saved Following settings/)).toBeVisible();await expect(page.getByRole('heading',{name:'Changes',exact:true})).toBeFocused();
  await page.getByRole('button',{name:'Previous shared page'}).click();await expect(page.locator('.notification-list > li')).toHaveCount(12);expect(await page.locator('.notification-list h2').allTextContents()).toEqual(first);
  for(const [name,width,height] of [['desktop',1440,1000],['mobile',390,844]] as const){await page.setViewportSize({width,height});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    if(process.env.LOOM_FOLLOWING_REVIEW_SCREENS==='1'){const destination=fileURLToPath(new URL('../../docs/development/evidence/following/',import.meta.url));await mkdir(destination,{recursive:true});const path=info.outputPath('changes-'+name+'.png');await page.screenshot({path,fullPage:true});await copyFile(path,destination+'changes-'+name+'.png');}}
  await page.getByRole('button',{name:'Continue shared interval'}).click();await expect(page.locator('.notification-list > li')).toHaveCount(2);await page.getByRole('button',{name:'Check newer shared changes'}).click();await expect(page.getByRole('alert')).toContainText('Following settings changed');await page.getByRole('button',{name:'Adopt current settings from retained history'}).click();await expect(page.locator('.notification-list > li')).toHaveCount(0);
  expect((await server.observer.query('SELECT count(*)::int n FROM loom.personal_deliveries')).rows[0].n).toBe(0);
});

test('summary change context opens the discussion while historical summary revisions and focused replies remain distinct',async({page,context,server})=>{
  const f=await setup(page,context,server);
  const opening=await api(page,'/api/v1/discussions',{idempotency_key:randomUUID(),area_id:f.area,title:'Shared summary context',content:authored('Navigation opening')});
  const discussion=(await api(page,'/api/v1/resources/'+opening.resource_id)).discussion_id;
  const reply=await api(page,'/api/v1/replies',{idempotency_key:randomUUID(),discussion_id:discussion,parent_id:opening.resource_id,content:authored('Focused reply material')});
  const preparation=await api(page,'/api/v1/summary-preparations',{idempotency_key:randomUUID(),discussion_id:discussion,scope:'full'});
  const summary=await api(page,'/api/v1/summaries',{idempotency_key:randomUUID(),discussion_id:discussion,title:'Summary R1',content:authored('Original summary text'),coverage:{preparation_id:preparation.preparation_id}});
  await api(page,'/api/v1/me/following/state',{target:{kind:'discussion',resource_id:discussion},include_descendants:false,preferences:['replies','summaries'],following:true,expected_version:0,idempotency_key:randomUUID()});
  await page.goto(server.origin+'/loom/changes');await expect(page.locator('.notification-list > li')).toHaveCount(2);
  const summary2=await api(page,'/api/v1/summary-revisions',{idempotency_key:randomUUID(),resource_id:summary.resource_id,expected_revision_id:summary.revision_id,title:'Summary R2',content:authored('Current summary text'),coverage:{carry_forward_revision_id:summary.revision_id}});
  // The displayed event remains R1; its current context must still resolve R2.
  await expect(page.locator('.notification-list > li')).toHaveCount(2);
  const row=(source:{resource_id:string;revision_id:string})=>page.locator('.notification-list > li').filter({has:page.locator(`a[href="/loom/resource/${source.resource_id}/${source.revision_id}"]`)});
  await row(summary).getByRole('link',{name:'Current context',exact:true}).click();
  await expect(page).toHaveURL(server.origin+'/loom/discussion/'+discussion);
  await expect(page.getByRole('heading',{name:'Shared summary context',level:1,exact:true})).toBeVisible();
  await expect(page.getByText('Navigation opening',{exact:true})).toBeVisible();
  await expect(page.getByText('This branch is unavailable in this discussion.')).toHaveCount(0);
  await page.getByRole('region',{name:'Discussion summary'}).getByRole('link',{name:'Summary R2',exact:true}).click();
  await expect(page.getByText('Current summary text',{exact:true})).toBeVisible();
  await page.goto(server.origin+'/loom/changes');await expect(page.locator('.notification-list > li')).toHaveCount(2);
  await row(summary).getByRole('link',{name:'Exact revision 1',exact:true}).click();
  await expect(page).toHaveURL(server.origin+`/loom/resource/${summary.resource_id}/${summary.revision_id}`);
  await expect(page.getByText('Original summary text',{exact:true})).toBeVisible();
  await expect(page.getByText('Current summary text',{exact:true})).toHaveCount(0);
  await page.goto(server.origin+'/loom/changes');await expect(page.locator('.notification-list > li')).toHaveCount(2);
  await page.getByRole('button',{name:'Check newer shared changes'}).click();
  await expect(page.locator('.notification-list > li')).toHaveCount(1);
  await row(summary2).getByRole('link',{name:'Current context',exact:true}).click();
  await expect(page).toHaveURL(server.origin+'/loom/discussion/'+discussion);
  await expect(page.getByRole('region',{name:'Discussion summary'}).getByRole('link',{name:'Summary R2',exact:true})).toBeVisible();
  await expect(page.getByText('This branch is unavailable in this discussion.')).toHaveCount(0);
  await page.goto(server.origin+'/loom/changes');await expect(page.locator('.notification-list > li')).toHaveCount(1);
  await page.getByRole('button',{name:'Refresh scope from retained history'}).click();await expect(page.locator('.notification-list > li')).toHaveCount(3);
  await row(reply).getByRole('link',{name:'Current context',exact:true}).click();
  await expect(page).toHaveURL(server.origin+`/loom/discussion/${discussion}?focus=${reply.resource_id}`);
  await expect(page.getByText('Focused branch',{exact:true})).toBeVisible();
  await expect(page.getByText('Focused reply material',{exact:true})).toBeVisible();
  await expect(page.getByText('This branch is unavailable in this discussion.')).toHaveCount(0);
});

test('expired shared page renewal preserves the displayed five-item page after reload',async({page,context,server})=>{
  await material(page,context,server,20);await page.goto(server.origin+'/loom/changes');
  await expect(page.locator('.notification-list > li')).toHaveCount(12);
  await page.getByLabel('Next page size').selectOption('5');
  await page.getByRole('button',{name:'Continue shared interval'}).click();
  await expect(page.locator('.notification-list > li')).toHaveCount(5);
  const titles=await page.locator('.notification-list h2').allTextContents(),saved=(await recovery(page))[0]!,scope=Object.keys(saved.records)[0]!,record=saved.records[scope];
  // Expire only this owned fixture descriptor; production custody and clocks stay
  // untouched. The real HTTPS endpoint must reject it and then renew its bounds.
  const key=(await server.observer.query('SELECT cursor_key FROM loom.shared_retrieval_state')).rows[0].cursor_key as Buffer;
  const bytes=Buffer.from(record.request.cursor,'base64url'),decipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));
  decipher.setAAD(Buffer.from('shared-changes-1'));decipher.setAuthTag(bytes.subarray(12,28));
  const descriptor=JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString());descriptor.expires=0;
  const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(Buffer.from('shared-changes-1'));
  const encrypted=Buffer.concat([cipher.update(JSON.stringify(descriptor)),cipher.final()]),expired=Buffer.concat([nonce,cipher.getAuthTag(),encrypted]).toString('base64url');
  await page.evaluate(({prefix,scope,cursor})=>{const records=JSON.parse(localStorage.getItem(prefix)!);records[scope].request.cursor=cursor;localStorage.setItem(prefix,JSON.stringify(records));},{prefix:saved.key,scope,cursor:expired});
  await page.reload();await expect(page.getByRole('button',{name:'Renew fixed shared view'})).toBeVisible();
  const request=page.waitForRequest(r=>r.url().endsWith('/api/v1/shared-changes/query')&&r.postDataJSON()?.recovery?.action==='renew');
  await page.getByRole('button',{name:'Renew fixed shared view'}).click();
  expect((await request).postDataJSON()).toEqual({recovery:{action:'renew',token:expired},limit:5,max_response_bytes:record.request.max_response_bytes});
  await expect(page.locator('.notification-list > li')).toHaveCount(5);
  expect(await page.locator('.notification-list h2').allTextContents()).toEqual(titles);
  await expect(page.getByLabel('Next page size')).toHaveValue('5');
  const renewed=(await recovery(page))[0]!.records[scope];
  expect({limit:renewed.request.limit,max_response_bytes:renewed.request.max_response_bytes}).toEqual({limit:5,max_response_bytes:record.request.max_response_bytes});
});

test('shared transport and local-save failures keep permitted context and the last recoverable page',async({page,context,server})=>{
  await material(page,context,server);await page.goto(server.origin+'/loom/changes');await expect(page.locator('.notification-list > li')).toHaveCount(12);const saved=await recovery(page),titles=await page.locator('.notification-list h2').allTextContents();let fail=true;
  await page.route('**/api/v1/shared-changes/query',async route=>{if(fail)await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'service_unavailable',message:'Synthetic shared failure'}})});else await route.continue();});
  const next=page.getByRole('button',{name:'Continue shared interval'});await next.focus();await page.keyboard.press('Enter');await expect(page.getByRole('alert')).toContainText('Synthetic shared failure');await expect(next).toBeFocused();expect(await recovery(page)).toEqual(saved);
  fail=false;await page.evaluate(()=>{const original=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key.startsWith('loom.shared-pages:')){Storage.prototype.setItem=original;throw new DOMException('Synthetic shared save failure','QuotaExceededError');}original.call(this,key,value);};});
  await page.getByRole('button',{name:'Retry shared page'}).click();await expect(page.getByRole('alert')).toContainText('Shared recovery could not be saved');expect(await recovery(page)).toEqual(saved);expect(await page.locator('.notification-list h2').allTextContents()).toEqual(titles);
  await page.reload();await expect(page.locator('.notification-list > li')).toHaveCount(12);expect(await page.locator('.notification-list h2').allTextContents()).toEqual(titles);await page.getByRole('button',{name:'Continue shared interval'}).click();await expect(page.locator('.notification-list > li')).toHaveCount(2);
});

test('shared visibility failures withdraw cached rows, focus recovery and restore events behind completed checkpoints',async({page,context,server})=>{
  const f=await material(page,context,server,0);await page.goto(server.origin+'/loom/changes');await expect(page.locator('.notification-list > li')).toHaveCount(2);
  await server.observer.query("UPDATE loom.resources SET state='suppressed' WHERE id=$1",[f.target.resource_id]);await page.getByRole('button',{name:'Check newer shared changes'}).click();await expect(page.getByRole('alert')).toBeFocused();await expect(page.locator('.notification-list > li')).toHaveCount(0);
  await page.getByRole('button',{name:'Replay retained shared history',exact:true}).click();await expect(page.locator('.notification-list > li')).toHaveCount(1);await page.getByRole('button',{name:'Check newer shared changes'}).click();await expect(page.locator('.notification-list > li')).toHaveCount(0);
  await server.observer.query("UPDATE loom.resources SET state='active' WHERE id=$1",[f.target.resource_id]);await page.getByRole('button',{name:'Check newer shared changes'}).click();await expect(page.getByRole('alert')).toBeFocused();await page.getByRole('button',{name:'Replay retained shared history',exact:true}).click();await expect(page.locator('.notification-list > li')).toHaveCount(2);
  expect(new Set(Object.values((await recovery(page))[0]!.records).flatMap((r:any)=>r.recent_event_ids)).size).toBe(2);
});

test('late explicit-filter and route responses cannot restore a replaced shared view',async({page,context,server})=>{
  const f=await material(page,context,server,0),entered=barrier(),release=barrier();let held=false;
  await page.route('**/api/v1/shared-changes/query',async route=>{if(!held){held=true;const response=await route.fetch();entered.release();await release.promise;await route.fulfill({response}).catch(()=>{});}else await route.continue();});
  try{
    await page.goto(server.origin+'/loom/changes?kind=area&id='+f.area);
    await entered.promise;
    await page.getByText('Explicit scope and event preferences',{exact:true}).click();
    await expect(page.getByLabel('Artifact publications',{exact:true})).toBeVisible();
    await page.getByLabel('Artifact publications',{exact:true}).uncheck();
    await expect(page.locator('.notification-list > li')).toHaveCount(0);
    release.release();
    await expect(page.getByLabel('Artifact publications',{exact:true})).not.toBeChecked();
  }
  finally{release.release();await page.unrouteAll({behavior:'wait'});}
  const routeEntered=barrier(),routeRelease=barrier();await page.route('**/api/v1/shared-changes/query',async route=>{const response=await route.fetch();routeEntered.release();await routeRelease.promise;await route.fulfill({response}).catch(()=>{});});
  try{await page.getByRole('button',{name:'Refresh scope from retained history'}).click();await routeEntered.promise;await page.getByRole('link',{name:'Topics',exact:true}).first().click();routeRelease.release();await expect(page.getByRole('heading',{name:'Topics',exact:true})).toBeVisible();await expect(page.locator('.notification-list > li')).toHaveCount(0);}
  finally{routeRelease.release();await page.unrouteAll({behavior:'wait'});}
});

test('sign-out fences shared responses immediately while cleanup waits for its Web Lock',async({page,context,server})=>{
  await material(page,context,server,0);await page.goto(server.origin+'/loom/changes');await expect(page.locator('.notification-list > li')).toHaveCount(2);const lockName=(await recovery(page))[0]!.key;
  await page.evaluate(async name=>{await new Promise<void>(entered=>{void navigator.locks.request(name,()=>new Promise<void>(release=>{(window as any).releaseSharedCleanup=release;entered();}));});},lockName);
  const entered=barrier(),release=barrier();await page.route('**/api/v1/shared-changes/query',async route=>{const response=await route.fetch();entered.release();await release.promise;await route.fulfill({response}).catch(()=>{});});
  try{await page.getByRole('button',{name:'Check newer shared changes'}).click();await entered.promise;await page.getByRole('button',{name:'Sign out',exact:true}).click();const confirm=page.getByRole('button',{name:'Clear local drafts and sign out'});if(await confirm.isVisible())await confirm.click();
    await expect.poll(()=>page.evaluate(async name=>(await navigator.locks.query()).pending?.some(lock=>lock.name===name),lockName)).toBe(true);release.release();await expect(page.getByRole('button',{name:'Sign in with passkey'})).toBeVisible();await expect(page.locator('.notification-list > li')).toHaveCount(0);
  }finally{release.release();await page.evaluate(()=>(window as any).releaseSharedCleanup());await page.unrouteAll({behavior:'wait'});}
  await expect.poll(()=>recovery(page)).toEqual([]);
});
