import { chromium,type Page,type BrowserContext } from '@playwright/test';
import { diagnosticTest,expect } from '../helpers/browser-fixtures.js';
import { createServer } from 'node:http';
const test=diagnosticTest.extend<{server:{origin:string}}>({server:async({diagnostics},use)=>{
  const server=createServer((_request,response)=>response.end('<html><title>Synthetic cleanup</title><body>Profile cleanup fixture</body></html>'));
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
  diagnostics.setOrigin(origin);diagnostics.observeServer(server);diagnostics.phase('server_ready');
  try{await use({origin});}finally{diagnostics.phase('server_closing');await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));diagnostics.phase('server_closed');}
}});
import { randomUUID } from 'node:crypto';
import { access,mkdtemp,rm,readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { syntheticServer } from '../helpers/participation-server.js';
import type { BrowserDiagnostics } from '../helpers/browser-diagnostics.js';
const endpoint='/api/v1/me/reading';
const text=(text:string)=>({format:'loom-markdown-v1',text,mentions:[]});
function barrier(){let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};}
async function api(page:Page,path:string,body?:unknown){
  const self=await(await page.request.get(new URL('/api/v1/identity/self',page.url()).href,{ignoreHTTPSErrors:true})).json();
  const result=body===undefined?await page.request.get(new URL(path,page.url()).href,{ignoreHTTPSErrors:true}):await page.request.post(new URL(path,page.url()).href,{ignoreHTTPSErrors:true,data:body,headers:{origin:new URL(page.url()).origin,'x-loom-csrf':self.csrf}});
  expect(result.ok()).toBe(true);return result.json();
}
async function setup(page:Page,context:BrowserContext,server:Awaited<ReturnType<typeof syntheticServer>>){
  const cdp=await context.newCDPSession(page);await cdp.send('WebAuthn.enable');await cdp.send('WebAuthn.addVirtualAuthenticator',{options:{protocol:'ctap2',transport:'internal',hasResidentKey:true,hasUserVerification:true,isUserVerified:true,automaticPresenceSimulation:true}});
  await page.goto(server.origin+'/loom');await page.getByText('Set up an admitted account',{exact:true}).click();await page.getByLabel('Enrollment ticket',{exact:true}).fill(server.ticket);
  await page.getByRole('button',{name:'Create passkey',exact:true}).click();await expect(page.getByText('Your passkey is ready. Sign in to continue.')).toBeVisible();
  await page.getByRole('button',{name:'Sign in with passkey'}).click();await expect(page.getByRole('heading',{name:'Topics',exact:true})).toBeVisible();
  await page.getByRole('link',{name:'Administration',exact:true}).click();await page.getByRole('button',{name:'Initialize community',exact:true}).click();await expect(page.getByText('Community configuration',{exact:true})).toBeVisible();
  const area=(await api(page,'/api/v1/areas')).items.find((r:any)=>r.title==='General').id;
  const opening=await api(page,'/api/v1/discussions',{idempotency_key:randomUUID(),area_id:area,title:'Reading discussion',content:text('Opening main text')});
  const discussion=(await api(page,'/api/v1/resources/'+opening.resource_id)).discussion_id;
  const reply=async(body='Selected reply',parent=opening.resource_id)=>api(page,'/api/v1/replies',{idempotency_key:randomUUID(),discussion_id:discussion,parent_id:parent,content:text(body)});
  const artifact=async(body='Artifact main text')=>api(page,'/api/v1/artifacts',{idempotency_key:randomUUID(),area_id:area,title:'Reading artifact',content:text(body)});
  return {area,opening,discussion,reply,artifact};
}
const control=(page:Page,revision:string)=>page.locator(`[data-reading-target="${revision}"]`);
const pair=(s:any)=>({resource_id:s.resource_id,revision_id:s.revision_id});
const state=async(page:Page,s:any)=>(await api(page,endpoint+'/lookup',{targets:[pair(s)]})).items[0];
async function enable(page:Page,origin:string){await page.goto(origin+'/loom/reading');await page.getByLabel('Automatically mark presented text read — prototype, this account on this browser').check();await expect.poll(()=>page.evaluate(()=>Object.keys(localStorage).some(k=>k.endsWith(':automatic')&&localStorage.getItem(k)==='true'))).toBe(true);}
async function exact(page:Page,origin:string,s:any){await page.goto(origin+`/loom/resource/${s.resource_id}/${s.revision_id}`);await expect(control(page,s.revision_id).getByRole('button',{name:'Mark unread',exact:true})).toBeEnabled();}

