import { randomUUID } from 'node:crypto';
import { mkdir,copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Page,BrowserContext,Response } from '@playwright/test';
import { test,expect } from '../helpers/browser-fixtures.js';
import { setup,api } from '../helpers/change-browser.js';
import { authored } from '../helpers/references.js';
import { mentioned } from '../helpers/notifications.js';
import { NativeSearchWorker } from '../../scripts/lib/native-search-worker.js';
import { syntheticServer } from '../helpers/participation-server.js';
import { editUpdatesToken } from '../helpers/updates-token.js';
const records=(page:Page)=>page.evaluate(()=>Object.entries(localStorage).filter(([key])=>key.startsWith('loom.routine-updates-pages:')).map(([key,value])=>({key,records:JSON.parse(value)})));
function barrier(){let release!:()=>void;const promise=new Promise<void>(r=>release=r);return {promise,release};}
function observeUpdates(page:Page){
  let latest:Response;
  page.on('response',response=>{if(response.url().endsWith('/api/v1/me/routine-updates/query')&&response.ok())latest=response;});
  return ()=>latest.json();
}
async function ready(page:Page){
  await expect(page.getByRole('heading',{name:'Updates',exact:true})).toBeVisible();
  // The idle toolbar can paint before the initial load effect. Require a
  // rendered response before reading recovery, response bodies or group titles.
  await expect(page.getByText('Interval, coverage and recovery',{exact:true})).toBeVisible();
  for(let n=0;n<10;n++){
    await expect(page.getByRole('button',{name:'Refresh scope from retained history'})).toHaveAttribute('aria-disabled','false');
    const more=page.getByRole('button',{name:'Continue preparing Updates'});if(!await more.isVisible())return;await more.click();
  }
  throw new Error('Synthetic Updates preparation exceeded ten steps');
}
async function routine(page:Page,context:BrowserContext,server:Awaited<ReturnType<typeof syntheticServer>>){
  const f=await setup(page,context,server),sources:string[]=[];
  for(let n=0;n<7;n++){
    const source=await api(page,'/api/v1/artifacts',{idempotency_key:randomUUID(),area_id:f.area,title:'Research update '+n,content:authored('Synthetic source '+n)});
    sources.push(source.resource_id);
    await api(page,'/api/v1/me/following/state',{target:{kind:'artifact',resource_id:source.resource_id},include_descendants:false,preferences:['artifact_revisions','change_notes'],following:true,expected_version:0,idempotency_key:randomUUID()});
  }
  await page.getByRole('link',{name:'Updates',exact:true}).click();await ready(page);await expect(page.locator('.updates-list > li')).toHaveCount(3);return {...f,sources};
}

