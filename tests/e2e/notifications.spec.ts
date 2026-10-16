import { randomUUID } from 'node:crypto';
import { mkdir,copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test,expect } from '../helpers/browser-fixtures.js';
import { setup,api } from '../helpers/change-browser.js';
import { mentioned } from '../helpers/notifications.js';
import { NativeSearchWorker } from '../../scripts/lib/native-search-worker.js';
import type { Page,BrowserContext } from '@playwright/test';
import type { syntheticServer } from '../helpers/participation-server.js';
function barrier(){let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};}
async function material(page:Page,context:BrowserContext,server:Awaited<ReturnType<typeof syntheticServer>>,extra=12){
  const f=await setup(page,context,server),worker=new NativeSearchWorker(server.configuration,'notifications');
  const opening=await api(page,'/api/v1/discussions',{idempotency_key:randomUUID(),area_id:f.area,title:'Review the shared synthesis',content:{format:'loom-markdown-v1',text:'My original question',mentions:[]}});
  const discussion=(await api(page,'/api/v1/resources/'+opening.resource_id)).discussion_id;
  const reply=await f.admin.call('/api/v1/replies',{idempotency_key:randomUUID(),discussion_id:discussion,parent_id:opening.resource_id,content:mentioned(f.person),change_note:null,change_account:null});expect(reply.status).toBe(201);
  const note=await f.admin.call('/api/v1/artifacts',{idempotency_key:randomUUID(),area_id:f.area,title:'Revised research plan',content:mentioned(f.person),change_note:{format:'loom-markdown-v2',text:'Please review [[mention:n]]',mentions:[{token:'n',participant_id:f.person}],references:[]},change_account:null});expect(note.status).toBe(201);
  async function project(count:number){await worker.start();try{await worker.observeUntil(async()=>(await server.observer.query('SELECT count(*)::int n FROM loom.personal_deliveries')).rows[0].n===count);}finally{await worker.stop();}}
  await project(2);
  for(let i=0;i<extra;i++)expect((await f.admin.call('/api/v1/artifacts',{idempotency_key:randomUUID(),area_id:f.area,title:'Attention item '+i,content:mentioned(f.person),change_note:null,change_account:null})).status).toBe(201);
  return {...f,worker,project,reply:reply.body,note:note.body};
}
const recovery=(page:Page)=>page.evaluate(()=>Object.entries(localStorage).filter(([key])=>key.startsWith('loom.notifications:')).map(([key,value])=>({key,...JSON.parse(value)})));

