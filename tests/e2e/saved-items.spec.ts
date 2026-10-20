import type { Page, BrowserContext } from '@playwright/test';
import { test, expect } from '../helpers/browser-fixtures.js';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { syntheticServer } from '../helpers/participation-server.js';
import type { Intent } from '../../src/web/participation-client.js';

const authenticators=new WeakMap<Page,{remove:()=>Promise<unknown>}>();
async function enter(page:Page,context:BrowserContext,origin:string,ticket:string){
  await authenticators.get(page)?.remove();
  const cdp=await context.newCDPSession(page);await cdp.send('WebAuthn.enable');
  const {authenticatorId}=await cdp.send('WebAuthn.addVirtualAuthenticator',{options:{protocol:'ctap2',transport:'internal',hasResidentKey:true,hasUserVerification:true,isUserVerified:true,automaticPresenceSimulation:true}});
  authenticators.set(page,{remove:()=>cdp.send('WebAuthn.removeVirtualAuthenticator',{authenticatorId})});
  await page.goto(origin+'/loom');await page.getByText('Set up an admitted account',{exact:true}).click();
  await page.getByLabel('Enrollment ticket',{exact:true}).fill(ticket);await page.getByRole('button',{name:'Create passkey',exact:true}).click();
  await expect(page.getByText('Your passkey is ready. Sign in to continue.')).toBeVisible();
  await page.getByRole('button',{name:'Sign in with passkey'}).click();await expect(page.getByRole('heading',{name:'Topics',exact:true})).toBeVisible();
}
async function api(page:Page,path:string,body?:unknown){
  const self=await (await page.request.get(new URL('/api/v1/identity/self',page.url()).href)).json();
  const response=body===undefined?await page.request.get(new URL(path,page.url()).href):await page.request.post(new URL(path,page.url()).href,
    {data:body,headers:{origin:new URL(page.url()).origin,'x-loom-csrf':self.csrf}});
  expect(response.ok()).toBeTruthy();return response.json();
}
const content=(text:string)=>({format:'loom-markdown-v1',text,mentions:[]});
const saved='/api/v1/me/saved-items';
async function setup(page:Page,context:BrowserContext,server:Awaited<ReturnType<typeof syntheticServer>>){
  await enter(page,context,server.origin,server.ticket);
  await page.getByRole('link',{name:'Administration',exact:true}).click();
  await page.getByRole('button',{name:'Initialize community',exact:true}).click();
  await expect(page.getByText('Community configuration',{exact:true})).toBeVisible();
  const area=(await api(page,'/api/v1/areas')).items.find((r:{title:string})=>r.title==='General').id;
  const created=await api(page,'/api/v1/discussions',{idempotency_key:randomUUID(),area_id:area,title:'Saved discussion',content:content('Opening for private bookmarks')});
  const resource=await api(page,'/api/v1/resources/'+created.resource_id);
  return {area,resource:created.resource_id as string,revision:created.revision_id as string,discussion:resource.discussion_id as string};
}
function control(page:Page,kind:string,id:string,revision=''){return page.locator(`[data-saved-target="${kind}:${id}:${revision}"]`).first();}
function barrier(){let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return{promise,release};}

async function recoveryRecords(page: Page): Promise<Intent[]> {
  return page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('loom.intent.'))
    .map(key => JSON.parse(localStorage.getItem(key)!)).sort((a, b) => a.key.localeCompare(b.key)));
}
async function fillSavedTargetLimit(server: Awaited<ReturnType<typeof syntheticServer>>, page: Page, area: string) {
  // Retention-only fixtures must not inject 500 unpublished structural markers
  // into the discussion whose ordinary reply and recovery UI this test exercises.
  const created=await api(page,'/api/v1/discussions',{idempotency_key:randomUUID(),area_id:area,title:'Retained quota fixtures',content:content('Separate fixture scope')});
  const opening=created.resource_id as string;
  const discussion=(await api(page,'/api/v1/resources/'+opening)).discussion_id as string;
  // Real retained tombstones reach the unchanged server quota; no HTTP refusal is mocked.
  await server.database.transaction(tx => tx.query(`WITH resources AS (
    INSERT INTO loom.resources(id,kind,owner_resource_id,original_author_id)
    SELECT gen_random_uuid(),'contribution',$1,$2 FROM generate_series(1,500) RETURNING id
  ), contributions AS (
    INSERT INTO loom.contributions(id,discussion_id,parent_id) SELECT id,$1,$3 FROM resources RETURNING id
  ) INSERT INTO loom.saved_items(id,participant_id,target_kind,resource_id,content_resource_id,version)
    SELECT gen_random_uuid(),$2,'contribution',id,id,1 FROM contributions`,
  [discussion, server.administratorId, opening]));
}