for(const kind of ['personal','artifact'] as const)test(`tokenless ${kind} history gap preserves scope and reason through baseline, reload and newer activity`,async({page,context,server})=>{
  const f=await setup(page,context,server),view=observeUpdates(page),reason=kind==='personal'?'mention':'reply';
  const scope=kind==='personal'?{kind}:{kind:'explicit',definition:{target:{kind,resource_id:f.target.resource_id},include_descendants:false,preferences:['artifact_revisions']}};
  // Simulate an actual component retention floor before any browser descriptor exists.
  if(kind==='personal')await server.observer.query('INSERT INTO loom.participant_delivery_clocks(participant_id,position,retained_after) VALUES($1,1,1)',[f.person]);
  else await server.observer.query('UPDATE loom.shared_retrieval_state SET retained_after=1');
  await page.goto(`${server.origin}/loom/updates?kind=${kind}&id=${f.target.resource_id}&events=artifact_revisions&reason=${reason}`);
  await expect(page.getByRole('alert')).toContainText('history is unavailable');expect(await records(page)).toEqual([]);
  const request=page.waitForRequest(r=>r.url().endsWith('/api/v1/me/routine-updates/query')&&r.postDataJSON().recovery?.action==='resynchronize');
  await page.getByRole('button',{name:'Establish an incomplete new baseline'}).click();
  expect((await request).postDataJSON()).toEqual({scope,reason,recovery:{action:'resynchronize'},limit:12,max_response_bytes:131072});
  await ready(page);
  const baseline=await view();expect(baseline.traversal.scope).toBe(scope.kind);expect(baseline.traversal.reason).toBe(reason);
  expect(baseline.traversal.definitions).toEqual(kind==='personal'?[]:[{...(scope as any).definition,version:0}]);
  expect(baseline.baseline_established).toBe(true);expect(baseline.grouped_interval_complete).toBe(false);expect(baseline.checkpoint).toEqual(expect.any(String));
  expect(Object.keys((await records(page))[0]!.records)).toEqual([JSON.stringify([scope,reason])]);
  await page.reload();await ready(page);expect((await view()).traversal).toEqual(baseline.traversal);
  await expect(page.getByLabel('Personal reasons')).toHaveValue(reason);await expect(page.getByLabel('Updates scope')).toHaveValue(scope.kind);
  const mention=await f.admin.call('/api/v1/artifacts',{idempotency_key:randomUUID(),area_id:f.area,title:'Personal recovery mention',content:mentioned(f.person),change_note:null,change_account:null});expect(mention.status).toBe(201);
  const revision=await f.admin.call('/api/v1/revisions',{idempotency_key:randomUUID(),resource_id:f.target.resource_id,expected_revision_id:f.target.revision_id,title:'Recovered target',content:authored('New matching shared revision')});expect(revision.status).toBe(201);
  const worker=new NativeSearchWorker(server.configuration,'notifications');await worker.start();try{await worker.observeUntil(async()=>(await server.observer.query('SELECT count(*)::int n FROM loom.personal_deliveries WHERE recipient_id=$1',[f.person])).rows[0].n===1);}finally{await worker.stop();}
  const clocks=(await server.observer.query('SELECT shared_position FROM loom.community_clocks')).rows,deliveries=(await server.observer.query('SELECT id,position FROM loom.personal_deliveries')).rows;
  await page.getByRole('button',{name:'Check newer activity'}).click();await ready(page);
  await expect(page.locator('.updates-list h2')).toHaveText(kind==='personal'?'Personal recovery mention':'Recovered target');
  expect((await view()).traversal.scope).toBe(scope.kind);expect((await view()).traversal.reason).toBe(reason);
  await expect(page.getByText(/History remains incomplete/)).toBeVisible();
  await page.reload();await ready(page);await expect(page.getByText(/History remains incomplete/)).toBeVisible();
  expect((await server.observer.query('SELECT shared_position FROM loom.community_clocks')).rows).toEqual(clocks);expect((await server.observer.query('SELECT id,position FROM loom.personal_deliveries')).rows).toEqual(deliveries);
  expect((await server.observer.query('SELECT count(*)::int n FROM loom.saved_items')).rows[0].n).toBe(0);
});

