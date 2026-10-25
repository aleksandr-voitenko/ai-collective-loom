import { test, expect } from '../helpers/browser-fixtures.js';
import { setup } from '../helpers/change-browser.js';
import { populateAdministration, administrationTarget } from '../helpers/administration.js';
import type { Page } from '@playwright/test';
const click=(page:Page,name:string)=>page.getByRole('button',{name,exact:true}).click();
function barrier(){let release!:()=>void;const promise=new Promise<void>(r=>release=r);return{promise,release};}
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