test('browser saves resource and exact references, keeps R1 after R2, and renders private desktop/mobile collection',async({page,context,server},info)=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  const d=await setup(page,context,server);
  await page.goto(server.origin+'/loom/discussion/'+d.discussion);
  await page.getByRole('button',{name:'Save discussion',exact:true}).click();
  await expect(page.getByRole('button',{name:'Unsave discussion',exact:true})).toBeEnabled();
  await page.getByRole('button',{name:'Save contribution',exact:true}).click();
  await expect(page.getByRole('button',{name:'Unsave contribution',exact:true})).toBeEnabled();
  await page.goto(server.origin+`/loom/resource/${d.resource}/${d.revision}`);
  await page.getByRole('button',{name:'Save this revision',exact:true}).click();
  await expect(page.getByRole('button',{name:'Unsave',exact:true})).toBeEnabled();
  const revised=await api(page,'/api/v1/revisions',{idempotency_key:randomUUID(),resource_id:d.resource,expected_revision_id:d.revision,title:'Saved discussion revised',content:content('R2')});
  await page.getByRole('link',{name:'Saved items',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Saved items',exact:true})).toBeVisible();
  await expect(page.locator('.saved-row')).toHaveCount(3);
  const rows=(await api(page,saved)).items;
  expect(rows.find((r:any)=>r.target.kind==='revision').source.resource.revision_id).toBe(d.revision);
  expect(rows.find((r:any)=>r.target.kind==='contribution').source.resource.revision_id).toBe(revised.revision_id);
  await expect(page.getByRole('link',{name:'Saved discussion',exact:true})).toHaveAttribute('href',`/loom/resource/${d.resource}/${d.revision}`);
  const second=await context.newPage();await second.goto(server.origin+'/loom/saved');
  await expect(second.locator('.saved-row')).toHaveCount(3);await second.close();
  await page.screenshot({path:info.outputPath('saved-desktop.png'),fullPage:true});
  await info.attach('Saved items desktop',{path:info.outputPath('saved-desktop.png'),contentType:'image/png'});
  await page.setViewportSize({width:390,height:844});
  await expect(page.getByRole('button',{name:'Open navigation'})).toBeVisible();
  await page.getByRole('button',{name:'Open navigation'}).click();
  await expect(page.getByRole('dialog').getByRole('link',{name:'Saved items',exact:true})).toBeVisible();
  await page.keyboard.press('Escape');await expect(page.getByRole('button',{name:'Open navigation'})).toBeFocused();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:info.outputPath('saved-mobile.png'),fullPage:true});
  await info.attach('Saved items mobile',{path:info.outputPath('saved-mobile.png'),contentType:'image/png'});
  expect(errors).toEqual([]);
});

test('lost Save acknowledgement survives a browser process restart and retry after Unsave',async({server,diagnostics})=>{
  const directory=await mkdtemp(join(tmpdir(),'loom-saved-browser-'));
  let context=await diagnostics.launchPersistentContext(directory,{ignoreHTTPSErrors:true,headless:true});
  try{
    let page=await context.newPage();const d=await setup(page,context,server);
    await page.goto(server.origin+'/loom/discussion/'+d.discussion);
    let original:any;const discarded=barrier();
    await page.route('**'+saved+'/state',async route=>{
      original=route.request().postDataJSON();const result=await route.fetch();expect(result.status()).toBe(200);
      await route.abort('connectionfailed');discarded.release();
    });
    await page.getByRole('button',{name:'Save discussion',exact:true}).click();await discarded.promise;
    await expect(control(page,'discussion',d.discussion).getByText('We couldn’t confirm whether this saved-item change completed.')).toBeVisible();
    const current=await api(page,saved+'/lookup',original.target);
    await api(page,saved+'/state',{idempotency_key:randomUUID(),target:original.target,saved:false,expected_version:current.version});
    await context.close();context=await diagnostics.launchPersistentContext(directory,{ignoreHTTPSErrors:true,headless:true});
    page=await context.newPage();await page.goto(server.origin+'/loom/saved');
    await expect(page.getByRole('heading',{name:'Unconfirmed changes'})).toBeVisible();
    let retried:any;page.on('request',request=>{if(request.url().endsWith(saved+'/state'))retried=request.postDataJSON();});
    await page.getByRole('button',{name:'Retry same change'}).click();
    await expect(page.getByRole('heading',{name:'Unconfirmed changes'})).not.toBeVisible();
    expect(retried).toEqual(original);
    expect((await api(page,saved+'/lookup',original.target)).saved).toBe(false);
    expect((await server.observer.query('SELECT count(*)::int AS n FROM loom.saved_operations WHERE idempotency_key=$1',[original.idempotency_key])).rows[0].n).toBe(1);
    await page.getByRole('button',{name:'Refresh collection'}).click();
    await expect(page.getByRole('heading',{name:'No saved items yet'})).toBeVisible();
  }finally{await context.close();await rm(directory,{recursive:true,force:true});}
});