const upgradeTest=test.extend({server:async({diagnostics},use)=>{
  diagnostics.phase('server_starting');const server=await syntheticServer({throughMigration:12});
  diagnostics.setOrigin(server.origin);diagnostics.observeServer(server.app.server);diagnostics.phase('server_ready');
  try{await use(server);}finally{diagnostics.phase('server_closing');await server.close();diagnostics.phase('server_closed');}
}});
upgradeTest('pre-0013 unknown history offers an incomplete baseline with retained-content links and newer activity after reload',async({page,context,server})=>{
  const f=await setup(page,context,server),view=observeUpdates(page);
  const createArea=async(title:string,parent_id:string)=>{
    const state=(await f.admin.call('/api/v1/organization/resources/'+f.area)).body;
    const r=await f.admin.call('/api/v1/organization/changes',{idempotency_key:randomUUID(),kind:'area.create',parent_id,title,description:'Legacy browser scope',expected_hierarchy_version:state.hierarchy_version});expect(r.status).toBe(200);return r.body.outcome.resource_id as string;
  };
  const move=async(resource_id:string,parent_id:string)=>{
    const state=(await f.admin.call('/api/v1/organization/resources/'+resource_id)).body;
    const r=await f.admin.call('/api/v1/organization/changes',{idempotency_key:randomUUID(),kind:'area.move',resource_id,parent_id,expected_version:state.version,expected_hierarchy_version:state.hierarchy_version});expect(r.status).toBe(200);
  };
  const parent=await createArea('Legacy parent',f.area),child=await createArea('Legacy child',parent),other=await createArea('Other topic',f.area);
  await move(parent,other);await server.migrate();
  await page.goto(`${server.origin}/loom/updates?kind=area&id=${child}&events=structural&reason=reply`);await ready(page);
  await page.getByRole('button',{name:'Show all matching groups in this interval'}).click();await ready(page);
  const unknown=await view();expect(unknown.traversal.shared.coverage).toBe('unknown');expect(unknown.selection_exhausted).toBe(true);expect(unknown.grouped_interval_complete).toBe(false);expect(unknown.checkpoint).toBeNull();
  await expect(page.getByText('Historical shared coverage is unknown. No complete combined checkpoint is issued.')).toBeVisible();
  await expect(page.getByRole('button',{name:'Check newer activity'})).toHaveCount(0);
  const clocks=(await server.observer.query('SELECT shared_position FROM loom.community_clocks')).rows;
  const request=page.waitForRequest(r=>r.url().endsWith('/api/v1/me/routine-updates/query')&&r.postDataJSON().recovery?.action==='resynchronize');
  await page.getByRole('button',{name:'Establish an incomplete new baseline'}).click();
  expect((await request).postDataJSON()).toEqual({recovery:{action:'resynchronize',token:unknown.page_cursor},limit:12,max_response_bytes:131072});
  await ready(page);const baseline=await view();
  expect(baseline.traversal.definitions).toEqual(unknown.traversal.definitions);expect(baseline.traversal.reason).toBe('reply');expect(baseline.traversal.scope).toBe('explicit');
  expect(baseline.baseline_established).toBe(true);expect(baseline.grouped_interval_complete).toBe(false);expect(baseline.checkpoint).toEqual(expect.any(String));
  await page.reload();await ready(page);expect((await view()).traversal).toEqual(baseline.traversal);
  for(const [name,path] of [['Browse retained topics','/loom'],['Browse retained artifacts','/loom/artifacts'],['Open retained personal attention','/loom/notifications']] as const)await expect(page.getByRole('link',{name})).toHaveAttribute('href',path);
  expect((await server.observer.query('SELECT shared_position FROM loom.community_clocks')).rows).toEqual(clocks);
  await move(child,f.area);await page.getByRole('button',{name:'Check newer activity'}).click();await ready(page);
  await expect(page.locator('.updates-list > li')).toHaveCount(1);await expect(page.locator('.update-counts')).toHaveText('1 structural change');
  expect((await view()).baseline_established).toBe(false);expect((await view()).traversal.shared.history).toBe('incomplete');
  await expect(page.getByText(/History remains incomplete/)).toBeVisible();
  expect((await server.observer.query('SELECT count(*)::int n FROM loom.personal_deliveries')).rows[0].n).toBe(0);
  expect((await server.observer.query('SELECT count(*)::int n FROM loom.saved_items')).rows[0].n).toBe(0);
});

