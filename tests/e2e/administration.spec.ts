import { test, expect } from '../helpers/browser-fixtures.js';
import { setup } from '../helpers/change-browser.js';
import { populateAdministration, administrationTarget } from '../helpers/administration.js';
import type { Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { settingsReview } from '../helpers/community-settings-review.js';
import { journal } from '../helpers/change-browser.js';
const click=(page:Page,name:string)=>page.getByRole('button',{name,exact:true}).click();
function barrier(){let release!:()=>void;const promise=new Promise<void>(r=>release=r);return{promise,release};}

test('community settings conflict recovery and bounded picker navigation',async({page,context,server})=>{
 const f=await setup(page,context,server);await server.observer.query("UPDATE loom.participants SET role='administrator' WHERE id=$1",[f.person]);
 const initial=(await f.admin.call('/api/v1/community')).body;expect(initial.settings_version).toBe(1);
 let savedTopic='';
 for(let i=1;i<=18;i++){
  const hierarchy=(await f.admin.call('/api/v1/organization/children?limit=1')).body.hierarchy_version;
  const r=await f.admin.call('/api/v1/organization/changes',{idempotency_key:randomUUID(),kind:'area.create',title:'Navigation topic '+String(i).padStart(2,'0'),parent_id:null,description:'Synthetic picker navigation',expected_hierarchy_version:hierarchy});
  expect(r.status).toBe(200);savedTopic=r.body.current.resource_id;
 }
 await page.goto(server.origin+'/loom/admin/community');
 const form=page.getByRole('form',{name:'Community settings'}),overview=page.getByRole('region',{name:'Community overview',exact:true});
 await click(page,'Change community overview');await click(page,'Choose Target R1 in General');
 await expect(overview.getByText('Target R1',{exact:true})).toBeVisible();await expect(form.getByText('Unsaved changes',{exact:true})).toBeVisible();
 const review=await settingsReview(page,'ui-02-followup');
 expect((await f.admin.call('/api/v1/community/settings',{idempotency_key:randomUUID(),expected_version:1,community_name:initial.community_name,overview_id:initial.overview.resource_id,proposal_area_id:savedTopic})).status).toBe(200);
 const writes:any[]=[];page.on('request',r=>{if(r.url().endsWith('/community/settings')&&r.method()==='POST')writes.push(r.postDataJSON());});
 await page.route('**/api/v1/community/settings',async route=>{
  const response=await route.fetch();expect(response.status()).toBe(409);expect((await response.json()).error.code).toBe('revision_conflict');await route.abort('failed');
 },{times:1});
 await click(page,'Save changes');await expect(page.getByRole('button',{name:'Retry same save',exact:true})).toBeEnabled();
 const retained=await journal(page,'community.settings');expect(retained.state).toBe('uncertain');expect(retained.body.expected_version).toBe(1);expect(writes).toHaveLength(1);
 const replay=page.waitForResponse(r=>r.url().endsWith('/community/settings'));await click(page,'Retry same save');expect((await replay).status()).toBe(409);
 expect(writes).toHaveLength(2);expect(writes[1]).toEqual(writes[0]);expect(writes[1]).toEqual(retained.body);
 await expect(form.getByText(/Community settings changed while/)).toBeVisible();await expect(form.getByText('Unsaved changes',{exact:true})).toBeVisible();await expect(overview.getByText('Target R1',{exact:true})).toBeVisible();
 expect(await journal(page,'community.settings')).toBeUndefined();await expect(page.getByRole('button',{name:'Retry same save',exact:true})).toHaveCount(0);
 expect((await f.admin.call('/api/v1/community')).body.settings_version).toBe(2);
 expect((await server.observer.query('SELECT id FROM loom.participation_audit WHERE actor_id=$1 AND operation_kind=$2 AND idempotency_key=$3',[f.person,'community.settings',retained.key])).rowCount).toBe(0);
 const conflictInjection=['The initial real server revision_conflict (HTTP 409) was deliberately dropped. The exact retained request was retried and its live HTTP 409 delivered.'];
 await review.capture('recovered-conflict',conflictInjection);
 await click(page,'Check saved settings');const comparison=page.getByRole('region',{name:'Saved choices'});
 await expect(comparison.getByText('Navigation topic 18',{exact:true}).first()).toBeVisible();await expect(comparison.getByText('Loading selection…')).toHaveCount(0);
 await expect(form.getByText('Saved choices checked. Your unsaved choices are unchanged.',{exact:true})).toBeVisible();await expect(overview.getByText('Target R1',{exact:true})).toBeVisible();expect(writes).toHaveLength(2);
 await review.capture('saved-comparison',conflictInjection);
 // Deliberately reduce page size for a long traversal; responses and opaque cursors still come from the real authorized endpoint.
 const choicesPattern='**/api/v1/organization/destinations?*';const pageRequests:string[]=[];
 await page.route(choicesPattern,async route=>{
  const url=new URL(route.request().url());expect(url.searchParams.get('limit')).toBe('12');pageRequests.push(url.searchParams.get('cursor')??'first');
  url.searchParams.set('limit','1');const response=await route.fetch({url:url.href});expect(response.status()).toBe(200);await route.fulfill({response});
 });
 const opener=page.getByRole('button',{name:'Change proposal topic',exact:true});await opener.focus();await page.keyboard.press('Enter');
 const dialog=page.getByRole('dialog',{name:'Choose a proposal topic'}),heading=dialog.getByRole('heading',{name:'Choose a proposal topic'});
 const first=dialog.locator('.community-resource-identity h3');await expect(first).toHaveCount(1);const firstTitle=await first.innerText();
 const startReads=pageRequests.length;
 for(let i=0;i<18;i++){
  const title=await first.innerText();await dialog.getByRole('button',{name:'Next choices',exact:true}).focus();await page.keyboard.press('Enter');
  await expect(first).not.toHaveText(title);await expect(heading).toBeFocused();
 }
 expect(pageRequests).toHaveLength(startReads+18);
 const pagingInjection=['Playwright changes the requested destination limit from 12 to 1 to exercise 19 real server pages. Responses, authorization and opaque cursors are live; no choice data is mocked.'];
 await review.capture('picker-page-19',pagingInjection);
 await dialog.getByRole('button',{name:'First choices',exact:true}).focus();await page.keyboard.press('Enter');await expect(first).toHaveText(firstTitle);await expect(heading).toBeFocused();
 await expect(dialog.getByRole('button',{name:'Previous choices',exact:true})).toBeDisabled();expect(pageRequests).toHaveLength(startReads+19);
 await review.capture('picker-first-page',pagingInjection);await page.keyboard.press('Escape');await expect(opener).toBeFocused();await page.unroute(choicesPattern);
 await expect(overview.getByText('Target R1',{exact:true})).toBeVisible();await expect(form.getByText('Unsaved changes',{exact:true})).toBeVisible();
 page.once('dialog',d=>{review.dialog('accept',d.message());return d.accept();});await click(page,'Load saved settings');await expect(form.getByText('Saved settings loaded.',{exact:true})).toBeVisible();await expect(form.getByText('Unsaved changes',{exact:true})).toHaveCount(0);expect(writes).toHaveLength(2);
});

async function checkConfiguration(page:Page,f:Awaited<ReturnType<typeof setup>>,server:Parameters<typeof setup>[2]){
 const createArea=async(title:string,parent_id:string|null)=>{
  const hierarchy=(await f.admin.call('/api/v1/organization/children?limit=1')).body.hierarchy_version;
  const response=await f.admin.call('/api/v1/organization/changes',{idempotency_key:randomUUID(),kind:'area.create',title,parent_id,description:'Synthetic settings review',expected_hierarchy_version:hierarchy});expect(response.status).toBe(200);return response.body.current.resource_id as string;
 };
 const research=await createArea('Research',null),generalProposals=await createArea('Proposals',f.area),researchProposals=await createArea('Proposals',research);
 const createOverview=async(area_id:string)=>{const r=await f.admin.call('/api/v1/artifacts',{idempotency_key:randomUUID(),area_id,title:'Community introduction',content:{format:'loom-markdown-v1',text:'Synthetic community introduction for settings review.',mentions:[]}});expect(r.status).toBe(201);return r.body.resource_id as string;};
 const generalOverview=await createOverview(f.area),researchOverview=await createOverview(research);
 const initial=(await f.admin.call('/api/v1/community')).body;
 expect((await f.admin.call('/api/v1/community/settings',{idempotency_key:randomUUID(),expected_version:initial.settings_version,community_name:'Synthetic research commons',overview_id:generalOverview,proposal_area_id:generalProposals})).status).toBe(200);
 const base=initial.settings_version+1;
 await page.goto(server.origin+'/loom/admin');
 await expect(page.getByRole('heading',{name:'Administration',exact:true})).toBeVisible();
 await expect(page.getByRole('link',{name:'Search indexing',exact:true})).toBeVisible();
 const review=await settingsReview(page);await review.capture('administration-entry');
 await page.getByRole('link',{name:'Community settings',exact:true}).click();
 await expect(page).toHaveURL(server.origin+'/loom/admin/community');
 const panel=page.getByRole('form',{name:'Community settings'}),overview=page.getByRole('region',{name:'Community overview',exact:true}),proposal=page.getByRole('region',{name:'Proposal topic',exact:true});
 await expect(overview.getByText('General',{exact:true})).toBeVisible();await expect(proposal.getByText('General › Proposals',{exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'Save changes',exact:true})).toBeDisabled();
 await expect(page.getByRole('link',{name:'Search indexing',exact:true})).toHaveCount(0);await expect(panel).not.toContainText(generalOverview);
 await review.capture('loaded');
 const writes:any[]=[];let reads=0;
 page.on('request',r=>{if(r.url().endsWith('/community/settings')&&r.method()==='POST')writes.push(r.postDataJSON());if(r.url().endsWith('/api/v1/community')&&r.method()==='GET')reads++;});
 const changeTopic=page.getByRole('button',{name:'Change proposal topic',exact:true});await changeTopic.focus();await page.keyboard.press('Enter');
 const picker=page.getByRole('dialog',{name:'Choose a proposal topic'});
 await expect(picker.getByRole('button',{name:'Choose Proposals in General › Proposals',exact:true})).toBeVisible();
 await expect(picker.getByRole('button',{name:'Choose Proposals in Research › Proposals',exact:true})).toBeVisible();
 await expect.poll(()=>picker.evaluate(dialog=>dialog.contains(document.activeElement))).toBe(true);
 await page.getByRole('button',{name:'Close resource picker'}).focus();await page.keyboard.press('Shift+Tab');await expect.poll(()=>picker.evaluate(dialog=>dialog.contains(document.activeElement))).toBe(true);
 await review.capture('topic-picker');await page.keyboard.press('Escape');await expect(changeTopic).toBeFocused();
 await click(page,'Change proposal topic');await page.getByRole('button',{name:'Choose Proposals in Research › Proposals',exact:true}).focus();await page.keyboard.press('Enter');
 await expect(proposal.getByText('Research › Proposals',{exact:true})).toBeVisible();const beforeCancel=reads;await click(page,'Cancel');expect(reads).toBe(beforeCancel);expect(writes).toEqual([]);
 const selectOverview=async(location:string)=>{await click(page,'Change community overview');await page.getByRole('button',{name:'Choose Community introduction in '+location,exact:true}).focus();await page.keyboard.press('Enter');};
 await selectOverview('Research');await expect(overview.getByText('Research',{exact:true})).toBeVisible();await expect(panel.getByText('Unsaved changes',{exact:true})).toBeVisible();await review.capture('dirty');
 page.once('dialog',async dialog=>{expect(dialog.message()).toContain('Discard unsaved Community settings');review.dialog('cancel',dialog.message());await dialog.dismiss();});
 await page.getByRole('navigation',{name:'Breadcrumb'}).getByRole('link',{name:'Administration'}).click();await expect(page).toHaveURL(server.origin+'/loom/admin/community');
 expect((await f.admin.call('/api/v1/community/settings',{idempotency_key:randomUUID(),expected_version:base,community_name:'Synthetic research commons',overview_id:generalOverview,proposal_area_id:researchProposals})).status).toBe(200);
 const conflict=page.waitForResponse(r=>r.url().endsWith('/community/settings'));await click(page,'Save changes');expect((await conflict).status()).toBe(409);
 expect(writes[0].expected_version).toBe(base);await expect(panel.getByText(/Community settings changed while/)).toBeVisible();await expect(overview.getByText('Research',{exact:true})).toBeVisible();await review.capture('version-conflict');
 const entered=barrier(),release=barrier(),refreshed=barrier();
 await page.route('**/api/v1/community',async route=>{const response=await route.fetch();entered.release();await release.promise;await route.fulfill({response});refreshed.release();},{times:1});
 await click(page,'Check saved settings');await entered.promise;
 try{await expect(overview.getByText('Research',{exact:true})).toBeVisible();await expect(panel.getByText('Unsaved changes',{exact:true})).toBeVisible();expect(writes).toHaveLength(1);}finally{release.release();}
 await refreshed.promise;
 await expect(panel.getByText(/Community settings changed while/)).toBeVisible();
 await page.route('**/api/v1/community',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'service_unavailable',message:'Synthetic configuration refresh failure'}})}),{times:1});
 await click(page,'Check saved settings');await expect(page.getByText('Synthetic configuration refresh failure')).toBeVisible();expect(writes).toHaveLength(1);
 await review.capture('refresh-error',['One GET /api/v1/community is deliberately replaced with HTTP 503. The settings conflict is a live server 409 after a competing administrator write.']);
 page.once('dialog',async dialog=>{review.dialog('cancel',dialog.message());await dialog.dismiss();});await click(page,'Load saved settings');await expect(overview.getByText('Research',{exact:true})).toBeVisible();
 const reloadEntered=barrier(),releaseReload=barrier();
 await page.route('**/api/v1/community',async route=>{expect(route.request().method()).toBe('GET');const response=await route.fetch();expect(response.status()).toBe(200);reloadEntered.release();await releaseReload.promise;await route.fulfill({response});},{times:1});
 page.once('dialog',dialog=>{review.dialog('accept',dialog.message());return dialog.accept();});await page.getByRole('button',{name:'Load saved settings',exact:true}).focus();await page.keyboard.press('Enter');await reloadEntered.promise;
 try{await expect(overview.getByText('Research',{exact:true})).toBeVisible();await expect(panel.getByText('Unsaved changes',{exact:true})).toBeVisible();await expect(page.getByText('Synthetic configuration refresh failure')).toBeVisible();expect(writes).toHaveLength(1);}finally{releaseReload.release();}
 await expect(overview.getByText('General',{exact:true})).toBeVisible();await expect(proposal.getByText('Research › Proposals',{exact:true})).toBeVisible();
 await expect(panel.getByText('Unsaved changes',{exact:true})).toHaveCount(0);await expect(panel.getByText('Saved settings loaded.',{exact:true})).toBeVisible();await expect(page.getByText('Synthetic configuration refresh failure')).toHaveCount(0);expect(writes).toHaveLength(1);
 await review.capture('recovered',['The earlier HTTP 503 was injected; this explicit reload is a live successful GET.']);
 await selectOverview('Research');await click(page,'Save changes');await expect(panel.getByText('Changes saved.',{exact:true})).toBeVisible();expect(writes[1].expected_version).toBe(base+1);
 const saved=(await f.admin.call('/api/v1/community')).body;expect(saved.settings_version).toBe(base+2);expect(saved.overview.resource_id).toBe(researchOverview);expect(saved.proposal_area.resource_id).toBe(researchProposals);
 await review.capture('saved');
 // Commit succeeds but the browser deliberately loses its response. Recovery must replay exactly.
 await selectOverview('General');
 await page.route('**/api/v1/community/settings',async route=>{const response=await route.fetch();expect(response.status()).toBe(200);await route.abort('failed');},{times:1});
 await click(page,'Save changes');await expect(page.getByRole('button',{name:'Retry same save',exact:true})).toBeEnabled();const uncertain=await journal(page,'community.settings');expect(uncertain.state).toBe('uncertain');
 await review.capture('unresolved-save',['A real committed settings POST response is deliberately aborted before delivery to the browser.']);
 const count=writes.length;await page.reload();await expect(page.getByRole('button',{name:'Retry same save',exact:true})).toBeEnabled();expect(writes).toHaveLength(count);
 await click(page,'Retry same save');await expect(panel.getByText('Changes saved.',{exact:true})).toBeVisible();expect(writes.at(-1)).toEqual(uncertain.body);expect(await journal(page,'community.settings')).toBeUndefined();
 // A failed metadata lookup is not an empty designation.
 await page.route('**/api/v1/organization/resources/'+generalOverview,route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'service_unavailable',message:'Synthetic selection lookup failure'}})}),{times:1});
 await page.reload();await expect(overview.getByText('Could not load this selection.')).toBeVisible();await expect(overview.getByText('No selection yet.')).toHaveCount(0);
 await overview.getByRole('button',{name:'Retry resource lookup'}).click();await expect(overview.getByText('General',{exact:true})).toBeVisible();
 // The draft is private input, not authority: a real role withdrawal hides metadata and fences dispatch.
 await selectOverview('Research');await server.observer.query("UPDATE loom.participants SET role='participant' WHERE id=$1",[f.person]);
 await click(page,'Save changes');await expect(panel.getByText(/Access changed/)).toBeVisible();await expect(overview.getByText('Research',{exact:true})).toHaveCount(0);await expect(panel.getByText('Unsaved changes',{exact:true})).toBeVisible();
 const deniedCount=writes.length;await click(page,'Check access');await expect(panel.getByText(/Administrator access is required/)).toBeVisible();expect(writes).toHaveLength(deniedCount);
 await server.observer.query("UPDATE loom.participants SET role='administrator' WHERE id=$1",[f.person]);await click(page,'Check access');await expect(overview.getByText('Research',{exact:true})).toBeVisible();
 await click(page,'Cancel');await expect(overview.getByText('General',{exact:true})).toBeVisible();expect(writes).toHaveLength(deniedCount);
 await page.getByRole('navigation',{name:'Breadcrumb'}).getByRole('link',{name:'Administration'}).click();
 // Let the shell's navigation discovery and the dependent account page settle before the next fault injection.
 await page.waitForLoadState('networkidle');await expect(page.getByRole('heading',{name:'Administration',exact:true})).toBeVisible();
}