test('simultaneous tabs reconcile one frozen intent and a late original response cannot reverse Unsave',async({page,context,server})=>{
  const d=await setup(page,context,server), url=server.origin+'/loom/discussion/'+d.discussion;
  await page.goto(url);const other=await context.newPage();await other.goto(url);
  await expect(other.getByRole('button',{name:'Save discussion',exact:true})).toBeEnabled();
  const committed=barrier(), release=barrier();let original:any;
  await page.route('**'+saved+'/state',async route=>{
    original=route.request().postDataJSON();const response=await route.fetch();committed.release();await release.promise;
    await route.fulfill({response});
  });
  try{
    await page.getByRole('button',{name:'Save discussion',exact:true}).click();await committed.promise;
    await expect(control(other,'discussion',d.discussion).getByRole('button',{name:'Check saved status'})).toBeVisible();
    await control(other,'discussion',d.discussion).getByRole('button',{name:'Check saved status'}).click();
    await expect(other.getByRole('button',{name:'Unsave discussion',exact:true})).toBeEnabled();
    await other.getByRole('button',{name:'Unsave discussion',exact:true}).click();
    await expect(other.getByRole('button',{name:'Save discussion',exact:true})).toBeEnabled();
    release.release();await page.unrouteAll({behavior:'wait'});
    await expect(control(page,'discussion',d.discussion).getByRole('button',{name:'Save discussion',exact:true})).toBeVisible();
    expect((await api(other,saved+'/lookup',original.target)).saved).toBe(false);
    expect((await server.observer.query('SELECT count(*)::int AS n FROM loom.saved_operations WHERE participant_id=$1',[server.administratorId])).rows[0].n).toBe(2);
    const entries=await other.evaluate(()=>Object.keys(localStorage).filter(key=>key.startsWith('loom.intent.')).map(key=>JSON.parse(localStorage.getItem(key)!)).filter(r=>r.kind==='saved.set'));
    expect(entries).toEqual([]);
  }finally{release.release();await other.close();}
});

test('a delayed first browser Save reports a version conflict instead of undoing a confirmed Unsave',async({page,context,server})=>{
  const d=await setup(page,context,server);await page.goto(server.origin+'/loom/discussion/'+d.discussion);
  const waiting=barrier(), release=barrier();let original:any;
  await page.route('**'+saved+'/state',async route=>{original=route.request().postDataJSON();waiting.release();await release.promise;await route.continue();});
  try{
    await page.getByRole('button',{name:'Save discussion',exact:true}).click();await waiting.promise;
    await api(page,saved+'/state',{idempotency_key:randomUUID(),target:original.target,saved:false,expected_version:0});
    release.release();
    await expect(control(page,'discussion',d.discussion).getByText(/Your change was not applied/)).toBeVisible();
    await expect(page.getByRole('button',{name:'Save discussion',exact:true})).toBeEnabled();
    expect((await api(page,saved+'/lookup',original.target)).saved).toBe(false);
    await page.reload();await expect(page.getByRole('button',{name:'Save discussion',exact:true})).toBeEnabled();
  }finally{release.release();}
});