test('AC07 compact discussion, exact direct source, attributed note, bounded expansion, summary navigation and narrow keyboard layout',async({page,context,server},info)=>{
  const f=await setup(page,context,server),opening=await f.admin.call('/api/v1/discussions',{idempotency_key:randomUUID(),area_id:f.area,title:'Review the synthesis',content:authored('Original discussion')});expect(opening.status).toBe(201);
  const discussion=(await f.admin.call('/api/v1/resources/'+opening.body.resource_id)).body.discussion_id;
  const prep=await api(page,'/api/v1/summary-preparations',{idempotency_key:randomUUID(),discussion_id:discussion,scope:'full'});
  const summary=await api(page,'/api/v1/summaries',{idempotency_key:randomUUID(),discussion_id:discussion,title:'Synthesis R1',content:authored('Historical synthesis'),coverage:{preparation_id:prep.preparation_id}});
  await api(page,'/api/v1/me/following/state',{target:{kind:'discussion',resource_id:discussion},include_descendants:false,preferences:['replies','summaries'],following:true,expected_version:0,idempotency_key:randomUUID()});
  await page.goto(server.origin+'/loom/updates');await ready(page);await page.getByRole('button',{name:'Show all matching groups in this interval'}).click();await ready(page);
  let direct:any;
  for(let n=0;n<20;n++){
    const reply=await f.admin.call('/api/v1/replies',{idempotency_key:randomUUID(),discussion_id:discussion,parent_id:opening.body.resource_id,content:n===7?mentioned(f.person):{format:'loom-markdown-v3',text:'Contribution '+n,mentions:[],references:[]},change_note:null,change_account:null});expect(reply.status).toBe(201);if(n===7)direct=reply.body;
  }
  await api(page,'/api/v1/summary-revisions',{idempotency_key:randomUUID(),resource_id:summary.resource_id,expected_revision_id:summary.revision_id,title:'Synthesis R2',content:{format:'loom-markdown-v3',text:'Current synthesis',mentions:[],references:[]},change_note:authored('Explains this summary revision only'),change_account:null,coverage:{carry_forward_revision_id:summary.revision_id}});
  const worker=new NativeSearchWorker(server.configuration,'notifications');await worker.start();try{await worker.observeUntil(async()=>(await server.observer.query('SELECT count(*)::int n FROM loom.personal_deliveries')).rows[0].n===1);}finally{await worker.stop();}
  const clocks=(await server.observer.query('SELECT shared_position FROM loom.community_clocks')).rows,deliveries=(await server.observer.query('SELECT id,position FROM loom.personal_deliveries')).rows;
  await page.getByRole('button',{name:'Check newer activity'}).click();await ready(page);await expect(page.locator('.updates-list > li')).toHaveCount(1);
  await expect(page.locator('.update-counts')).toHaveText('20 reply publications · 1 summary change · 1 personal signal');
  await expect(page.getByRole('link',{name:'Exact source revision 1'})).toHaveAttribute('href',`/loom/resource/${direct.resource_id}/${direct.revision_id}`);
  await expect(page.getByRole('link',{name:'Revision note by browser_author'})).toBeVisible();await expect(page.getByText(/describes 1 named revision in this group/)).toBeVisible();
  const inspect=page.getByRole('button',{name:'Inspect changes',exact:true});await inspect.focus();await page.keyboard.press('Enter');await expect(page.getByRole('complementary',{name:'Expanded changes'})).toBeFocused();await expect(page.locator('#updates-expansion ol > li')).toHaveCount(12);
  const saved=await records(page);expect(Object.values(saved[0]!.records)[0]).toHaveProperty('expansion');await page.reload();await ready(page);await expect(page.locator('#updates-expansion ol > li')).toHaveCount(12);
  const encryptionKey=(await server.observer.query('SELECT cursor_key FROM loom.updates_state')).rows[0].cursor_key,expired=await records(page);
  for(const entry of expired)for(const record of Object.values(entry.records) as any[]){record.request.cursor=editUpdatesToken(record.request.cursor,encryptionKey,b=>b.expires=0,'combined-updates-2');if(record.expansion)record.expansion.cursor=editUpdatesToken(record.expansion.cursor,encryptionKey,b=>b.expires=0,'combined-updates-2');}
  await page.evaluate(entries=>{for(const entry of entries)localStorage.setItem(entry.key,JSON.stringify(entry.records));},expired);
  await page.reload();await page.getByRole('button',{name:'Renew fixed Updates view'}).click();await ready(page);await expect(page.locator('#updates-expansion ol > li')).toHaveCount(12);
  for(const [name,width,height] of [['desktop',1440,1000],['mobile',390,844]] as const){await page.setViewportSize({width,height});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    if(process.env.LOOM_UPDATES_REVIEW_SCREENS==='1'){const destination=fileURLToPath(new URL('../../docs/development/evidence/updates/',import.meta.url));await mkdir(destination,{recursive:true});const path=info.outputPath('updates-'+name+'.png');await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path,fullPage:true});await copyFile(path,destination+'updates-'+name+'.png');}}
  await page.getByRole('button',{name:'Next sources'}).click();await expect(page.locator('#updates-expansion ol > li')).toHaveCount(9);await page.getByRole('button',{name:'Close changes'}).click();await expect(page.getByRole('complementary')).toHaveCount(0);await expect(page.getByRole('button',{name:'Inspect changes',exact:true})).toBeFocused();
  await page.getByRole('button',{name:'Refresh scope from retained history'}).click();await ready(page);await page.getByLabel('Next page size').selectOption('25');await page.getByRole('button',{name:'Inspect changes',exact:true}).click();await expect(page.locator('#updates-expansion ol > li')).toHaveCount(22);
  const historical=page.locator('#updates-expansion li').filter({has:page.locator(`a[href="/loom/resource/${summary.resource_id}/${summary.revision_id}"]`)});
  await historical.getByRole('link',{name:'Current context',exact:true}).click();await expect(page).toHaveURL(server.origin+'/loom/discussion/'+discussion);await expect(page.getByText('This branch is unavailable in this discussion.')).toHaveCount(0);
  await expect(page.getByRole('region',{name:'Discussion summary'}).getByRole('link',{name:'Synthesis R2'})).toBeVisible();await page.goBack();await ready(page);await expect(page.locator('#updates-expansion ol > li')).toHaveCount(22);
  await historical.getByRole('link',{name:'Exact revision 1',exact:true}).click();await expect(page.getByText('Historical synthesis',{exact:true})).toBeVisible();await expect(page.getByText('Current synthesis',{exact:true})).toHaveCount(0);
  expect((await server.observer.query('SELECT shared_position FROM loom.community_clocks')).rows).toEqual(clocks);expect((await server.observer.query('SELECT id,position FROM loom.personal_deliveries')).rows).toEqual(deliveries);expect((await server.observer.query('SELECT count(*)::int n FROM loom.saved_items')).rows[0].n).toBe(0);
});