async function nativeLifecycleBrowser(diagnostics:BrowserDiagnostics){
  // The ordinary harness forces focus in its own CDP session; another session
  // cannot undo that override. Connect to native Chromium without that default.
  const directory=await mkdtemp(join(tmpdir(),'loom-reading-lifecycle-'));
  const native=spawn(chromium.executablePath(),['--headless','--no-sandbox','--no-first-run','--ignore-certificate-errors','--remote-debugging-port=0','--user-data-dir='+directory,'about:blank'],{stdio:'ignore'});
  let launchError:Error|undefined;
  const stopped=new Promise<void>(resolve=>{
    native.once('error',error=>{launchError=error;resolve();});native.once('close',()=>resolve());
  });
  let browser:Awaited<ReturnType<typeof chromium.connectOverCDP>>|undefined;
  const contexts:BrowserContext[]=[];
  async function close(){
    try{
      if(browser?.isConnected()){
        for(const context of contexts)for(const page of context.pages())await diagnostics.snapshot(page);
        // Closing a CDP-attached default context only disconnects Playwright.
        // Ask Chromium to finish its profile writers before removing the profile;
        // SIGTERM + parent exit raced those writers with rm on Linux (ENOTEMPTY).
        const session=await browser.newBrowserCDPSession();
        await session.send('Browser.close');
        await expect.poll(()=>native.exitCode).toBe(0);
      }
    }finally{
      // Startup/close failures still dispose this test-owned process and propagate.
      if(native.exitCode===null&&native.signalCode===null)native.kill('SIGTERM');
      await stopped;
      try{
        for(const context of contexts)await context.close();
        if(browser?.isConnected())await browser.close();
        if(launchError)throw launchError;
      }finally{await rm(directory,{recursive:true,force:true});}
    }
  }
  try{
    let port='';await expect.poll(async()=>{
      if(launchError)throw launchError;
      try{port=(await readFile(join(directory,'DevToolsActivePort'),'utf8')).split('\n')[0]!;return Number(port)>0;}catch{return false;}
    }).toBe(true);
    browser=await chromium.connectOverCDP('http://127.0.0.1:'+port,{noDefaults:true});
    const context=diagnostics.track(browser.contexts()[0]!,'explicit');contexts.push(context);
    return {context,directory,close};
  }catch(error){await close();throw error;}
}

