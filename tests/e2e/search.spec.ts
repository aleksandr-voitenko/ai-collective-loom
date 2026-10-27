import { randomUUID } from 'node:crypto';
import type { Page,BrowserContext } from '@playwright/test';
import { test,expect } from '../helpers/browser-fixtures.js';
import { NativeSearchWorker } from '../../scripts/lib/native-search-worker.js';
import type { syntheticServer } from '../helpers/participation-server.js';
import { readFile } from 'node:fs/promises';
import { httpClient } from '../helpers/participation-http.js';
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
  await page.goto(server.origin+'/loom/admin');await page.getByText('Search indexing administration',{exact:true}).click();await page.getByText('Rebuild derived index',{exact:true}).click();
  await page.getByRole('button',{name:'Start search rebuild'}).click();await expect(page.getByText('Search maintenance request accepted.',{exact:false})).toBeVisible();
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