test('highlights retain interval on complete switch; failed saves, back and reload preserve exact displayed pages',async({page,context,server})=>{
  await routine(page,context,server);const selected=await records(page);expect(Object.values(selected[0]!.records)[0]).toHaveProperty('checkpoint',null);
  await page.getByLabel('Next page size').selectOption('5');await page.getByRole('button',{name:'Show all matching groups in this interval'}).click();await ready(page);await expect(page.locator('.updates-list > li')).toHaveCount(5);
  const titles=await page.locator('.updates-list h2').allTextContents(),saved=await records(page);await page.evaluate(()=>{const set=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key.startsWith('loom.routine-updates-pages:')){Storage.prototype.setItem=set;throw new DOMException('Synthetic Updates save failure','QuotaExceededError');}set.call(this,key,value);};});
  const next=page.getByRole('button',{name:'Continue this interval'});await next.focus();await page.keyboard.press('Enter');await expect(page.getByRole('alert')).toContainText('could not be saved');await expect(next).toBeFocused();expect(await records(page)).toEqual(saved);expect(await page.locator('.updates-list h2').allTextContents()).toEqual(titles);
  await page.reload();await ready(page);expect(await page.locator('.updates-list h2').allTextContents()).toEqual(titles);await page.getByRole('button',{name:'Continue this interval'}).click();await ready(page);await expect(page.locator('.updates-list > li')).toHaveCount(2);
  await page.getByRole('button',{name:'Previous Updates page'}).click();await ready(page);expect(await page.locator('.updates-list h2').allTextContents()).toEqual(titles);
  await page.getByRole('link',{name:'Topics',exact:true}).first().click();await page.goBack();await ready(page);expect(await page.locator('.updates-list h2').allTextContents()).toEqual(titles);
  const other=await context.newPage();await other.goto(server.origin+'/loom/updates');await ready(other);await expect(other.locator('.updates-list > li')).toHaveCount(5);
  await page.getByRole('button',{name:'Continue this interval'}).click();await expect(page.getByRole('alert')).toContainText('Another tab changed');expect(await page.locator('.updates-list h2').allTextContents()).toEqual(titles);
  await other.getByRole('button',{name:'Continue this interval'}).click();await ready(other);const latest=await other.locator('.updates-list h2').allTextContents();await page.reload();await ready(page);expect(await page.locator('.updates-list h2').allTextContents()).toEqual(latest);await other.close();
});

test('late scope and route responses are fenced and visibility withdrawal removes protected group counts',async({page,context,server})=>{
  const f=await routine(page,context,server),entered=barrier(),release=barrier();let held=false;
  await page.route('**/api/v1/me/routine-updates/query',async route=>{if(!held){held=true;const response=await route.fetch();entered.release();await release.promise;await route.fulfill({response}).catch(()=>{});}else await route.continue();});
  try{await page.getByRole('button',{name:'Refresh scope from retained history'}).click();await entered.promise;await page.getByLabel('Updates scope').selectOption('personal');await ready(page);release.release();await expect(page.locator('.updates-list > li')).toHaveCount(0);}
  finally{release.release();await page.unrouteAll({behavior:'wait'});}
  await page.getByLabel('Updates scope').selectOption('following');await ready(page);await expect(page.locator('.updates-list > li')).toHaveCount(3);
  await server.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='suppressed' WHERE id=$1",[f.area]));
  await page.getByRole('button',{name:'Show all matching groups in this interval'}).click();await expect(page.getByRole('alert')).toContainText('Visibility changed');await expect(page.locator('.updates-list > li')).toHaveCount(0);await expect(page.getByRole('alert')).toBeFocused();
  await page.getByRole('button',{name:'Replay both retained streams'}).click();await ready(page);await expect(page.locator('.updates-list > li')).toHaveCount(0);
});