test('a collection response from before another tab Unsave cannot claim current completion',async({page,context,server})=>{
  const d=await setup(page,context,server);
  const target={kind:'discussion',resource_id:d.discussion};
  await api(page,saved+'/state',{idempotency_key:randomUUID(),target,saved:true,expected_version:0});
  await page.goto(server.origin+'/loom/saved');await expect(page.locator('.saved-row')).toHaveCount(1);
  const other=await context.newPage();await other.goto(server.origin+'/loom/discussion/'+d.discussion);
  await expect(other.getByRole('button',{name:'Unsave discussion',exact:true})).toBeEnabled();
  const waiting=barrier(),release=barrier();
  await page.route('**'+saved+'?*',async route=>{const response=await route.fetch();waiting.release();await release.promise;await route.fulfill({response});});
  try{
    await page.getByRole('button',{name:'Refresh collection'}).click();await waiting.promise;
    await other.getByRole('button',{name:'Unsave discussion',exact:true}).click();
    await expect(other.getByRole('button',{name:'Save discussion',exact:true})).toBeEnabled();
    await expect(page.getByText(/Saved items may have changed/)).toBeVisible();
    release.release();await page.unrouteAll({behavior:'wait'});
    await expect(page.getByText(/Saved items may have changed/)).toBeVisible();
    await expect(page.getByText(/End of this Saved items/)).not.toBeVisible();
    await expect(page.locator('.saved-row').getByRole('button',{name:'Save',exact:true})).toBeEnabled();
    await page.getByRole('button',{name:'Refresh collection'}).click();
    await expect(page.getByRole('heading',{name:'No saved items yet'})).toBeVisible();
  }finally{release.release();await other.close();}
});

