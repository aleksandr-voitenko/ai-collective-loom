import { randomUUID } from 'node:crypto';
import type { Page,BrowserContext } from '@playwright/test';
import { test,expect } from '../helpers/browser-fixtures.js';
import { NativeSearchWorker } from '../../scripts/lib/native-search-worker.js';
import type { syntheticServer } from '../helpers/participation-server.js';
import { readFile } from 'node:fs/promises';
import { httpClient } from '../helpers/participation-http.js';
import { searchIndexingReview } from '../helpers/search-indexing-review.js';
const content=(text:string)=>({format:'loom-markdown-v1',text,mentions:[]});
function barrier(){let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};}
async function api(page:Page,path:string,body?:unknown){
  const self=await (await page.request.get(new URL('/api/v1/identity/self',page.url()).href)).json();
  const result=body===undefined?await page.request.get(new URL(path,page.url()).href):await page.request.post(new URL(path,page.url()).href,{data:body,headers:{origin:new URL(page.url()).origin,'x-loom-csrf':self.csrf}});
  expect(result.ok()).toBeTruthy();return result.json();
}
async function setup(page:Page,context:BrowserContext,server:Awaited<ReturnType<typeof syntheticServer>>,count=14){
  const cdp=await context.newCDPSession(page);await cdp.send('WebAuthn.enable');await cdp.send('WebAuthn.addVirtualAuthenticator',{options:{protocol:'ctap2',transport:'internal',hasResidentKey:true,hasUserVerification:true,isUserVerified:true,automaticPresenceSimulation:true}});
  await page.goto(server.origin+'/loom');await page.getByText('Set up an admitted account',{exact:true}).click();await page.getByLabel('Enrollment ticket',{exact:true}).fill(server.ticket);
  await page.getByRole('button',{name:'Create passkey',exact:true}).click();await expect(page.getByText('Your passkey is ready. Sign in to continue.')).toBeVisible();await page.getByRole('button',{name:'Sign in with passkey'}).click();await expect(page.getByRole('heading',{name:'Set up your community',exact:true})).toBeVisible();
  await api(page,'/api/v1/community/setup',{idempotency_key:randomUUID(),community_name:'Search browser',ordinary_area_name:'General',proposal_area_name:'Proposals',overview:content('Synthetic overview')});
  const area=(await api(page,'/api/v1/areas')).items.find((r:any)=>r.title==='General').id;
  const publications=[];for(let i=0;i<count;i++)publications.push(await api(page,'/api/v1/artifacts',{idempotency_key:randomUUID(),area_id:area,title:'Zephyr manuscript '+i,content:content('Zephyr browser text with exact meaning. <script>alert("synthetic")</script>')}));
  const worker=new NativeSearchWorker(server.configuration);await worker.start();await worker.observeUntil(async()=>{
    const row=(await server.observer.query('SELECT count(*)::int AS n FROM loom.search_documents')).rows[0];return row.n===count+1;
  });await worker.stop();return {area,publications,worker};
}
test('search filters, exact links, back/reload, keyboard and narrow layouts preserve personal state',async({page,context,server})=>{
  const data=await setup(page,context,server);
  const before=(await server.observer.query('SELECT count(*)::int AS n FROM loom.shared_activity')).rows[0].n;
  await page.goto(server.origin+'/loom/area/'+data.area);await page.getByRole('link',{name:'Search this topic'}).click();
  await page.getByLabel('Search terms').fill('zephyr');await page.getByLabel('Content kind').selectOption('artifact');await page.getByRole('button',{name:'Search shared text'}).focus();await page.keyboard.press('Enter');
  await expect(page.locator('.search-result')).toHaveCount(12);await expect(page.getByRole('heading',{name:'Search results'})).toBeFocused();
  expect(await page.locator('.search-result script').count()).toBe(0);await expect(page.locator('.search-result').first()).toContainText('<script>');
  const exact=page.locator('.search-result h3 a').first(),href=await exact.getAttribute('href');await exact.click();await expect(page).toHaveURL(server.origin+href);
  await expect(page.getByText('Zephyr browser text with exact meaning.',{exact:false}).first()).toBeVisible();
  await page.goBack();await expect(page.getByLabel('Search terms')).toHaveValue('zephyr');await expect(page.locator('.search-result')).toHaveCount(12);
  await page.getByRole('button',{name:'Next search results'}).click();await expect(page.locator('.search-result')).toHaveCount(2);const second=page.url();
  await page.reload();await expect(page.locator('.search-result')).toHaveCount(2);expect(page.url()).toBe(second);
  await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.getByRole('button',{name:'Refresh search',exact:true}).focus();await page.keyboard.press('Enter');await expect(page.locator('.search-result')).toHaveCount(12);
  expect((await server.observer.query('SELECT count(*)::int AS n FROM loom.saved_items')).rows[0].n).toBe(0);
  expect((await server.observer.query('SELECT count(*)::int AS n FROM loom.shared_activity')).rows[0].n).toBe(before);
});
test('unindexed edits show incomplete coverage and stale selection requires explicit refresh',async({page,context,server})=>{
  const data=await setup(page,context,server,2);
  await page.goto(server.origin+'/loom/search?q=zephyr&limit=1');await expect(page.locator('.search-result')).toHaveCount(1);
  const updated=data.publications[0]!;await api(page,'/api/v1/revisions',{idempotency_key:randomUUID(),resource_id:updated.resource_id,expected_revision_id:updated.revision_id,title:'Nebula new revision',content:content('Nebula new current content')});
  await page.getByRole('button',{name:'Next search results'}).click();await expect(page.getByRole('alert')).toContainText('changed or expired');
  await page.getByRole('button',{name:'Start a fresh search'}).click();await expect(page.locator('.search-result')).toHaveCount(1);
  await expect(page.getByRole('button',{name:'Start a fresh search'})).not.toBeVisible();await expect(page.getByText('Some current text is still being indexed.',{exact:false})).toBeVisible();
  await page.getByLabel('Search terms').fill('nebula');await page.getByRole('button',{name:'Search shared text'}).click();await expect(page.getByText('No indexed matches in this selection yet.',{exact:false})).toBeVisible();
  await data.worker.start();try{await data.worker.observeUntil(async()=> (await server.observer.query('SELECT revision_id FROM loom.search_documents WHERE resource_id=$1',[updated.resource_id])).rows[0].revision_id!==updated.revision_id);}finally{await data.worker.stop();}
  await page.getByRole('button',{name:'Refresh search',exact:true}).click();await expect(page.getByRole('link',{name:'Nebula new revision',exact:true})).toBeVisible();
  await server.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='suppressed' WHERE id=$1",[updated.resource_id]));
  await page.getByRole('button',{name:'Refresh search',exact:true}).click();await expect(page.locator('.search-result')).toHaveCount(0);
});
test('late query and page responses do not replace newer search or another destination',async({page,context,server})=>{
  await setup(page,context,server,14);
  const entered=barrier(),release=barrier();let held=false;
  await page.route('**/api/v1/search?**',async route=>{
    if(new URL(route.request().url()).searchParams.get('q')==='zephyr'&&!held){held=true;const response=await route.fetch();entered.release();await release.promise;await route.fulfill({response}).catch(()=>{});}else await route.continue();
  });
  try {
    await page.goto(server.origin+'/loom/search?q=zephyr');await entered.promise;
    await page.getByLabel('Search terms').fill('absent');await page.getByRole('button',{name:'Search shared text'}).click();await expect(page.getByText('No matching results in this selection.')).toBeVisible();release.release();
    await expect(page.locator('.search-result')).toHaveCount(0);await expect(page.getByLabel('Search terms')).toHaveValue('absent');
  }finally{release.release();await page.unrouteAll({behavior:'wait'});}
  await page.goto(server.origin+'/loom/search?q=zephyr');await expect(page.locator('.search-result')).toHaveCount(12);
  const pageEntered=barrier(),pageRelease=barrier();
  await page.route('**/api/v1/search?**',async route=>{if(new URL(route.request().url()).searchParams.has('cursor')){const response=await route.fetch();pageEntered.release();await pageRelease.promise;await route.fulfill({response}).catch(()=>{});}else await route.continue();});
  try{await page.getByRole('button',{name:'Next search results'}).click();await pageEntered.promise;await page.getByRole('link',{name:'Topics',exact:true}).first().click();pageRelease.release();await expect(page.getByRole('heading',{name:'Topics',exact:true})).toBeVisible();await expect(page.locator('.search-result')).toHaveCount(0);}
  finally{pageRelease.release();await page.unrouteAll({behavior:'wait'});}
});
test('late account search cannot reappear after sign-out; administrator can start a bounded rebuild',async({page,context,server})=>{
  await setup(page,context,server,2);
  await page.goto(server.origin+'/loom/admin');await page.getByRole('link',{name:'Search indexing',exact:true}).click();
  await page.getByRole('button',{name:'Rebuild index',exact:true}).click();
  await page.getByRole('dialog').getByRole('button',{name:'Rebuild index',exact:true}).click();await expect(page.getByText('Rebuild request acknowledged',{exact:true})).toBeVisible();
  expect((await server.observer.query('SELECT generation FROM loom.search_state')).rows[0].generation).toBe(2);
  const entered=barrier(),release=barrier();await page.route('**/api/v1/search?**',async route=>{const response=await route.fetch();entered.release();await release.promise;await route.fulfill({response}).catch(()=>{});});
  try {await page.goto(server.origin+'/loom/search?q=zephyr');await entered.promise;await page.getByRole('button',{name:'Sign out',exact:true}).click();
    const confirm=page.getByRole('button',{name:'Clear local drafts and sign out'});if(await confirm.isVisible())await confirm.click();
    await expect(page.getByRole('button',{name:'Sign in with passkey'})).toBeVisible();release.release();await expect(page.locator('.search-result')).toHaveCount(0);
  }finally{release.release();await page.unrouteAll({behavior:'wait'});}
});