test('administrator rate controls retain a lost decision through reload and recover original versus current policy',async({page,context,server})=>{
 await server.observer.query('UPDATE loom.participation_rate_policy SET ordinary_requests=120,new_publications=20,recovery_control=60 WHERE id=1');
 const f=await setup(page,context,server);await server.observer.query("UPDATE loom.participants SET role='administrator' WHERE id=$1",[f.person]);
 await page.goto(server.origin+'/loom/admin');await click(page,'Inspect participation limits');await expect(page.getByText(/Current policy version 1/)).toBeVisible();
 await page.setViewportSize({width:390,height:844});await page.getByLabel(/Ordinary requests per minute/).fill('7');
 await expect.poll(async()=>(await journal(page,'participation.rates'))?.body.ordinary_requests).toBe(7);
 await page.route('**/api/v1/admin/participation-rates/state',async route=>{const response=await route.fetch();expect(response.status()).toBe(200);await route.abort('failed');},{times:1});
 await click(page,'Save participation limits');await expect(page.getByRole('button',{name:'Check limits status'})).toBeEnabled();
 const uncertain=await journal(page,'participation.rates');expect(uncertain.state).toBe('uncertain');
 const current=(await f.admin.call('/api/v1/admin/participation-rates')).body;
 expect((await f.admin.call('/api/v1/admin/participation-rates/state',{idempotency_key:randomUUID(),expected_version:current.version,ordinary_requests:8,new_publications:20,recovery_control:60})).status).toBe(200);
 await page.reload();await expect(page.getByRole('button',{name:'Check limits status'})).toBeVisible();expect((await journal(page,'participation.rates')).body).toEqual(uncertain.body);
 const status=page.getByRole('button',{name:'Check limits status'});await status.focus();await page.keyboard.press('Enter');await expect(page.getByText(/Recorded policy version 2; current version at recovery 3/)).toBeVisible();
 expect(await journal(page,'participation.rates')).toBeUndefined();await click(page,'Inspect rate policy audit');await expect(page.getByText(/Version 3: 8 ordinary/)).toBeVisible();
 expect((await f.admin.call('/api/v1/admin/participation-rates')).body.ordinary_requests).toBe(8);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 // File policy uses the same production administration host and durable journal.
 const panel=page.locator('section').filter({has:page.getByRole('heading',{name:'File upload and storage limits',exact:true})});
 await panel.getByRole('button',{name:'Inspect file limits',exact:true}).click();
 await expect(panel.getByText(/Current policy version 1/)).toBeVisible();
 await panel.getByLabel('Maximum newly admitted file size (bytes)').fill('8');
 await expect.poll(async()=>(await journal(page,'file.policy'))?.body.max_file_bytes).toBe(8);
 await page.route('**/api/v1/admin/file-limits/state',async route=>{const response=await route.fetch();expect(response.status()).toBe(200);await route.abort('failed');},{times:1});
 await panel.getByRole('button',{name:'Save file limits',exact:true}).click();
 await expect(panel.getByRole('button',{name:'Check limits status',exact:true})).toBeEnabled();
 const fileIntent=await journal(page,'file.policy');expect(fileIntent.state).toBe('uncertain');
 const updateFile=async(patch:Record<string,number>)=>{const {version,...limits}=(await f.admin.call('/api/v1/admin/file-limits')).body.policy;expect((await f.admin.call('/api/v1/admin/file-limits/state',{...limits,...patch,expected_version:version,idempotency_key:randomUUID()})).status).toBe(200);};
 await updateFile({max_file_bytes:9});await page.reload();
 await expect(panel.getByRole('button',{name:'Check limits status',exact:true})).toBeVisible();
 expect((await journal(page,'file.policy')).body).toEqual(fileIntent.body);
 await panel.getByRole('button',{name:'Check limits status',exact:true}).focus();await page.keyboard.press('Enter');
 await expect(panel.getByText(/Recorded policy version 2; current version at recovery 3/)).toBeVisible();
 await panel.getByLabel('Maximum newly admitted file size (bytes)').fill('10');
 await expect.poll(async()=>(await journal(page,'file.policy'))?.body.max_file_bytes).toBe(10);
 await updateFile({max_file_bytes:11});await panel.getByRole('button',{name:'Save file limits',exact:true}).click();
 await expect(panel.getByRole('button',{name:'Prepare corrected limits',exact:true})).toBeVisible();
 const conflict=await journal(page,'file.policy');await page.reload();expect((await journal(page,'file.policy')).body).toEqual(conflict.body);
 await panel.getByRole('button',{name:'Refresh file limits',exact:true}).click();await expect(panel.getByText(/Current policy version 4/)).toBeVisible();
 await panel.getByRole('button',{name:'Prepare corrected limits',exact:true}).click();
 await expect.poll(async()=>(await journal(page,'file.policy'))?.state).toBe('draft');
 expect((await journal(page,'file.policy')).key).not.toBe(conflict.key);
 await panel.getByRole('button',{name:'Save file limits',exact:true}).click();await expect(panel.getByText(/Recorded policy version 5/)).toBeVisible();
 await panel.getByRole('button',{name:'Inspect file policy audit',exact:true}).click();await expect(panel.getByText(/Version 5: maximum file 10 bytes/)).toBeVisible();
 const heldPolicy=barrier(),releasePolicy=barrier();
 await page.route('**/api/v1/admin/file-limits',async route=>{const response=await route.fetch();heldPolicy.release();await releasePolicy.promise;await route.fulfill({response});},{times:1});
 await panel.getByRole('button',{name:'Refresh file limits',exact:true}).click();await heldPolicy.promise;
 await server.observer.query("UPDATE loom.participants SET role='participant' WHERE id=$1",[f.person]);
 try{await panel.getByRole('button',{name:'Inspect file policy audit',exact:true}).click();await expect(panel.getByText(/Current policy version/)).toHaveCount(0);}finally{releasePolicy.release();}
 await expect(panel.getByText(/Current policy version/)).toHaveCount(0);await expect(panel.getByText(/Community reserved file bytes/)).toHaveCount(0);

 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);

});