test('personal attention discovery, coalesced exact links, incomplete generation, reload, keyboard and mobile layout',async({page,context,server},info)=>{
  const f=await material(page,context,server);await page.getByRole('link',{name:'Mentions/replies',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Mentions/replies',exact:true})).toBeVisible();await expect(page.locator('.notification-list > li')).toHaveCount(2);
  await expect(page.getByText('Notification generation is incomplete.',{exact:false})).toBeVisible();await expect(page.getByText('Direct reply',{exact:true})).toBeVisible();await expect(page.getByText('Mention in revision note',{exact:true})).toBeVisible();
  const note=page.getByRole('link',{name:'Triggering change note'});await expect(note).toHaveAttribute('href',`/loom/resource/${f.note.resource_id}/${f.note.revision_id}#change-note`);
  await note.click();await expect(page.getByText(/Editor’s note for revision 1/)).toBeVisible();await page.goBack();await expect(page.locator('.notification-list > li')).toHaveCount(2);
  await f.project(14);await page.getByRole('button',{name:'Check for newer signals'}).click();await expect(page.locator('.notification-list > li')).toHaveCount(12);
  const before=(await server.observer.query('SELECT count(*)::int n FROM loom.shared_activity')).rows[0].n;
  const records=await recovery(page);expect(records).toHaveLength(1);await page.reload();await expect(page.locator('.notification-list > li')).toHaveCount(12);
  await page.getByText('Retrieval coverage and recovery',{exact:true}).click();await page.getByRole('button',{name:'Replay retained history'}).focus();await page.keyboard.press('Enter');await expect(page.locator('.notification-list > li')).toHaveCount(12);await expect(page.getByRole('button',{name:'Continue this interval'})).toBeVisible();
  await expect(page.getByRole('heading',{name:'Mentions/replies',exact:true})).toBeFocused();
  for(const [name,width,height] of [['desktop',1440,1000],['mobile',390,844]] as const){
    await page.setViewportSize({width,height});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    const path=info.outputPath('attention-'+name+'.png');await page.screenshot({path,fullPage:true});
    // Deliberate synthetic visual review only; never part of approved diagnostics.
    if(process.env.LOOM_NOTIFICATION_REVIEW_SCREENS==='1'){
      const destination=fileURLToPath(new URL('../../docs/development/evidence/notifications/',import.meta.url));await mkdir(destination,{recursive:true});await copyFile(path,destination+'attention-'+name+'.png');
    }
  }
  await page.getByRole('button',{name:'Continue this interval'}).focus();await page.keyboard.press('Enter');await expect(page.locator('.notification-list > li')).toHaveCount(2);
  await page.reload();await expect(page.locator('.notification-list > li')).toHaveCount(2);
  expect((await server.observer.query('SELECT count(*)::int n FROM loom.shared_activity')).rows[0].n).toBe(before);expect((await server.observer.query('SELECT count(*)::int n FROM loom.saved_items')).rows[0].n).toBe(0);
});

test('failed next-page transport and local save preserve context, focus and recoverable page on reload',async({page,context,server})=>{
  const f=await material(page,context,server);await f.project(14);await page.goto(server.origin+'/loom/notifications');await expect(page.locator('.notification-list > li')).toHaveCount(12);
  const saved=await recovery(page),texts=await page.locator('.notification-list h2').allTextContents();let fail=true;
  await page.route('**/api/v1/me/notifications/query',async route=>{if(fail)await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'service_unavailable',message:'Synthetic page failure'}})});else await route.continue();});
  const next=page.getByRole('button',{name:'Continue this interval'});await next.focus();await page.keyboard.press('Enter');await expect(page.getByRole('alert')).toContainText('Synthetic page failure');await expect(next).toBeFocused();expect(await page.locator('.notification-list h2').allTextContents()).toEqual(texts);expect(await recovery(page)).toEqual(saved);
  fail=false;await page.evaluate(()=>{const original=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key.startsWith('loom.notifications:')){Storage.prototype.setItem=original;throw new DOMException('Synthetic recovery save failure','QuotaExceededError');}original.call(this,key,value);};});
  await page.getByRole('button',{name:'Retry notification page'}).click();await expect(page.getByRole('alert')).toContainText('Synthetic recovery save failure');expect(await recovery(page)).toEqual(saved);
  await page.reload();await expect(page.locator('.notification-list > li')).toHaveCount(12);expect(await page.locator('.notification-list h2').allTextContents()).toEqual(texts);
  await page.getByRole('button',{name:'Continue this interval'}).click();await expect(page.locator('.notification-list > li')).toHaveCount(2);
});

test('late filter, route and signed-out responses cannot restore private notification rows or recovery',async({page,context,server})=>{
  const f=await material(page,context,server,0),entered=barrier(),release=barrier();let held=false;
  await page.route('**/api/v1/me/notifications/query',async route=>{if(!held){held=true;const response=await route.fetch();entered.release();await release.promise;await route.fulfill({response}).catch(()=>{});}else await route.continue();});
  try{await page.goto(server.origin+'/loom/notifications');await entered.promise;await page.getByLabel('Attention reasons').selectOption('reply');await expect(page.locator('.notification-list > li')).toHaveCount(1);release.release();await expect(page.getByLabel('Attention reasons')).toHaveValue('reply');await expect(page.locator('.notification-list > li')).toHaveCount(1);}
  finally{release.release();await page.unrouteAll({behavior:'wait'});}
  const routeEntered=barrier(),routeRelease=barrier();await page.route('**/api/v1/me/notifications/query',async route=>{const response=await route.fetch();routeEntered.release();await routeRelease.promise;await route.fulfill({response}).catch(()=>{});});
  try{await page.getByRole('button',{name:'Check for newer signals'}).click();await routeEntered.promise;await page.getByRole('link',{name:'Topics',exact:true}).first().click();routeRelease.release();await expect(page.getByRole('heading',{name:'Topics',exact:true})).toBeVisible();await expect(page.locator('.notification-list > li')).toHaveCount(0);}
  finally{routeRelease.release();await page.unrouteAll({behavior:'wait'});}
  const accountEntered=barrier(),accountRelease=barrier();await page.route('**/api/v1/me/notifications/query',async route=>{const response=await route.fetch();accountEntered.release();await accountRelease.promise;await route.fulfill({response}).catch(()=>{});});
  try{await page.goto(server.origin+'/loom/notifications');await accountEntered.promise;await page.getByRole('button',{name:'Sign out',exact:true}).click();
    const confirm=page.getByRole('button',{name:'Clear local drafts and sign out'});if(await confirm.isVisible())await confirm.click();await expect(page.getByRole('button',{name:'Sign in with passkey'})).toBeVisible();accountRelease.release();await expect(page.locator('.notification-list > li')).toHaveCount(0);expect(await recovery(page)).toEqual([]);
  }finally{accountRelease.release();await page.unrouteAll({behavior:'wait'});}
  expect(f.reply.resource_id).toBeTruthy();
});

