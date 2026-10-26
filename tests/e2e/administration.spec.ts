import { test, expect } from '../helpers/browser-fixtures.js';
import { setup } from '../helpers/change-browser.js';
import { populateAdministration, administrationTarget } from '../helpers/administration.js';
import type { Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { journal } from '../helpers/change-browser.js';
const click=(page:Page,name:string)=>page.getByRole('button',{name,exact:true}).click();
function barrier(){let release!:()=>void;const promise=new Promise<void>(r=>release=r);return{promise,release};}

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
 const f=await begin(page,context,server);await page.setViewportSize({width:390,height:844});
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