test('manual selective reading, exact historical IDs and a frozen bounded selection preserve Saved and newer revisions',async({page,context,server})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.name));const d=await setup(page,context,server),x=await d.reply('Older skipped X'),y=await d.reply('Newer selected Y');
  await api(page,'/api/v1/me/saved-items/state',{idempotency_key:randomUUID(),target:{kind:'revision',...pair(x)},saved:true,expected_version:0});
  await exact(page,server.origin,y);const button=control(page,y.revision_id).getByRole('button',{name:'Mark read',exact:true});await button.focus();await page.keyboard.press('Enter');
  await expect.poll(async()=>(await state(page,y)).read).toBe(true);await expect(button).toBeFocused();
  const newer=await api(page,'/api/v1/revisions',{idempotency_key:randomUUID(),resource_id:y.resource_id,expected_revision_id:y.revision_id,title:null,content:text('Y2')});
  expect((await state(page,x)).version).toBe(0);expect((await state(page,newer)).version).toBe(0);
  await page.goto(server.origin+'/loom/discussion/'+d.discussion);
  await control(page,d.opening.revision_id).getByRole('checkbox').check();await control(page,newer.revision_id).getByRole('checkbox').check();
  await page.getByText('Mark selected discussion revisions (2/25)',{exact:true}).click();
  const queued=barrier(),release=barrier();let frozen:any;
  await page.route('**'+endpoint+'/state',async route=>{frozen=route.request().postDataJSON();queued.release();await release.promise;await route.continue();});
  try{
    await page.getByRole('button',{name:'Mark 2 selected read',exact:true}).click();await queued.promise;
    const later=await d.reply('After selection');release.release();await page.unrouteAll({behavior:'wait'});
    await expect.poll(async()=>(await state(page,newer)).read).toBe(true);
    expect(frozen.targets.map((v:any)=>v.revision_id).sort()).toEqual([d.opening.revision_id,newer.revision_id].sort());expect((await state(page,later)).version).toBe(0);
  }finally{release.release();}
  expect((await api(page,'/api/v1/me/saved-items/lookup',{kind:'revision',...pair(x)})).saved).toBe(true);
  await exact(page,server.origin,y);
  if(process.env.LOOM_READING_REVIEW_SCREENS==='1')await page.screenshot({path:'/private/tmp/loom-reading-desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});await exact(page,server.origin,y);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await expect(control(page,y.revision_id).getByText(/Read · private/)).toBeVisible();
  if(process.env.LOOM_READING_REVIEW_SCREENS==='1')await page.screenshot({path:'/private/tmp/loom-reading-mobile.png',fullPage:true});
  expect(errors).toEqual([]);expect(await page.title()).not.toBe('');
});

test('a reading conflict stays on its exact revision after another change succeeds and survives reload until dismissal',async({page,context,server})=>{
  const d=await setup(page,context,server),a=await d.reply('Conflicting selection'),b=await d.reply('Independent selection');
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.name));
  await page.goto(server.origin+'/loom/discussion/'+d.discussion);
  await expect(control(page,a.revision_id).getByRole('button',{name:'Mark read',exact:true})).toBeEnabled();
  const queued=barrier(),release=barrier();
  await page.route('**'+endpoint+'/state',async route=>{
    if(route.request().postDataJSON().targets[0].revision_id===a.revision_id){queued.release();await release.promise;}
    await route.continue();
  });
  try{
    await control(page,a.revision_id).getByRole('button',{name:'Mark read',exact:true}).click();await queued.promise;
    await api(page,endpoint+'/state',{idempotency_key:randomUUID(),basis:'manual',episode_id:null,targets:[{...pair(a),read:false,expected_version:0}]});
    release.release();await page.unrouteAll({behavior:'wait'});
    await expect(control(page,a.revision_id).getByText(/Reading change conflicted/)).toBeVisible();
    await expect(control(page,b.revision_id).getByText(/Reading change conflicted/)).toHaveCount(0);
    await control(page,b.revision_id).getByRole('button',{name:'Mark read',exact:true}).click();
    await expect(control(page,b.revision_id).getByText(/Read · private/)).toBeVisible();
    await expect(control(page,a.revision_id).getByText(/Reading change conflicted/)).toBeVisible();
    await page.reload();
    await expect(control(page,a.revision_id).getByText(/Reading change conflicted/)).toBeVisible();
    await expect(control(page,b.revision_id).getByText(/Reading change conflicted/)).toHaveCount(0);
    await expect(control(page,b.revision_id).getByText(/Read · private/)).toBeVisible();
    if(process.env.LOOM_READING_REVIEW_SCREENS==='1')await page.screenshot({path:'/private/tmp/loom-reading-conflict-desktop.png',fullPage:true});
    await page.setViewportSize({width:390,height:844});
    await control(page,a.revision_id).getByRole('link',{name:'Review or dismiss the reading conflict'}).click();
    await expect(page.getByRole('heading',{name:'Private reading progress'})).toBeVisible();
    await expect(page.getByText(/No revisions in this change were updated/)).toBeVisible();
    const dismiss=page.getByRole('button',{name:'Dismiss reading conflict',exact:true});await dismiss.focus();
    if(process.env.LOOM_READING_REVIEW_SCREENS==='1')await page.screenshot({path:'/private/tmp/loom-reading-conflict-mobile.png',fullPage:true});
    await page.keyboard.press('Enter');
    await expect(page.getByText('No pending reading changes.')).toBeVisible();
    expect((await state(page,a)).read).toBe(false);expect((await state(page,a)).version).toBe(1);
    expect((await state(page,b)).read).toBe(true);expect((await state(page,b)).version).toBe(1);
    await page.goto(server.origin+'/loom/discussion/'+d.discussion);
    await expect(control(page,a.revision_id).getByText(/Marked unread · private/)).toBeVisible();
    await expect(control(page,a.revision_id).getByText(/Reading change conflicted/)).toHaveCount(0);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);expect(errors).toEqual([]);
  }finally{release.release();}
});