test('unavailable sources keep safe entries with working Unsave and no copied metadata',async({page,context,server})=>{
  const d=await setup(page,context,server);
  // Known targets return successful unavailable projections. An unknown target's
  // 404 would mask a client that only consumes HTTP errors as denial evidence.
  for(const target of [{kind:'discussion',resource_id:d.discussion},{kind:'contribution',resource_id:d.resource}])
    await api(page,saved+'/state',{idempotency_key:randomUUID(),target,saved:true,expected_version:0});
  await page.goto(server.origin+'/loom/discussion/'+d.discussion);
  await expect(page.getByText('Opening for private bookmarks',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Unsave discussion',exact:true})).toBeEnabled();await page.waitForLoadState('networkidle');
  const missing:string[]=[];const observe=(response:import('@playwright/test').Response)=>{if(response.status()===404)missing.push(new URL(response.url()).pathname);};
  page.on('response',observe);
  await server.observer.query("UPDATE loom.resources SET state='suppressed' WHERE id=$1",[d.discussion]);
  const receipt=page.waitForResponse(response=>new URL(response.url()).pathname===saved+'/state'&&response.status()===200);
  await page.getByRole('button',{name:'Unsave discussion',exact:true}).click();
  expect((await (await receipt).json()).current.source.state).toBe('unavailable');
  await expect(page.getByText('Opening for private bookmarks',{exact:true})).not.toBeVisible();
  await expect(page.getByRole('heading',{name:'Saved discussion',exact:true})).not.toBeVisible();
  await expect.poll(async()=>(await recoveryRecords(page)).filter(r=>r.kind==='saved.set').length).toBe(0);
  expect(missing).toEqual([]);page.off('response',observe);
  await server.observer.query("UPDATE loom.resources SET state='active' WHERE id=$1",[d.discussion]);
  await api(page,saved+'/state',{idempotency_key:randomUUID(),target:{kind:'contribution',resource_id:d.resource},saved:false,expected_version:1});
  await page.goto(server.origin+`/loom/resource/${d.resource}/${d.revision}`);
  await page.getByRole('button',{name:'Save this revision',exact:true}).click();await expect(page.getByRole('button',{name:'Unsave',exact:true})).toBeEnabled();
  await server.observer.query("UPDATE loom.revisions SET availability='suppressed' WHERE id=$1",[d.revision]);
  await page.getByRole('link',{name:'Saved items',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Saved target unavailable'})).toBeVisible();
  await expect(page.getByText('Saved discussion',{exact:true})).not.toBeVisible();
  await expect(page.locator('.saved-row a')).toHaveCount(0);
  await page.getByRole('button',{name:'Unsave',exact:true}).click();
  await expect(page.getByText('Removed from Saved items.',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Refresh collection'}).click();
  await expect(page.getByRole('heading',{name:'No saved items yet'})).toBeVisible();
});

test('bounded collection retries failed next page and isolates navigation and account changes',async({page,context,server})=>{
  const d=await setup(page,context,server);
  for(let n=0;n<14;n++){
    const artifact=await api(page,'/api/v1/artifacts',{idempotency_key:randomUUID(),area_id:d.area,title:'Saved private reference '+n,content:content('Synthetic source')});
    await api(page,saved+'/state',{idempotency_key:randomUUID(),target:{kind:'artifact',resource_id:artifact.resource_id},saved:true,expected_version:0});
  }
  await page.goto(server.origin+'/loom/saved');await expect(page.locator('.saved-row')).toHaveCount(12);
  let fail=true,failedCursor='';
  await page.route('**'+saved+'?*',async route=>{
    const cursor=new URL(route.request().url()).searchParams.get('cursor');
    if(fail && cursor){fail=false;failedCursor=cursor;await route.abort('connectionfailed');}else await route.continue();
  });
  await page.getByRole('button',{name:'Next page',exact:true}).click();
  await expect(page.getByRole('button',{name:'Retry collection'})).toBeVisible();
  await expect(page.locator('.saved-row')).toHaveCount(12);
  await expect(page.getByText(/End of this Saved items/)).not.toBeVisible();
  const retried=page.waitForRequest(request=>new URL(request.url()).searchParams.get('cursor')===failedCursor);
  await page.getByRole('button',{name:'Retry collection'}).click();await retried;
  await expect(page.locator('.saved-row')).toHaveCount(2);
  await expect(page.getByRole('heading',{name:'Saved items',exact:true})).toBeFocused();
  await page.unrouteAll({behavior:'wait'});
  const waiting=barrier(),release=barrier();
  await page.route('**'+saved+'?*',async route=>{const response=await route.fetch();waiting.release();await release.promise;await route.fulfill({response});});
  try{
    await page.getByRole('button',{name:'Refresh collection'}).click();await waiting.promise;
    await page.getByRole('link',{name:'Artifacts',exact:true}).first().click();release.release();
    await expect(page.getByRole('heading',{name:'Artifacts',exact:true})).toBeVisible();
    await expect(page.getByRole('heading',{name:'Saved items',exact:true})).not.toBeVisible();
  }finally{release.release();await page.unrouteAll({behavior:'wait'});}
  const account=await api(page,'/api/v1/identity/accounts',{idempotency_key:randomUUID(),nickname:'next_saved_owner',kind:'human',role:'participant'});
  const ticket=await api(page,'/api/v1/identity/credentials',{idempotency_key:randomUUID(),participant_id:account.participant_id,kind:'enrollment',purpose:'enroll',label:'Second owner',replace_credential_id:null});
  await page.goto(server.origin+'/loom/saved');await expect(page.locator('.saved-row')).toHaveCount(12);
  const old=barrier(),finish=barrier();
  await page.route('**'+saved+'?*',async route=>{const response=await route.fetch();old.release();await finish.promise;await route.fulfill({response});});
  try{
    await page.getByRole('button',{name:'Refresh collection'}).click();await old.promise;
    await page.getByRole('button',{name:'Sign out',exact:true}).click();
    const confirm=page.getByRole('button',{name:'Clear local drafts and sign out'});if(await confirm.isVisible())await confirm.click();
    await expect(page.getByRole('button',{name:'Sign in with passkey'})).toBeVisible();
    await enter(page,context,server.origin,ticket.secret);
    finish.release();await page.unrouteAll({behavior:'wait'});
    await page.getByRole('link',{name:'Saved items',exact:true}).click();
    await expect(page.getByRole('heading',{name:'No saved items yet'})).toBeVisible();
    await expect(page.getByRole('link',{name:/Saved private reference/})).toHaveCount(0);
    await page.goto(server.origin+'/loom/discussion/'+d.discussion);
    await page.getByRole('button',{name:'Save discussion',exact:true}).click();
    await expect(page.getByRole('button',{name:'Unsave discussion',exact:true})).toBeEnabled();
    await page.getByRole('link',{name:'Saved items',exact:true}).click();
    await expect(page.locator('.saved-row')).toHaveCount(1);
    expect((await server.observer.query('SELECT count(*)::int AS n FROM loom.saved_items WHERE participant_id=$1 AND saved',[server.administratorId])).rows[0].n).toBe(14);
  }finally{finish.release();}
});

test('first Saved quota refusal survives reload as rejected and dismisses only its own record', async ({ page, context, server }) => {
  const d = await setup(page, context, server);
  await fillSavedTargetLimit(server, page, d.area);
  await page.goto(server.origin + '/loom/discussion/' + d.discussion);
  await expect(page.getByRole('button', { name: 'Save discussion', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Reply', exact: true }).click();
  const text = 'Keep this unpublished reply through a server quota refusal.';
  await page.getByRole('textbox', { name: 'Your reply', exact: true }).fill(text);
  await expect.poll(async () => (await recoveryRecords(page)).some(record =>
    record.kind === 'reply.create' && (record.body.content as { text: string }).text === text)).toBe(true);
  const before = await recoveryRecords(page);

  const refused = page.waitForResponse(response => response.url().endsWith(saved + '/state'));
  await page.getByRole('button', { name: 'Save discussion', exact: true }).click();
  const response = await refused;
  expect(response.status()).toBe(429);
  expect((await response.json()).error.code).toBe('saved_limit_reached');
  await expect(control(page, 'discussion', d.discussion).getByText('This change was rejected.', { exact: true })).toBeVisible();
  const rejected = (await recoveryRecords(page)).find(record => record.kind === 'saved.set')!;
  expect(rejected.state).toBe('rejected');
  expect((await api(page, saved + '/status', { idempotency_key: rejected.key })).operation_state).toBe('not_recorded');
  expect((await api(page, saved + '/lookup', rejected.body.target)).version).toBe(0);

  await page.reload();
  await expect(control(page, 'discussion', d.discussion).getByRole('button', { name: 'Dismiss rejected change' })).toBeVisible();
  await page.getByRole('link', { name: 'Saved items', exact: true }).click();
  await expect(page.getByText('This change was rejected.', { exact: true })).toBeVisible();
  expect((await recoveryRecords(page)).find(record => record.key === rejected.key)).toEqual(rejected);
  await page.getByRole('button', { name: 'Dismiss rejected change' }).click();
  await expect(page.getByRole('heading', { name: 'Unconfirmed changes' })).not.toBeVisible();
  expect(await recoveryRecords(page)).toEqual(before);
  expect((await server.observer.query('SELECT count(*)::int AS n FROM loom.saved_items WHERE participant_id=$1', [server.administratorId])).rows[0].n).toBe(500);
  expect((await server.observer.query('SELECT count(*)::int AS n FROM loom.saved_operations WHERE participant_id=$1', [server.administratorId])).rows[0].n).toBe(0);
  await page.goto(server.origin + '/loom/help');
  await page.getByRole('link', { name: /^reply.create · draft/ }).click();
  await expect(page.getByRole('textbox', { name: 'Your reply', exact: true })).toHaveValue(text);
});

test('lost Saved quota response stays uncertain after reload, absent status and refused exact retry', async ({ page, context, server }) => {
  const d = await setup(page, context, server);
  await fillSavedTargetLimit(server, page, d.area);
  await page.goto(server.origin + '/loom/discussion/' + d.discussion);
  const lost = barrier();
  await page.route('**' + saved + '/state', async route => {
    const response = await route.fetch();
    expect(response.status()).toBe(429);
    expect((await response.json()).error.code).toBe('saved_limit_reached');
    await route.abort('connectionfailed'); lost.release();
  });
  await page.getByRole('button', { name: 'Save discussion', exact: true }).click();
  await lost.promise;
  await expect(control(page, 'discussion', d.discussion).getByText('We couldn’t confirm whether this saved-item change completed.')).toBeVisible();
  const original = (await recoveryRecords(page)).find(record => record.kind === 'saved.set')!;
  await page.unrouteAll({ behavior: 'wait' });
  await page.reload();
  const controls = control(page, 'discussion', d.discussion);
  await controls.getByRole('button', { name: 'Check saved status' }).click();
  await expect(controls.getByText(/No outcome is recorded yet/)).toBeVisible();
  const refused = page.waitForResponse(response => response.url().endsWith(saved + '/state'));
  await controls.getByRole('button', { name: 'Retry same change' }).click();
  const response = await refused;
  expect(response.status()).toBe(429);
  expect(response.request().postDataJSON()).toEqual(original.body);
  await expect(controls.getByRole('alert')).toContainText('retention limit');
  await expect(controls.getByRole('button', { name: 'Retry same change' })).toBeEnabled();
  await expect(controls.getByRole('button', { name: 'Dismiss rejected change' })).not.toBeVisible();
  const retained = (await recoveryRecords(page)).find(record => record.key === original.key)!;
  expect(retained.state).toBe('uncertain');
  expect(retained.body).toEqual(original.body);
  await page.reload();
  await expect(controls.getByText('We couldn’t confirm whether this saved-item change completed.')).toBeVisible();
  expect((await recoveryRecords(page)).find(record => record.key === original.key)).toEqual(retained);
});

test('a competing Saved retry prevents a late first quota refusal from releasing uncertainty', async ({ page, context, server }) => {
  const d = await setup(page, context, server);
  await fillSavedTargetLimit(server, page, d.area);
  const url = server.origin + '/loom/discussion/' + d.discussion;
  await page.goto(url);
  const other = await context.newPage(); await other.goto(url);
  const refused = barrier(), release = barrier();
  await page.route('**' + saved + '/state', async route => {
    const response = await route.fetch();
    expect(response.status()).toBe(429);
    refused.release(); await release.promise; await route.fulfill({ response });
  });
  try {
    await page.getByRole('button', { name: 'Save discussion', exact: true }).click();
    await refused.promise;
    const original = (await recoveryRecords(page)).find(record => record.kind === 'saved.set')!;
    const retryResponse = other.waitForResponse(response => response.url().endsWith(saved + '/state'));
    await control(other, 'discussion', d.discussion).getByRole('button', { name: 'Retry same change' }).click();
    const response = await retryResponse;
    expect(response.status()).toBe(429);
    expect(response.request().postDataJSON()).toEqual(original.body);
    await expect(control(other, 'discussion', d.discussion).getByRole('alert')).toContainText('retention limit');
    const retried = (await recoveryRecords(other)).find(record => record.key === original.key)!;
    expect(retried.state).toBe('uncertain');
    expect(retried.sequence).toBeGreaterThan(original.sequence);
    release.release(); await page.unrouteAll({ behavior: 'wait' });
    await expect(control(page, 'discussion', d.discussion).getByRole('button', { name: 'Retry same change' })).toBeEnabled();
    expect((await recoveryRecords(page)).find(record => record.key === original.key)).toEqual(retried);
    for (const client of [page, other]) {
      await expect(control(client, 'discussion', d.discussion).getByRole('button', { name: 'Dismiss rejected change' })).not.toBeVisible();
    }
  } finally { release.release(); await page.unrouteAll({ behavior: 'wait' }); await other.close(); }
});

test('local journal failure prevents Save dispatch and preserves existing publication drafts',async({page,context,server})=>{
  const d=await setup(page,context,server);await page.goto(server.origin+'/loom/discussion/'+d.discussion);
  await expect(page.getByRole('button',{name:'Save discussion',exact:true})).toBeEnabled();
  await page.getByRole('button',{name:'Reply',exact:true}).click();
  await page.getByRole('textbox',{name:'Your reply',exact:true}).fill('Keep this unpublished reply through a failed Save.');
  await expect.poll(()=>page.evaluate(()=>Object.keys(localStorage).filter(k=>k.startsWith('loom.intent.')).map(k=>JSON.parse(localStorage.getItem(k)!))
    .some(record=>record.kind==='reply.create' && record.body.content.text==='Keep this unpublished reply through a failed Save.'))).toBe(true);
  const before=await page.evaluate(()=>Object.keys(localStorage).filter(k=>k.startsWith('loom.intent.')).map(k=>localStorage.getItem(k)));
  await page.evaluate(()=>{const original=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){
    if(key.startsWith('loom.intent.') && JSON.parse(value).kind==='saved.set')throw new DOMException('Synthetic storage full','QuotaExceededError');
    return original.call(this,key,value);
  };});
  let posted=0;page.on('request',r=>{if(r.url().endsWith(saved+'/state'))posted++;});
  await page.getByRole('button',{name:'Save discussion',exact:true}).click();
  await expect(control(page,'discussion',d.discussion).getByRole('alert')).toContainText('Synthetic storage full');
  expect(posted).toBe(0);
  expect(await page.evaluate(()=>Object.keys(localStorage).filter(k=>k.startsWith('loom.intent.')).map(k=>localStorage.getItem(k)))).toEqual(before);
});