test('author picker retains a suspended publication author through search and reload',async({page,context,server})=>{
  const data=await setup(page,context,server,2);
  const person=await api(page,'/api/v1/identity/accounts',{idempotency_key:randomUUID(),nickname:'retained_author',kind:'agent',role:'participant'});
  const credential=await api(page,'/api/v1/identity/credentials',{idempotency_key:randomUUID(),participant_id:person.participant_id,kind:'agent',purpose:null,label:'Author picker fixture',replace_credential_id:null});
  const author=httpClient(server.origin,await readFile(server.directory+'/cert.pem','utf8'),credential.secret);
  const published=await author.call('/api/v1/artifacts',{idempotency_key:randomUUID(),area_id:data.area,title:'Retained author manuscript',content:content('Zephyr retained authorship')});
  expect(published.status).toBe(201);
  await data.worker.start();try{await data.worker.observeUntil(async()=> (await server.observer.query('SELECT 1 FROM loom.search_documents WHERE resource_id=$1',[published.body.resource_id])).rowCount===1);}finally{await data.worker.stop();}
  await api(page,'/api/v1/identity/state',{idempotency_key:randomUUID(),participant_id:person.participant_id,state:'suspended',role:'participant'});
  await page.goto(server.origin+'/loom/search');await page.getByRole('button',{name:'Choose author',exact:true}).click();
  await expect(page.getByText('Loading authors…',{exact:true})).not.toBeVisible();
  const choose=page.getByRole('button',{name:'retained_author · agent',exact:true});await expect(choose).toBeVisible();
  await choose.focus();await page.keyboard.press('Enter');await page.getByLabel('Search terms').fill('zephyr');
  await page.getByRole('button',{name:'Search shared text'}).click();await expect(page.locator('.search-result')).toHaveCount(1);
  await expect(page.getByRole('link',{name:'Retained author manuscript',exact:true})).toHaveAttribute('href',`/loom/resource/${published.body.resource_id}/${published.body.revision_id}`);
  expect(new URL(page.url()).searchParams.get('author')).toBe(person.participant_id);
  await page.reload();await expect(page.locator('.search-result')).toHaveCount(1);
  await expect(page.getByText('Original author: retained_author',{exact:true})).toBeVisible();
});