test('opt-in presentation covers full long text, excludes unpresented branches and produces no duplicate known-read outcome',async({page,context,server})=>{
  const d=await setup(page,context,server),long=await d.artifact(Array.from({length:22},(_,i)=>`Paragraph ${i}. Full text needs viewport presentation. `.repeat(3)).join('\n\n'));
  const requests:any[]=[];page.on('request',r=>{if(r.url().endsWith(endpoint+'/state'))requests.push(r.postDataJSON());});
  await exact(page,server.origin,long);await page.waitForTimeout(1200);expect(requests).toEqual([]);
  await enable(page,server.origin);await exact(page,server.origin,long);await page.bringToFront();
  await page.waitForTimeout(1200);expect((await state(page,long)).read).toBe(false);
  const prose=control(page,long.revision_id).locator('.prose');
  const box=await prose.boundingBox();expect(box!.height).toBeGreaterThan(800);
  // Overlapping windows expose every band, including the top and final partial band.
  for(let y=0;y<box!.height+500;y+=400){await page.evaluate(y=>scrollTo(0,y),Math.max(0,box!.y+y-100));await page.waitForTimeout(1200);}
  await expect.poll(async()=>(await state(page,long)).read).toBe(true);
  expect(requests).toHaveLength(1);expect(requests[0].basis).toBe('presentation');expect(requests[0].targets.map((v:any)=>v.revision_id)).toEqual([long.revision_id]);
  await page.reload();await page.waitForTimeout(1300);expect(requests).toHaveLength(1);
  const parent=await d.reply('Parent visible'),child=await d.reply('Nested child',parent.resource_id),deep=await d.reply('Deep collapsed text',child.resource_id);
  await page.goto(server.origin+'/loom/discussion/'+d.discussion);await page.waitForTimeout(1300);
  expect(await page.locator(`[data-presented-revision="${deep.revision_id}"]`).count()).toBe(0);expect((await state(page,deep)).version).toBe(0);
  await page.goto(server.origin+'/loom/updates');await page.waitForTimeout(1300);expect((await state(page,deep)).version).toBe(0);
});

for(const committed of [false,true])test(`manual unread defeats ${committed?'committed but unacknowledged':'queued'} automatic read across tabs without passive rearm`,async({page,context,server})=>{
  const d=await setup(page,context,server),a=await d.artifact();await enable(page,server.origin);
  const held=barrier(),release=barrier();let automatic:any;
  await page.route('**'+endpoint+'/state',async route=>{
    const body=route.request().postDataJSON();if(body.basis!=='presentation'){await route.continue();return;}
    automatic=body;const response=committed?await route.fetch():undefined;held.release();await release.promise;
    if(response)await route.fulfill({response});else await route.continue();
  });
  const other=await context.newPage();
  try{
    await exact(page,server.origin,a);await page.bringToFront();await held.promise;
    await exact(other,server.origin,a);await other.bringToFront();await control(other,a.revision_id).getByRole('button',{name:'Mark unread',exact:true}).click();
    await expect.poll(async()=>(await state(other,a)).version).toBe(committed?2:1);
    release.release();await page.unrouteAll({behavior:'wait'});
    await control(other,a.revision_id).getByRole('button',{name:'Refresh reading status'}).click();await other.waitForTimeout(1400);
    expect((await state(other,a)).read).toBe(false);expect(automatic.targets[0].expected_version).toBe(0);
    await page.bringToFront();await control(page,a.revision_id).getByRole('button',{name:'Refresh reading status'}).click();await page.waitForTimeout(1400);expect((await state(page,a)).read).toBe(false);
    await page.goto(server.origin+'/loom/reading');await exact(page,server.origin,a);await page.bringToFront();await expect.poll(async()=>(await state(page,a)).read).toBe(true);
  }finally{release.release();await other.close();}
});