test('compiled composer preserves a committed lost response through temporary throttling and reload without rekeying',async({page,context,server})=>{
 const f=await setup(page,context,server),policyPath='/api/v1/admin/participation-rates';
 const set=async(ordinary:number)=>{const current=(await f.admin.call(policyPath)).body;expect((await f.admin.call(policyPath+'/state',{idempotency_key:randomUUID(),expected_version:current.version,ordinary_requests:ordinary,new_publications:1,recovery_control:120})).status).toBe(200);};
 await set(120);await page.goto(server.origin+`/loom/area/${f.area}?compose=artifacts`);
 await page.getByLabel('Title',{exact:true}).fill('Throttle recovery artifact');await page.getByLabel('Text',{exact:true}).fill('Keep the exact browser command.');
 await expect.poll(async()=>(await journal(page,'artifact.create'))?.body.content.text).toBe('Keep the exact browser command.');
 const sent:string[]=[];
 await page.route('**/api/v1/artifacts',async route=>{if(route.request().method()!=='POST'){await route.continue();return;}sent.push(route.request().postData()!);const response=await route.fetch();expect(response.status()).toBe(201);await route.abort('failed');},{times:1});
 await click(page,'Publish');await expect(page.getByRole('button',{name:'Check status',exact:true})).toBeEnabled();const uncertain=await journal(page,'artifact.create');expect(uncertain.state).toBe('uncertain');
 await set(1);await click(page,'Retry same publication');await expect(page.getByText(/Temporary participation limit/)).toBeVisible();
 expect((await journal(page,'artifact.create')).body).toEqual(uncertain.body);await expect(page.getByLabel('Text',{exact:true})).toHaveValue('Keep the exact browser command.');
 await page.reload();expect((await journal(page,'artifact.create')).body).toEqual(uncertain.body);expect((await journal(page,'artifact.create')).state).toBe('uncertain');
 await page.goto(server.origin+'/loom/help');await expect(page.getByRole('button',{name:'Check publication status',exact:true})).toBeEnabled();
 expect((await page.request.get(server.origin+'/api/v1/areas')).status()).toBe(429);
 await click(page,'Check publication status');await expect(page.getByText('Publication confirmed. Your exact local record is retained.',{exact:true})).toBeVisible();
 const confirmed=await journal(page,'artifact.create');expect(confirmed.body).toEqual(uncertain.body);expect(confirmed.key).toBe(uncertain.key);
 expect((await server.observer.query("SELECT used FROM loom.participation_rate_windows WHERE participant_id=$1 AND category='new_publications'",[f.person])).rows[0].used).toBe(1);
 expect((await server.observer.query("SELECT count(*)::int n FROM loom.idempotency_records WHERE participant_id=$1 AND operation_kind='artifact.create'",[f.person])).rows[0].n).toBe(1);
});
async function begin(page:Page,context:Parameters<typeof setup>[1],server:Parameters<typeof setup>[2]){
 const f=await setup(page,context,server);
 await server.observer.query("UPDATE loom.participants SET role='administrator' WHERE id=$1",[f.person]);
 await populateAdministration(server);await page.goto(server.origin+'/loom/admin');await expect(page.getByRole('heading',{name:'Administration',exact:true})).toBeVisible();
 await page.getByText('Participant accounts',{exact:true}).click();await expect(page.getByRole('button',{name:'Manage credentials'}).first()).toBeVisible();return f;
}
test('bounded administrative browsing reaches later accounts, credential history and audit with keyboard, retries and stable-ID actions',async({page,context,server})=>{
 const f=await begin(page,context,server);await checkConfiguration(page,f,server);
 await page.getByText('Participant accounts',{exact:true}).click();await expect(page.getByRole('button',{name:'Manage credentials'}).first()).toBeVisible();
 await page.setViewportSize({width:390,height:844});
 // Fail one actual next-page read and preserve the first page and focused control.
 const first=await page.getByRole('button',{name:'Manage credentials'}).count();expect(first).toBeLessThanOrEqual(25);
 const next=page.getByRole('button',{name:'Next accounts page',exact:true});await next.focus();
 await page.route('**/api/v1/identity/accounts/query',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'service_unavailable',message:'Fixture page unavailable',recovery:{action:'retry_same_request'}}})}),{times:1});
 await page.keyboard.press('Enter');await expect(page.getByText('Fixture page unavailable')).toBeVisible();await expect(next).toBeFocused();expect(await page.getByRole('button',{name:'Manage credentials'}).count()).toBe(first);
 const requests:any[]=[];page.on('request',r=>{if(r.url().endsWith('/identity/accounts/query'))requests.push(r.postDataJSON());});
 await click(page,'Retry accounts page');await expect(page.getByText('Fixture page unavailable')).toHaveCount(0);
 for(let n=0;n<8&&!await page.getByText('browse_target · agent · active',{exact:true}).count();n++){await click(page,'Next accounts page');await expect(page.getByText('Loading accounts page…')).toHaveCount(0);}
 await expect(page.getByText('browse_target · agent · active',{exact:true})).toBeVisible();expect(requests.length).toBeGreaterThanOrEqual(4);
 const target=page.locator('.list-row').filter({has:page.getByText('browse_target · agent · active',{exact:true})});await target.getByRole('button',{name:'Manage credentials'}).click();await page.getByText('Credentials for this account',{exact:true}).click();
 const nextCredentials=page.getByRole('button',{name:'Next credentials page',exact:true});await expect(page.getByText(/History 1 Ω/)).toBeVisible();
 for(let n=0;n<5;n++){await click(page,'Next credentials page');await expect(page.getByText(new RegExp('History '+((n+1)*25+1)+' Ω'))).toBeVisible();}
 await expect(page.getByText(/History 134 Ω/)).toBeVisible();expect(await page.locator('.list-row').filter({has:page.getByText(/History /)}).count()).toBeLessThanOrEqual(25);await expect(nextCredentials).toHaveAttribute('aria-disabled','true');
 const row=page.locator('.list-row').filter({has:page.getByText(/History 134 Ω/)});await row.getByRole('button',{name:'Revoke',exact:true}).click();
 await expect.poll(async()=> (await server.observer.query("SELECT state FROM loom.participant_credentials WHERE id='20000000-0000-4000-8000-000000000134'")).rows[0].state).toBe('revoked');
 await target.getByRole('button',{name:'Suspend',exact:true}).click();await expect.poll(async()=> (await server.observer.query('SELECT state FROM loom.participants WHERE id=$1',[administrationTarget])).rows[0].state).toBe('suspended');
 await page.getByLabel('Exact account ID or nickname').fill('BROWSE_TARGET');await click(page,'Find account');await expect(page.getByText('browse_target · agent · suspended',{exact:true})).toBeVisible();
 await page.getByText('Identity administration audit',{exact:true}).click();await expect(page.locator('[data-audit-id]').first()).toBeVisible();
 for(let n=0;n<5;n++){await click(page,'Next audit page');await expect(page.locator(`[data-audit-id="30000000-0000-4000-8000-${String((n+1)*25+1).padStart(12,'0')}"]`)).toBeVisible();}
 await expect(page.locator('[data-audit-id="30000000-0000-4000-8000-000000000137"]')).toBeVisible();expect(await page.locator('[data-audit-id]').count()).toBeLessThanOrEqual(25);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 expect((await f.admin.call('/api/v1/identity/accounts/lookup',{id:administrationTarget})).body.state).toBe('suspended');
});
test('compiled administration discards held credentials on account switch, and held pages after role withdrawal and navigation',async({page,context,server})=>{
 const f=await begin(page,context,server);
 const first=page.getByRole('button',{name:'Manage credentials'}).first();await first.click();await page.getByText('Credentials for this account',{exact:true}).click();
 const entered=barrier(),release=barrier();let held=true;
 await page.route('**/api/v1/identity/credentials/query',async route=>{if(!held){await route.continue();return;}held=false;const response=await route.fetch();entered.release();await release.promise;await route.fulfill({response});});
 await click(page,'Refresh credentials');await entered.promise;
 await page.getByLabel('Exact account ID or nickname').fill('browse_target');await click(page,'Find account');await expect(page.getByText('browse_target · agent · active',{exact:true})).toBeVisible();
 const target=page.locator('.list-row').filter({has:page.getByText('browse_target · agent · active',{exact:true})});await target.getByRole('button',{name:'Manage credentials'}).click();await page.getByText('Credentials for this account',{exact:true}).click();await expect(page.getByText(/History 1 Ω/)).toBeVisible();release.release();await expect(page.getByText(/History 1 Ω/)).toBeVisible();
 const accountsEntered=barrier(),accountsRelease=barrier();await page.route('**/api/v1/identity/accounts/query',async route=>{const response=await route.fetch();accountsEntered.release();await accountsRelease.promise;await route.fulfill({response});},{times:1});
 await click(page,'Refresh accounts');await accountsEntered.promise;
 await server.observer.query("UPDATE loom.participants SET role='participant' WHERE id=$1",[f.person]);
 await click(page,'Refresh credentials');await expect(page.getByText(/Administrator metadata was withdrawn/)).toBeVisible();await expect(page.getByText(/History 1 Ω/)).toHaveCount(0);await expect(page.getByLabel('Nickname',{exact:true})).not.toHaveValue('browse_target');
 accountsRelease.release();await expect(page.getByText('browse_target · agent · active',{exact:true})).toHaveCount(0);
 await page.getByRole('link',{name:'Participation guide',exact:true}).click();await expect(page.getByRole('heading',{name:/Participation guide/})).toBeVisible();await expect(page.getByText(/History 1 Ω/)).toHaveCount(0);
});