test('search indexing observations, failed-page recovery and retry preserve bounded reads and processing meaning',async({page,context,server})=>{
 const data=await setup(page,context,server,28),review=await searchIndexingReview(page,'observations');
 const writes:any[]=[];page.on('request',request=>{if(/\/admin\/search\/(retry|rebuild)$/.test(request.url())&&request.method()==='POST')writes.push(request.postDataJSON());});
 await page.goto(server.origin+'/loom/admin');await expect(page.getByRole('link',{name:'Community settings',exact:true})).toBeVisible();await page.getByRole('link',{name:'Search indexing',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Search indexing',exact:true})).toBeVisible();await expect(page.getByText('No queued work observed',{exact:true})).toBeVisible();
 await review.capture('normal-status');
 const before=(await server.observer.query('SELECT generation FROM loom.search_state')).rows[0].generation;
 await page.route('**/api/v1/admin/search/health',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'service_unavailable',message:'Synthetic observation unavailable'}})}),{times:1});
 await page.getByRole('button',{name:'Refresh status',exact:true}).click();await expect(page.getByText(/Showing an earlier observation/)).toBeVisible();await expect(page.getByText('No queued work observed',{exact:true})).toBeVisible();
 await review.capture('refresh-failure',['A single health GET is deliberately fulfilled with HTTP 503. Earlier authorized observations remain.']);
 expect(writes).toHaveLength(0);expect((await server.observer.query('SELECT generation FROM loom.search_state')).rows[0].generation).toBe(before);
 await server.observer.query("UPDATE loom.search_state SET heartbeat_at=clock_timestamp()-interval '1 minute'");await page.getByRole('button',{name:'Refresh status',exact:true}).click();await expect(page.getByText('Worker unavailable',{exact:true})).toBeVisible();
 await review.capture('worker-unavailable',['The stopped synthetic worker heartbeat is aged beyond the existing server availability window; the real health endpoint supplies this state.']);
 await server.observer.query('UPDATE loom.search_state SET capacity_limited=true,heartbeat_at=clock_timestamp()');await page.getByRole('button',{name:'Refresh status',exact:true}).click();await expect(page.getByText('Capacity limited',{exact:true})).toBeVisible();
 await review.capture('capacity-limited',['The isolated synthetic search_state capacity flag is seeded true; no production limit is changed.']);
 const old=(await server.observer.query('SELECT id FROM loom.search_jobs ORDER BY id LIMIT 1')).rows[0].id;
 await api(page,'/api/v1/admin/search/rebuild',{expected_generation:1});await data.worker.start();try{await data.worker.observeUntil(async()=>(await api(page,'/api/v1/search/status')).indexing==='ready');}finally{await data.worker.stop();}
 const current=(await server.observer.query('SELECT id FROM loom.search_jobs WHERE generation=2 ORDER BY id LIMIT 2')).rows.map(r=>r.id);
 await server.observer.query("UPDATE loom.search_jobs SET state='failed',attempts=3,failure='processing_failed',claim_generation=claim_generation+1 WHERE id=ANY($1::uuid[])",[[old,...current]]);
 await page.getByRole('button',{name:'Refresh status',exact:true}).click();await expect(page.getByRole('article')).toHaveCount(3);await expect(page.getByText('Earlier index generation; this job cannot be retried.')).toBeVisible();
 const earlier=page.getByRole('article').filter({hasText:'Earlier index generation;'});await expect(earlier.getByRole('button',{name:'Retry job',exact:true})).toBeDisabled();
 await review.capture('failed-jobs',['Three existing synthetic jobs are seeded as failed, including one from generation 1. Health and failure pages are real authorized server responses.'],page.getByRole('heading',{name:'Failed jobs',exact:true}));
 const eligible=page.getByRole('article').filter({hasNotText:'Earlier index generation;'}).first();const target=(await api(page,'/api/v1/admin/search/failures')).items.find((j:any)=>j.generation===2);
 await eligible.getByRole('button',{name:'Retry job',exact:true}).focus();await page.keyboard.press('Enter');await expect(page.getByText('Retry request acknowledged',{exact:true})).toBeVisible();
 expect(writes.at(-1)).toEqual({id:target.id,claim_generation:target.claim_generation});expect((await server.observer.query('SELECT state,attempts,claim_generation FROM loom.search_jobs WHERE id=$1',[target.id])).rows[0]).toEqual({state:'pending',attempts:0,claim_generation:target.claim_generation+1});
 await data.worker.start();try{await data.worker.observeUntil(async()=>(await server.observer.query('SELECT state FROM loom.search_jobs WHERE id=$1',[target.id])).rows[0].state==='succeeded');}finally{await data.worker.stop();}
 await page.getByRole('button',{name:'Refresh status',exact:true}).click();await expect(page.getByRole('article')).toHaveCount(2);
 await server.observer.query("UPDATE loom.search_jobs SET state='failed',attempts=3,failure='processing_failed' WHERE generation=2");await page.getByRole('button',{name:'Refresh status',exact:true}).click();await expect(page.getByRole('article')).toHaveCount(25);
 const firstIds=(await api(page,'/api/v1/admin/search/failures')).items.map((j:any)=>j.id),after=firstIds.at(-1),requests:string[]=[];
 await page.route('**/api/v1/admin/search/failures?*',async route=>{requests.push(new URL(route.request().url()).searchParams.get('after')!);if(requests.length===1)await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'service_unavailable',message:'Synthetic page failure'}})});else await route.continue();});
 await page.getByRole('button',{name:'Next page',exact:true}).focus();await page.keyboard.press('Enter');await expect(page.getByRole('button',{name:'Retry this page',exact:true})).toBeVisible();await expect(page.getByRole('heading',{name:'Failed jobs',exact:true})).toBeFocused();
 await page.getByRole('button',{name:'Retry this page',exact:true}).click();await expect(page.getByRole('article')).toHaveCount(5);expect(requests).toEqual([after,after]);await expect(page.getByRole('heading',{name:'Failed jobs',exact:true})).toBeFocused();
 await page.getByRole('button',{name:'First page',exact:true}).focus();await page.keyboard.press('Enter');await expect(page.getByRole('article')).toHaveCount(25);await expect(page.getByRole('heading',{name:'Failed jobs',exact:true})).toBeFocused();expect(writes.filter(w=>'claim_generation' in w)).toHaveLength(1);
});