test('reading response loss survives a browser process restart and original Read replay reports current Unread',async({server,diagnostics})=>{
  const directory=await mkdtemp(join(tmpdir(),'loom-reading-browser-'));let context=await diagnostics.launchPersistentContext(directory,{ignoreHTTPSErrors:true,headless:true});
  try{
    let page=await context.newPage();const d=await setup(page,context,server),a=await d.artifact();await exact(page,server.origin,a);
    const lost=barrier();let body:any;
    await page.route('**'+endpoint+'/state',async route=>{body=route.request().postDataJSON();const response=await route.fetch();expect(response.status()).toBe(200);await route.abort('connectionfailed');lost.release();});
    await control(page,a.revision_id).getByRole('button',{name:'Mark read',exact:true}).click();await lost.promise;
    await api(page,endpoint+'/state',{idempotency_key:randomUUID(),basis:'manual',episode_id:null,targets:[{...pair(a),read:false,expected_version:1}]});
    await context.close();context=await diagnostics.launchPersistentContext(directory,{ignoreHTTPSErrors:true,headless:true});page=await context.newPage();await page.goto(server.origin+'/loom/reading');
    let replay:any;page.on('request',r=>{if(r.url().endsWith(endpoint+'/state'))replay=r.postDataJSON();});
    await page.getByRole('button',{name:'Retry same reading change'}).click();await expect(page.getByText('No pending reading changes.')).toBeVisible();expect(replay).toEqual(body);
    expect((await state(page,a)).read).toBe(false);expect((await state(page,a)).version).toBe(2);
  }finally{await context.close();await rm(directory,{recursive:true,force:true});}
});

test('status and local-save failures preserve full text, keyboard focus and unrelated drafts',async({page,context,server})=>{
  const d=await setup(page,context,server),a=await d.artifact();await exact(page,server.origin,a);
  await page.evaluate(()=>{localStorage.setItem('loom.intent.synthetic-unrelated','preserved');const original=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k.startsWith('loom.reading:')&&k.includes(':intent:'))throw new Error('Synthetic storage fault');return original.call(this,k,v);};});
  const sent:any[]=[];page.on('request',r=>{if(r.url().endsWith(endpoint+'/state'))sent.push(r.postDataJSON());});
  await control(page,a.revision_id).getByRole('button',{name:'Mark read',exact:true}).click();await expect(control(page,a.revision_id).getByRole('alert')).toContainText('could not be saved');expect(sent).toEqual([]);
  expect(await page.evaluate(()=>localStorage.getItem('loom.intent.synthetic-unrelated'))).toBe('preserved');
  await page.route('**'+endpoint+'/lookup',route=>route.fulfill({status:503,json:{error:{code:'service_unavailable',message:'Reading status unavailable'}}}));
  const refresh=control(page,a.revision_id).getByRole('button',{name:'Refresh reading status'});await refresh.focus();await page.keyboard.press('Enter');
  await expect(control(page,a.revision_id).getByRole('status')).toContainText('Reading status unavailable');await expect(page.getByText('Artifact main text',{exact:true})).toBeVisible();await expect(refresh).toBeFocused();expect((await server.observer.query('SELECT count(*)::int n FROM loom.reading_states')).rows[0].n).toBe(0);
});