test('sign-out fences notification responses before asynchronous recovery cleanup finishes',async({page,context,server})=>{
  await material(page,context,server,0);await page.goto(server.origin+'/loom/notifications');
  await expect(page.locator('.notification-list > li')).toHaveCount(2);
  const saved=await recovery(page),lockName=saved[0].key.replace(/:all$/,':mention');
  // Hold the second cleanup lock, after the first reason has been cleared. A
  // late response must not refill that first record while sign-out is waiting.
  await page.evaluate(async name=>{
    await new Promise<void>(entered=>{void navigator.locks.request(name,()=>new Promise<void>(release=>{
      (window as any).releaseNotificationCleanup=release;entered();
    }));});
  },lockName);
  const entered=barrier(),release=barrier();
  await page.route('**/api/v1/me/notifications/query',async route=>{const response=await route.fetch();entered.release();await release.promise;await route.fulfill({response}).catch(()=>{});});
  try{
    await page.getByRole('button',{name:'Check for newer signals'}).click();await entered.promise;
    await page.getByRole('button',{name:'Sign out',exact:true}).click();
    const confirm=page.getByRole('button',{name:'Clear local drafts and sign out'});if(await confirm.isVisible())await confirm.click();
    await expect.poll(()=>page.evaluate(async name=>(await navigator.locks.query()).pending?.some(lock=>lock.name===name),lockName)).toBe(true);
    release.release();
    await expect(page.getByRole('button',{name:'Sign in with passkey'})).toBeVisible();
    await expect(page.locator('.notification-list > li')).toHaveCount(0);expect(await recovery(page)).toEqual([]);
  }finally{
    release.release();await page.evaluate(()=>(window as any).releaseNotificationCleanup());await page.unrouteAll({behavior:'wait'});
  }
  await expect(page.getByRole('button',{name:'Sign in with passkey'})).toBeVisible();expect(await recovery(page)).toEqual([]);
});

test('visibility recovery withholds cached metadata until retained history is reauthorized',async({page,context,server})=>{
  const f=await material(page,context,server,0);await page.goto(server.origin+'/loom/notifications');
  await expect(page.locator('.notification-list > li')).toHaveCount(2);
  await server.observer.query("UPDATE loom.resources SET state='suppressed' WHERE id=$1",[f.note.resource_id]);
  await page.getByRole('button',{name:'Check for newer signals'}).click();
  await expect(page.getByRole('alert')).toContainText('Shared visibility changed');
  await expect(page.locator('.notification-list > li')).toHaveCount(0);
  await expect(page.getByRole('alert')).toBeFocused();
  await expect(page.getByText('Revised research plan',{exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'Replay retained history',exact:true}).click();
  await expect(page.locator('.notification-list > li')).toHaveCount(1);
  await page.getByRole('button',{name:'Check for newer signals'}).click();await expect(page.locator('.notification-list > li')).toHaveCount(0);
  await server.observer.query("UPDATE loom.resources SET state='active' WHERE id=$1",[f.note.resource_id]);
  await page.getByRole('button',{name:'Check for newer signals'}).click();
  await expect(page.getByRole('alert')).toContainText('Shared visibility changed');
  await page.getByRole('button',{name:'Replay retained history',exact:true}).click();
  await expect(page.locator('.notification-list > li')).toHaveCount(2);
  const ids=(await recovery(page))[0].recent_delivery_ids;expect(new Set(ids).size).toBe(2);
});