test('search indexing rebuild confirmation, exact recovery and authority withdrawal retain request custody',async({page,context,server})=>{
 await setup(page,context,server,2);const review=await searchIndexingReview(page,'maintenance');const writes:any[]=[];
 page.on('request',r=>{if(r.url().endsWith('/api/v1/admin/search/rebuild')&&r.method()==='POST')writes.push(r.postDataJSON());});
 await page.goto(server.origin+'/loom/admin/search');await expect(page.getByText('No queued work observed',{exact:true})).toBeVisible();
 const sourceBefore=(await server.observer.query('SELECT id FROM loom.revisions ORDER BY id')).rows,savedBefore=(await server.observer.query('SELECT * FROM loom.saved_items')).rows;
 const open=()=>page.getByRole('button',{name:'Rebuild index',exact:true}).click();
 await open();const dialog=page.getByRole('dialog',{name:'Rebuild shared-text index?'});await expect(dialog.getByRole('button',{name:'Cancel',exact:true})).toBeFocused();
 await review.capture('rebuild-confirmation');await dialog.getByRole('button',{name:'Cancel',exact:true}).click();await expect(page.getByRole('button',{name:'Rebuild index',exact:true})).toBeFocused();expect(writes).toHaveLength(0);
 await open();await dialog.getByRole('button',{name:'Rebuild index',exact:true}).click();await expect(page.getByText('Rebuild request acknowledged',{exact:true})).toBeVisible();await expect(page.getByText('Indexing in progress',{exact:true})).toBeVisible();
 await review.capture('rebuild-acknowledged',[],page.getByRole('region',{name:'Maintenance',exact:true}));expect((await server.observer.query('SELECT generation,scan_complete FROM loom.search_state')).rows[0]).toEqual({generation:2,scan_complete:false});
 await page.route('**/api/v1/admin/search/rebuild',async route=>{const response=await route.fetch();expect(response.status()).toBe(200);await route.abort('failed');},{times:1});
 await open();await dialog.getByRole('button',{name:'Rebuild index',exact:true}).click();await expect(page.getByText('Outcome not confirmed',{exact:true})).toBeVisible();expect(writes.at(-1)).toEqual({expected_generation:2});
 await review.capture('unresolved-maintenance',['The real rebuild response is deliberately dropped after the endpoint commits generation 3.'],page.getByRole('region',{name:'Maintenance',exact:true}));
 await page.reload();await expect(page.getByText('Outcome not confirmed',{exact:true})).toBeVisible();expect(writes).toHaveLength(2);await page.getByRole('button',{name:'Refresh status',exact:true}).click();expect(writes).toHaveLength(2);
 await page.getByRole('button',{name:'Retry same request',exact:true}).click();await expect(page.getByText('Rebuild request acknowledged',{exact:true})).toBeVisible();expect(writes[2]).toEqual(writes[1]);expect((await server.observer.query('SELECT generation FROM loom.search_state')).rows[0].generation).toBe(3);
 await page.route('**/api/v1/admin/search/rebuild',async route=>{const response=await route.fetch();expect(response.status()).toBe(200);await route.abort('failed');},{times:1});
 await open();await dialog.getByRole('button',{name:'Rebuild index',exact:true}).click();await expect(page.getByText('Outcome not confirmed',{exact:true})).toBeVisible();
 await api(page,'/api/v1/admin/search/rebuild',{expected_generation:4});await page.getByRole('button',{name:'Refresh status',exact:true}).click();await page.getByRole('button',{name:'Retry same request',exact:true}).click();await expect(page.getByText('The generation changed. The earlier request outcome is still unconfirmed.')).toBeVisible();expect(writes.at(-1)).toEqual({expected_generation:3});
 await review.capture('unresolved-generation-conflict',['A rebuild response is dropped after generation 4 commits; a separate authenticated request advances generation 5. Exact replay of generation 3 receives the real search_changed refusal.'],page.getByRole('region',{name:'Maintenance',exact:true}));
 expect((await server.observer.query('SELECT id FROM loom.revisions ORDER BY id')).rows).toEqual(sourceBefore);expect((await server.observer.query('SELECT * FROM loom.saved_items')).rows).toEqual(savedBefore);
 await server.observer.query("UPDATE loom.participants SET role='participant' WHERE id=$1",[server.administratorId]);await page.getByRole('button',{name:'Refresh status',exact:true}).click();await expect(page.getByText(/Operational observations were withdrawn/)).toBeVisible();await expect(page.getByText('Indexing in progress',{exact:true})).toHaveCount(0);
 const writesBefore=writes.length;await page.getByRole('button',{name:'Check access',exact:true}).click();await expect(page.getByText(/Administrator access is required/)).toBeVisible();expect(writes).toHaveLength(writesBefore);
 await server.observer.query("UPDATE loom.participants SET role='administrator' WHERE id=$1",[server.administratorId]);await page.getByRole('button',{name:'Check access',exact:true}).click();await expect(page.getByText('Indexing in progress',{exact:true})).toBeVisible();await expect(page.getByText('Outcome not confirmed',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Sign out',exact:true}).click();await page.getByRole('button',{name:'Clear local drafts and sign out',exact:true}).click();await expect(page.getByRole('button',{name:'Sign in with passkey'})).toBeVisible();expect(await page.evaluate(()=>Object.keys(localStorage).some(key=>key.startsWith('loom.search-maintenance.v1:')))).toBe(false);
});

test('search indexing contextual retry survives response loss and cross-tab acknowledgement on a full page',async({page,context,server})=>{
 const data=await setup(page,context,server,28);
 await server.observer.query("UPDATE loom.search_jobs SET state='failed',attempts=3,failure='processing_failed',claim_generation=claim_generation+1 WHERE generation=1");
 await page.goto(server.origin+'/loom/admin/search');await expect(page.getByRole('article')).toHaveCount(25);
 const target=(await api(page,'/api/v1/admin/search/failures')).items[0];
 const before=(await server.observer.query('SELECT id,state,attempts,claim_generation FROM loom.search_jobs ORDER BY id')).rows;
 const other=await context.newPage();await other.goto(server.origin+'/loom/admin/search');await expect(other.getByRole('article')).toHaveCount(25);
 const writes:any[]=[];for(const tab of [page,other])tab.on('request',r=>{if(r.url().endsWith('/api/v1/admin/search/retry')&&r.method()==='POST')writes.push(r.postDataJSON());});
 const entered=barrier(),release=barrier();
 await page.route('**/api/v1/admin/search/retry',async route=>{const response=await route.fetch();expect(response.status()).toBe(200);entered.release();await release.promise;await route.abort('failed');},{times:1});
 const failed=page.getByRole('region',{name:'Failed jobs',exact:true}),heading=failed.getByRole('heading',{name:'Failed jobs',exact:true});
 await heading.evaluate(element=>element.scrollIntoView({block:'start'}));const retry=failed.getByRole('article').first().getByRole('button',{name:'Retry job',exact:true});await retry.focus();const scrollBefore=await page.evaluate(()=>scrollY);
 await page.keyboard.press('Enter');await entered.promise;
 try{
  await expect(failed.getByText('Sending retry request…',{exact:true})).toBeVisible();await expect(retry).toBeDisabled();await expect(failed.getByRole('article')).toHaveCount(25);
  expect(await page.evaluate(()=>scrollY)).toBe(scrollBefore);expect(writes).toEqual([{id:target.id,claim_generation:target.claim_generation}]);
 }finally{release.release();}
 const feedback=failed.getByRole('region',{name:'Job retry',exact:true});
 await expect(feedback.getByText('Outcome not confirmed',{exact:true})).toBeVisible();await expect(feedback.getByRole('alert')).toBeVisible();await expect(feedback.getByRole('button',{name:'Retry same request',exact:true})).toBeEnabled();
 expect(await page.evaluate(()=>scrollY)).toBe(scrollBefore);
 const retained=()=>page.evaluate(()=>JSON.parse(Object.entries(localStorage).find(([key])=>key.startsWith('loom.search-maintenance.v1:'))![1]));
 const original=await retained();expect(original.state).toBe('uncertain');expect(original.request).toEqual({kind:'retry',body:writes[0]});
 const afterFirst=(await server.observer.query('SELECT * FROM loom.search_jobs ORDER BY id')).rows;
 const review=await searchIndexingReview(page,'followup');
 const injection=['Existing jobs in an isolated synthetic database are marked failed. Tab A receives no response after the real retry endpoint commits: Playwright deliberately holds then drops HTTP 200. Tab B uses the same authenticated browser context and replays the retained payload against the real endpoint.'];
 await review.capture('top-job-uncertain',injection,failed,{fullPage:false});
 await heading.evaluate(element=>element.scrollIntoView({block:'start'}));const beforeRecovery=await page.evaluate(()=>scrollY);
 await expect(other.getByRole('region',{name:'Job retry',exact:true}).getByText('Outcome not confirmed',{exact:true})).toBeVisible();
 await other.getByRole('button',{name:'Retry same request',exact:true}).focus();await other.keyboard.press('Enter');
 await expect(other.getByText('Retry request acknowledged',{exact:true})).toBeVisible();await expect(feedback.getByText('Retry request acknowledged',{exact:true})).toBeVisible();await expect(feedback.getByRole('alert')).toHaveCount(0);
 expect(await page.evaluate(()=>scrollY)).toBe(beforeRecovery);expect(writes).toEqual([original.request.body,original.request.body]);
 expect(await retained()).toEqual({...original,sequence:original.sequence+1,state:'acknowledged'});
 expect((await server.observer.query('SELECT * FROM loom.search_jobs ORDER BY id')).rows).toEqual(afterFirst);
 expect((await server.observer.query('SELECT id,state,attempts,claim_generation FROM loom.search_jobs ORDER BY id')).rows).toEqual(before.map(job=>job.id===target.id?{...job,state:'pending',attempts:0,claim_generation:job.claim_generation+1}:job));
 await review.capture('tab-a-recovered',injection,failed,{fullPage:false});
 await page.getByRole('button',{name:'Refresh status',exact:true}).click();await expect(failed.getByRole('article')).toHaveCount(25);
 await expect(failed.getByRole('article').filter({hasText:target.id})).toHaveCount(0);await expect(feedback.getByText('This job is not in the displayed failure page.',{exact:true})).toBeVisible();await expect(feedback.getByText('Retry request acknowledged',{exact:true})).toBeVisible();await expect(feedback.getByRole('alert')).toHaveCount(0);await expect(feedback).toContainText(target.id);expect(writes).toHaveLength(2);
 await other.close();
 // A later row also keeps its feedback in view, including after its automatic read removes it.
 const laterEntered=barrier(),laterRelease=barrier();
 await page.route('**/api/v1/admin/search/retry',async route=>{const response=await route.fetch();expect(response.status()).toBe(200);laterEntered.release();await laterRelease.promise;await route.fulfill({response});},{times:1});
 const later=failed.getByRole('article').nth(20);await later.scrollIntoViewIfNeeded();await later.getByRole('button',{name:'Retry job',exact:true}).focus();const laterScroll=await page.evaluate(()=>scrollY);
 await page.keyboard.press('Enter');await laterEntered.promise;
 try{await expect(feedback.getByText('Sending retry request…',{exact:true})).toBeVisible();expect(await page.evaluate(()=>scrollY)).toBe(laterScroll);}finally{laterRelease.release();}
 await expect(feedback.getByText('Retry request acknowledged',{exact:true})).toBeVisible();await expect(feedback.getByText('This job is not in the displayed failure page.',{exact:true})).toBeVisible();expect(await page.evaluate(()=>scrollY)).toBe(laterScroll);expect(writes).toHaveLength(3);
 // Refuse only the next maintenance custody write, preserving readable prior bytes.
 const refuseInitialWrite=()=>page.evaluate(()=>{const set=Storage.prototype.setItem;let refused=false;Storage.prototype.setItem=function(key,value){if(!refused&&key.startsWith('loom.search-maintenance.v1:')){refused=true;throw new DOMException('Synthetic initial persistence refusal','QuotaExceededError');}return set.call(this,key,value);};});
 const maintenancePosts:string[]=[];page.on('request',r=>{if(r.method()==='POST'&&/\/api\/v1\/admin\/search\/(retry|rebuild)$/.test(r.url()))maintenancePosts.push(r.postData()!);});
 const unsentReview=await searchIndexingReview(page,'unsent');
 const priorRetry=await retained();await refuseInitialWrite();await page.getByRole('button',{name:'Rebuild index',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'Rebuild index',exact:true}).click();
 const maintenance=page.getByRole('region',{name:'Maintenance',exact:true}),rebuildFeedback=maintenance.getByRole('region',{name:'Rebuild request',exact:true});
 await expect(rebuildFeedback.getByText('Request not sent',{exact:true})).toBeVisible();await expect(rebuildFeedback.getByRole('alert')).toContainText('could not be saved');await expect(failed.getByRole('alert')).toHaveCount(0);expect(await retained()).toEqual(priorRetry);expect(maintenancePosts).toEqual([]);
 await unsentReview.capture('rebuild-not-sent',['Deliberately refuse the initial localStorage write before a new rebuild. The prior acknowledged job-retry record remains readable and unchanged. No new POST is sent.'],maintenance,{fullPage:false});
 await page.getByRole('button',{name:'Rebuild index',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'Rebuild index',exact:true}).click();await expect(rebuildFeedback.getByText('Rebuild request acknowledged',{exact:true})).toBeVisible();expect(maintenancePosts).toHaveLength(1);
 await expect(page.getByText('Indexing in progress',{exact:true})).toBeVisible();await data.worker.start();try{await data.worker.observeUntil(async()=>(await server.observer.query('SELECT count(*)::int AS n FROM loom.search_jobs WHERE generation=2')).rows[0].n===29);}finally{await data.worker.stop();}
 await server.observer.query("UPDATE loom.search_jobs SET state='succeeded',failure=NULL WHERE generation=1 AND state='failed'");await server.observer.query("UPDATE loom.search_jobs SET state='failed',attempts=3,failure='processing_failed',claim_generation=claim_generation+1 WHERE generation=2");await page.getByRole('button',{name:'Refresh status',exact:true}).click();await expect(failed.getByRole('article')).toHaveCount(25);
 const priorRebuild=await retained();await refuseInitialWrite();await failed.getByRole('article').first().getByRole('button',{name:'Retry job',exact:true}).click();
 await expect(feedback.getByText('Request not sent',{exact:true})).toBeVisible();await expect(feedback.getByRole('alert')).toContainText('could not be saved');await expect(maintenance.getByRole('alert')).toHaveCount(0);expect(await retained()).toEqual(priorRebuild);expect(maintenancePosts).toHaveLength(1);
 expect((await server.observer.query('SELECT generation FROM loom.search_state')).rows[0].generation).toBe(2);
 await unsentReview.capture('job-retry-not-sent',['After the real worker discovers generation 2, seed its jobs as failed and retire earlier synthetic failures. Deliberately refuse the initial localStorage write before a new job retry. The prior acknowledged rebuild record remains readable and unchanged. No new POST is sent.'],failed,{fullPage:false});
});