test('background lifecycle and late abandoned responses cannot qualify; foreground reopening can',async({server,diagnostics})=>{
  const native=await nativeLifecycleBrowser(diagnostics),context=native.context;
  try{
    const page=await context.newPage();
    await page.setViewportSize({width:1440,height:1000});
    const d=await setup(page,context,server),a=await d.artifact('Foreground eligible text'),b=await d.artifact('Abandoned late text');await enable(page,server.origin);
    const lifecycle=await context.newCDPSession(page);
    await exact(page,server.origin,a);
    await lifecycle.send('Emulation.setFocusEmulationEnabled',{enabled:false});
    await lifecycle.send('Page.setWebLifecycleState',{state:'frozen'});
    expect(await page.evaluate(()=>document.visibilityState)).toBe('hidden');
    await page.waitForTimeout(1400);expect((await state(page,a)).version).toBe(0);
    await lifecycle.send('Page.setWebLifecycleState',{state:'active'});
    await lifecycle.send('Emulation.setFocusEmulationEnabled',{enabled:true});
    await page.bringToFront();await expect.poll(async()=>(await state(page,a)).read).toBe(true);
    const late=barrier(),finish=barrier();
    await page.route(`**/api/v1/resources/${b.resource_id}/revisions/${b.revision_id}`,async route=>{
      const response=await page.request.get(route.request().url(),{ignoreHTTPSErrors:true});
      late.release();await finish.promise;await route.fulfill({response});
    });
    try{await page.goto(server.origin+`/loom/resource/${b.resource_id}/${b.revision_id}`);await late.promise;await page.goto(server.origin+'/loom/reading');finish.release();await page.unrouteAll({behavior:'wait'});await page.waitForTimeout(1400);expect((await state(page,b)).version).toBe(0);}
    finally{finish.release();}
  }finally{await native.close();}
});

test('native lifecycle shutdown removes profiles after pending storage writes',async({server,diagnostics})=>{
  for(let i=0;i<3;i++){
    const native=await nativeLifecycleBrowser(diagnostics),context=native.context;
    try{
      const page=await context.newPage();
      await page.goto(server.origin+'/loom');
      await page.evaluate(()=>{for(let n=0;n<10;n++)localStorage.setItem('synthetic-cleanup-'+n,'x'.repeat(100000));});
    }finally{await native.close();}
    expect(context.browser()!.isConnected()).toBe(false);
    await expect(access(native.directory)).rejects.toMatchObject({code:'ENOENT'});
  }
});

test('sign-out fences late reading outcomes before blocked cleanup and preserves the server state',async({page,context,server})=>{
  const d=await setup(page,context,server),a=await d.artifact();await exact(page,server.origin,a);
  const committed=barrier(),release=barrier();
  await page.route('**'+endpoint+'/state',async route=>{const response=await route.fetch();committed.release();await release.promise;await route.fulfill({response});});
  try{
    await control(page,a.revision_id).getByRole('button',{name:'Mark read',exact:true}).click();await committed.promise;
    const lock=await page.evaluate(async()=>{
      const key=Object.keys(localStorage).find(k=>k.startsWith('loom.reading:')&&k.includes(':intent:'))!,prefix=key.slice(0,key.indexOf('intent:'));
      let unlock!:()=>void;const held=new Promise<void>(resolve=>{unlock=resolve;});(window as any).releaseReadingLock=unlock;
      let acquired!:()=>void;const ready=new Promise<void>(resolve=>{acquired=resolve;});void navigator.locks.request(prefix,async()=>{acquired();await held;});await ready;return prefix;
    });
    await page.getByRole('button',{name:'Sign out',exact:true}).click();await expect(page.getByRole('button',{name:'Export reading recovery',exact:true})).toBeVisible();
    await page.getByRole('button',{name:'Clear local drafts and sign out',exact:true}).click();await expect(page.getByRole('heading',{name:'Welcome to the Loom'})).toBeVisible();
    release.release();await page.unrouteAll({behavior:'wait'});await page.evaluate(()=>(window as any).releaseReadingLock());
    await expect.poll(()=>page.evaluate(prefix=>Object.keys(localStorage).filter(k=>k.startsWith(prefix)).length,lock)).toBe(0);
    expect((await server.observer.query('SELECT is_read,version FROM loom.reading_states WHERE revision_id=$1',[a.revision_id])).rows).toEqual([{is_read:true,version:1}]);
  }finally{release.release();await page.evaluate(()=>(window as any).releaseReadingLock?.()).catch(()=>{});}
});
