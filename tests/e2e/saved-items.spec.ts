import { test as base, expect, chromium, type Page, type BrowserContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syntheticServer } from '../helpers/participation-server.js';

const test=base.extend<{server:Awaited<ReturnType<typeof syntheticServer>>}>({
  context:async({context,server:_server},use)=>{try{await use(context);}finally{await context.close();}},
  server:async({},use)=>{const server=await syntheticServer();try{await use(server);}finally{await server.close();}},
});
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

test('lost Save acknowledgement survives a browser process restart and retry after Unsave',async({server})=>{
  const directory=await mkdtemp(join(tmpdir(),'loom-saved-browser-'));
  let context=await chromium.launchPersistentContext(directory,{ignoreHTTPSErrors:true,headless:true});
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
    await context.close();context=await chromium.launchPersistentContext(directory,{ignoreHTTPSErrors:true,headless:true});
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
  const d=await setup(page,context,server);await page.goto(server.origin+`/loom/resource/${d.resource}/${d.revision}`);
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