test('operational health keeps failed-page focus and fences held observations after authority withdrawal',async({page,context,server})=>{
 const f=await setup(page,context,server);await server.observer.query("UPDATE loom.participants SET role='administrator' WHERE id=$1",[f.person]);
 const {NativeSearchWorker}=await import('../../scripts/lib/native-search-worker.js');const worker=new NativeSearchWorker(server.configuration);
 try {
  await worker.start();await worker.observeUntil(async()=>(await f.admin.call('/api/v1/admin/operational-health')).body.authored.value?.coverage.coverage==='current_supported_text');await worker.stop();
  const input={idempotency_key:randomUUID(),area_id:f.area,title:'Operational publication',content:{format:'loom-markdown-v1',text:'Published while worker stopped',mentions:[]}};
  const publication=await f.admin.call('/api/v1/artifacts',input);expect(publication.status).toBe(201);
  for(let i=0;i<70;i++){
   await new Promise(r=>setTimeout(r,120));expect((await f.admin.call('/api/v1/artifacts',{...input,title:'Changed retry'})).status).toBe(409);
   if((await server.observer.query('SELECT count(*)::int n FROM loom.operational_observations')).rows[0].n>=28)break;
  }
  expect((await server.observer.query('SELECT count(*)::int n FROM loom.operational_observations')).rows[0].n).toBeGreaterThanOrEqual(28);
  await page.goto(server.origin+'/loom/admin');await page.getByText('Operational health',{exact:true}).click();
  await expect(page.getByRole('region',{name:'Authored indexing health'})).toContainText('not established');
  const refresh=page.getByRole('button',{name:'Refresh operational health'});await refresh.focus();await page.keyboard.press('Enter');
  await expect(page.getByRole('region',{name:'Authored indexing health'})).toContainText('not established');
  await worker.start();await worker.observeUntil(async()=>(await f.admin.call('/api/v1/admin/operational-health')).body.authored.value?.coverage.coverage==='current_supported_text');await worker.stop();
  await refresh.click();await expect(page.getByRole('region',{name:'Authored indexing health'})).toContainText('current supported text');
  expect((await f.admin.call('/api/v1/resources/'+publication.body.resource_id)).body.revision_id).toBe(publication.body.revision_id);
  await page.getByText('Inspect request outcomes',{exact:true}).click();await expect(page.getByRole('button',{name:'Next outcomes page'})).toHaveAttribute('aria-disabled','false');
  const next=page.getByRole('button',{name:'Next outcomes page'});let failedBody:unknown;
  await page.route('**/api/v1/admin/operational-health/outcomes',async route=>{failedBody=route.request().postDataJSON();await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'service_unavailable',message:'Synthetic observation failure',request_id:randomUUID(),recovery:{action:'retry_same_request'}}})});},{times:1});
  await next.focus();await page.keyboard.press('Enter');await expect(page.getByRole('button',{name:'Retry outcomes page'})).toBeVisible();await expect(next).toBeFocused();
  await expect(page.getByText(/Previous outcomes page is stale/)).toBeVisible();
  let retryBody:unknown;await page.route('**/api/v1/admin/operational-health/outcomes',async route=>{retryBody=route.request().postDataJSON();await route.continue();},{times:1});
  await click(page,'Retry outcomes page');await expect(page.getByText('End of outcomes results for this traversal.')).toBeVisible();expect(retryBody).toEqual(failedBody);
  await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  const held=barrier(),release=barrier();await page.route('**/api/v1/admin/operational-health',async route=>{const response=await route.fetch();held.release();await release.promise;await route.fulfill({response});},{times:1});
  await refresh.click();await held.promise;await server.observer.query("UPDATE loom.participants SET role='participant' WHERE id=$1",[f.person]);
  try{await click(page,'Refresh outcomes');await expect(page.getByText('idempotency conflict',{exact:true})).toHaveCount(0);}finally{release.release();}
  await expect(page.getByRole('region',{name:'Authored indexing health'})).toHaveCount(0);
 } finally {await worker.stop();}
});