test('sign-out withdraws Updates before blocked cleanup and late responses cannot refill its journal',async({page,context,server})=>{
  await routine(page,context,server);const saved=await records(page),lock=saved[0]!.key;
  await page.evaluate(async name=>{await new Promise<void>(entered=>{void navigator.locks.request(name,()=>new Promise<void>(release=>{(window as any).releaseUpdatesCleanup=release;entered();}));});},lock);
  const entered=barrier(),release=barrier();await page.route('**/api/v1/me/routine-updates/query',async route=>{const response=await route.fetch();entered.release();await release.promise;await route.fulfill({response}).catch(()=>{});});
  try{await page.getByRole('button',{name:'Show all matching groups in this interval'}).click();await entered.promise;await page.getByRole('button',{name:'Sign out',exact:true}).click();const confirm=page.getByRole('button',{name:'Clear local drafts and sign out'});if(await confirm.isVisible())await confirm.click();
    await expect.poll(()=>page.evaluate(async name=>(await navigator.locks.query()).pending?.some(l=>l.name===name),lock)).toBe(true);release.release();await expect(page.getByRole('button',{name:'Sign in with passkey'})).toBeVisible();await expect(page.locator('.updates-list > li')).toHaveCount(0);expect(await records(page)).toEqual(saved);
  }finally{release.release();await page.evaluate(()=>(window as any).releaseUpdatesCleanup());await page.unrouteAll({behavior:'wait'});}
  await expect.poll(async()=>await records(page)).toEqual([]);
});

test('retry after an expansion race restores the fixed overview and unseen successor without skipping sources',async({page,context,server})=>{
  const f=await routine(page,context,server);
  await page.getByLabel('Next page size').selectOption('5');
  await page.getByText('Interval, coverage and recovery',{exact:true}).click();
  await page.getByRole('button',{name:'Inspect all source records'}).click();
  await expect(page.locator('#updates-expansion ol > li')).toHaveCount(5);
  const sourceIds=()=>page.locator('#updates-expansion').getByRole('link',{name:'Exact revision 1',exact:true}).evaluateAll(links=>links.map(a=>new URL((a as HTMLAnchorElement).href).pathname.split('/')[3]));
  const first=await sourceIds(),saved=await records(page),shown=(Object.values(saved[0]!.records)[0] as any).expansion;
  const entered=barrier(),release=barrier();let firstRequest=true;
  await page.route('**/api/v1/me/routine-updates/members',async route=>{
    if(firstRequest){firstRequest=false;await route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:{code:'updates_view_changed',message:'Authority or source state changed during retrieval. Reauthorize the same page.'}})});return;}
    const response=await route.fetch();entered.release();await release.promise;await route.fulfill({response}).catch(()=>{});
  });
  try{
    await page.getByRole('button',{name:'Next sources'}).click();
    await expect(page.getByRole('alert')).toBeFocused();await expect(page.locator('.updates-list > li')).toHaveCount(0);
    await expect(page.getByRole('complementary',{name:'Expanded changes'})).toHaveCount(0);expect(await records(page)).toEqual(saved);
    await page.getByRole('button',{name:'Retry Updates'}).click();await entered.promise;
    expect((Object.values((await records(page))[0]!.records)[0] as any).expansion).toEqual(shown);
    release.release();await expect(page.locator('#updates-expansion ol > li')).toHaveCount(2);
    await expect(page.locator('.updates-list > li')).toHaveCount(3);
    await expect(page.getByRole('complementary',{name:'Expanded changes'})).toBeFocused();
    expect([...first,...await sourceIds()].sort()).toEqual([...f.sources].sort());
  }finally{release.release();await page.unrouteAll({behavior:'wait'});}
});
