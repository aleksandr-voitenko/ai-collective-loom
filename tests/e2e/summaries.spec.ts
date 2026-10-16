import {randomUUID} from 'node:crypto';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import type {Page,BrowserContext} from '@playwright/test';
import {test,expect} from '../helpers/browser-fixtures.js';
import {httpClient} from '../helpers/participation-http.js';
import type {syntheticServer} from '../helpers/participation-server.js';
import {plain,authored} from '../helpers/references.js';
function barrier(){let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};}
async function setup(page:Page,context:BrowserContext,server:Awaited<ReturnType<typeof syntheticServer>>,role='participant',title='A discussion to summarize'){
  const admin=httpClient(server.origin,await readFile(server.directory+'/cert.pem','utf8'));await admin.enroll(server.ticket);
  expect((await admin.call('/api/v1/community/setup',{idempotency_key:randomUUID(),community_name:'Summary browser',ordinary_area_name:'General',proposal_area_name:'Proposals',overview:plain('Overview')})).status).toBe(201);
  const area=(await admin.call('/api/v1/areas')).body.items.find((i:any)=>i.title==='General').id;
  const person=await admin.call('/api/v1/identity/accounts',{idempotency_key:randomUUID(),nickname:'summary_author',kind:'human',role});expect(person.status).toBe(200);
  const ticket=await admin.call('/api/v1/identity/credentials',{idempotency_key:randomUUID(),participant_id:person.body.participant_id,kind:'enrollment',purpose:'enroll',label:'Summary browser',replace_credential_id:null});expect(ticket.status).toBe(200);
  const cdp=await context.newCDPSession(page);await cdp.send('WebAuthn.enable');await cdp.send('WebAuthn.addVirtualAuthenticator',{options:{protocol:'ctap2',transport:'internal',hasResidentKey:true,hasUserVerification:true,isUserVerified:true,automaticPresenceSimulation:true}});
  await page.goto(server.origin+'/loom');await page.getByText('Set up an admitted account',{exact:true}).click();await page.getByLabel('Enrollment ticket',{exact:true}).fill(ticket.body.secret);await page.getByRole('button',{name:'Create passkey',exact:true}).click();await expect(page.getByText('Your passkey is ready. Sign in to continue.')).toBeVisible();await page.getByRole('button',{name:'Sign in with passkey'}).click();await expect(page.getByRole('heading',{name:'Topics',exact:true})).toBeVisible();
  const opening=await admin.call('/api/v1/discussions',{idempotency_key:randomUUID(),area_id:area,title,content:authored('Opening source')});expect(opening.status).toBe(201);
  const discussion=(await admin.call('/api/v1/resources/'+opening.body.resource_id)).body.discussion_id;
  const reply=()=>admin.call('/api/v1/replies',{idempotency_key:randomUUID(),discussion_id:discussion,parent_id:opening.body.resource_id,content:authored('Later discussion material')});
  return {admin,area,discussion,opening:opening.body,person:person.body.participant_id,reply};
}
async function draft(page:Page,origin:string,discussion:string){await page.goto(origin+'/loom/discussion/'+discussion);await expect(page.getByText('No summary has been published.')).toBeVisible();await page.getByRole('link',{name:'Create first summary',exact:true}).click();await page.getByLabel('Title',{exact:true}).fill('Human discussion summary');await page.getByLabel('Text',{exact:true}).fill('Authored independent summary');}
const journal=(page:Page,kind:string,key?:string)=>page.evaluate(({kind,key})=>Object.entries(localStorage).filter(([k])=>k.startsWith('loom.intent.v1:')).map(([,v])=>JSON.parse(v)).find(r=>r.kind===kind&&(!key||r.key===key)),{kind,key});

test('summary create, inspect, maintain, partial update, editor reassignment, keyboard and narrow layouts',async({page,context,server},info)=>{
  const f=await setup(page,context,server,'administrator');await draft(page,server.origin,f.discussion);
  const started=barrier(),release=barrier();await page.route('**/api/v1/summary-preparations',async route=>{const response=await route.fetch();started.release();await release.promise;await route.fulfill({response});});
  await page.getByRole('button',{name:'Prepare declared sources',exact:true}).click();try{await started.promise;await page.getByLabel('Text',{exact:true}).fill('Latest typing while preparing sources');}finally{release.release();}
  await expect(page.getByText(/Full discussion snapshot · 1 currently eligible/)).toBeVisible();await page.unroute('**/api/v1/summary-preparations');await page.reload();await expect(page.getByLabel('Text',{exact:true})).toHaveValue('Latest typing while preparing sources');
  expect((await journal(page,'summary.create')).body.coverage.preparation_id).toBeTruthy();expect((await server.observer.query('SELECT count(*)::int n FROM loom.summaries')).rows[0].n).toBe(0);
  await page.getByRole('button',{name:'Publish',exact:true}).focus();await page.keyboard.press('Enter');await expect(page.getByText('Your publication is saved.',{exact:true})).toBeVisible();await page.getByRole('link',{name:'Inspect exact revision',exact:true}).click();
  await expect(page.getByText('No known gaps in the declared discussion scope.')).toBeVisible();await expect(page.getByText('Saving summaries is not supported in this release.')).toBeVisible();
  const membersStarted=barrier(),releaseMembers=barrier(),membersRoute='**/api/v1/summaries/*/revisions/*/members*';
  await page.route(membersRoute,async route=>{const response=await route.fetch();membersStarted.release();await releaseMembers.promise;await route.fulfill({response});});
  const refreshSources=page.getByRole('button',{name:'Refresh source view',exact:true});
  try{
    await page.getByRole('button',{name:'Inspect declared sources',exact:true}).click();await membersStarted.promise;
    await expect(page.getByRole('heading',{name:'Source revisions',exact:true})).toBeVisible();
    await expect(refreshSources).toBeDisabled();
  }finally{releaseMembers.release();}
  // The heading renders before source loading enables the refresh control.
  await expect(refreshSources).toBeEnabled();
  await page.unroute(membersRoute);
  await refreshSources.focus();await expect(refreshSources).toBeFocused();await page.keyboard.press('Enter');
  await expect(page.getByRole('heading',{name:'Source revisions',exact:true})).toBeFocused();
  await page.screenshot({path:info.outputPath('summary-desktop.png'),fullPage:true});
  const created=(await journal(page,'summary.create')).result;await f.reply();await page.goto(server.origin+'/loom/summaries?filter=uncovered&editable=true');await expect(page.getByText(/1 eligible contributions outside/)).toBeVisible();await page.getByRole('link',{name:'Update summary',exact:true}).click();
  await page.getByLabel('Source scope').selectOption('selected');await page.locator('.coverage-editor input[type=checkbox]').first().check();await page.getByRole('button',{name:'Prepare declared sources',exact:true}).click();await expect(page.getByText(/Explicit partial selection · 1 currently eligible/)).toBeVisible();
  await page.getByRole('button',{name:'Publish',exact:true}).click();await expect(page.getByText('Your publication is saved.',{exact:true})).toBeVisible();await page.getByRole('link',{name:'Inspect exact revision',exact:true}).click();await expect(page.getByText('Selected sources · partial scope')).toBeVisible();
  await page.getByText('Editors',{exact:true}).click();await page.getByRole('button',{name:'Manage editors',exact:true}).click();await page.locator('label').filter({hasText:'summary_author'}).getByRole('checkbox').uncheck();await page.getByRole('button',{name:'Save editor list',exact:true}).click();await expect(page.getByText('No assigned editors')).toBeVisible();
  const current=(await f.admin.call('/api/v1/resources/'+created.resource_id)).body;expect(current.author.id).toBe(f.person);expect(current.content.text).toBe('Latest typing while preparing sources');expect(current.revision_number).toBe('2');
  await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:info.outputPath('summary-mobile.png'),fullPage:true});
  await page.getByRole('button',{name:'Revision history',exact:true}).click();await expect(page.getByRole('link',{name:/Revision 1/})).toBeVisible();
});

test('summary conflict comparison failure, correction autosave failure and reload preserve the exact draft',async({page,context,server})=>{
  const f=await setup(page,context,server);await draft(page,server.origin,f.discussion);await page.getByRole('button',{name:'Prepare declared sources',exact:true}).click();await expect(page.getByText(/Full discussion snapshot/)).toBeVisible();await page.getByRole('button',{name:'Publish',exact:true}).click();await expect(page.getByText('Your publication is saved.',{exact:true})).toBeVisible();const first=(await journal(page,'summary.create')).result;
  await page.goto(server.origin+'/loom/resource/'+first.resource_id+'?edit=1');await page.getByLabel('Text',{exact:true}).fill('Preserved conflicting draft');
  const next=await f.admin.call('/api/v1/summary-revisions',{idempotency_key:randomUUID(),resource_id:first.resource_id,expected_revision_id:first.revision_id,title:'Concurrent title',content:authored('Concurrent summary'),coverage:{carry_forward_revision_id:first.revision_id}});expect(next.status).toBe(201);
  let fail=true,holdReload=false;const comparisonStarted=barrier(),releaseComparison=barrier();
  await page.route(`**/api/v1/resources/${first.resource_id}/revisions/${next.body.revision_id}`,async route=>{
    if(holdReload){comparisonStarted.release();await releaseComparison.promise;}
    return fail?route.abort('failed'):route.continue();
  });
  await page.getByRole('button',{name:'Publish',exact:true}).click();await expect(page.getByRole('button',{name:'Retry comparison revision'})).toBeVisible();await expect(page.getByRole('button',{name:'Prepare corrected submission'})).toBeDisabled();
  holdReload=true;
  try{
    await page.reload();await comparisonStarted.promise;
    await expect(page.getByLabel('Text',{exact:true})).toHaveValue('Preserved conflicting draft');
    await expect(page.getByRole('button',{name:'Prepare corrected submission'})).toBeDisabled();
  }finally{releaseComparison.release();}
  // Restored draft text can render before the comparison fetch fails. Keep the
  // fault active until this reload has actually reached the retry state.
  await expect(page.getByRole('button',{name:'Retry comparison revision'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Prepare corrected submission'})).toBeDisabled();
  fail=false;await page.getByRole('button',{name:'Retry comparison revision'}).click();await expect(page.getByRole('button',{name:'Prepare corrected submission'})).toBeEnabled();
  const old=(await journal(page,'summary.revise'));await page.evaluate(()=>{const original=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k.startsWith('loom.intent.v1:')&&JSON.parse(v).state==='draft'){Storage.prototype.setItem=original;throw new DOMException('Injected save failure','QuotaExceededError');}return original.call(this,k,v);};});
  await page.getByRole('button',{name:'Prepare corrected submission'}).click();await expect(page.getByLabel('Text',{exact:true})).toBeDisabled();expect((await journal(page,'summary.revise')).key).toBe(old.key);
  await page.getByRole('button',{name:'Prepare corrected submission'}).click();await expect(page.getByLabel('Text',{exact:true})).toBeEnabled();await expect(page.getByRole('button',{name:'Publish',exact:true})).toBeDisabled();await page.reload();await expect(page.getByLabel('Text',{exact:true})).toHaveValue('Preserved conflicting draft');
  await page.getByRole('button',{name:'Keep declaration from revision being edited'}).click();await expect(page.getByRole('button',{name:'Publish',exact:true})).toBeEnabled();await page.getByRole('button',{name:'Publish',exact:true}).click();await expect(page.getByText('Your publication is saved.',{exact:true})).toBeVisible();
});

test('lost summary acknowledgement and competing tabs retain exact coverage through browser restart',async({server,diagnostics})=>{
  const directory=await mkdtemp(join(tmpdir(),'loom-summary-browser-')),options={ignoreHTTPSErrors:true,viewport:{width:1280,height:900}};let context=await diagnostics.launchPersistentContext(directory,options);
  try{let page=await context.newPage();const f=await setup(page,context,server);await draft(page,server.origin,f.discussion);await page.getByRole('button',{name:'Prepare declared sources',exact:true}).click();await expect(page.getByText(/Full discussion snapshot/)).toBeVisible();
    const first=await journal(page,'summary.create'),other=await context.newPage();await other.goto(page.url());await expect(other.getByLabel('Text',{exact:true})).toHaveValue(first.body.content.text);
    await page.route('**/api/v1/summaries',async route=>{await route.fetch();await route.abort('failed');});await page.getByRole('button',{name:'Publish',exact:true}).click();await expect(page.getByRole('button',{name:'Retry same publication',exact:true})).toBeVisible();
    await other.getByLabel('Text',{exact:true}).fill('Separate tab text');await expect(other.getByText('Your changes were saved separately.')).toBeVisible();expect((await journal(page,'summary.create',first.key)).body).toEqual(first.body);
    await context.close();context=await diagnostics.launchPersistentContext(directory,options);page=await context.newPage();await page.goto(server.origin+`/loom/discussion/${f.discussion}?summary=create&intent=${first.key}`);
    await expect(page.getByRole('button',{name:'Retry same publication',exact:true})).toBeVisible();await page.getByRole('button',{name:'Retry same publication',exact:true}).click();await expect(page.getByText('Your publication is saved.',{exact:true})).toBeVisible();
    expect((await server.observer.query('SELECT count(*)::int n FROM loom.summaries')).rows[0].n).toBe(1);expect((await journal(page,'summary.create',first.key)).body).toEqual(first.body);
  }finally{await context.close();await rm(directory,{recursive:true,force:true});}
});

test('failed preparation and uncertain expired publication recover explicitly without losing text',async({page,context,server})=>{
  const f=await setup(page,context,server);await draft(page,server.origin,f.discussion);
  await page.route('**/api/v1/summary-preparations',async route=>{await route.fetch();await route.abort('failed');});await page.getByRole('button',{name:'Prepare declared sources',exact:true}).click();await expect(page.getByRole('button',{name:'Retry same source preparation'})).toBeVisible();await f.reply();await page.unroute('**/api/v1/summary-preparations');await page.reload();await page.getByRole('button',{name:'Retry same source preparation'}).click();await expect(page.getByText(/Full discussion snapshot · 1 currently eligible/)).toBeVisible();
  await page.route('**/api/v1/summaries',route=>route.abort('failed'));await page.getByRole('button',{name:'Publish',exact:true}).click();await expect(page.getByRole('button',{name:'Retry same publication'})).toBeVisible();
  await server.observer.query("UPDATE loom.summary_preparations SET expires_at=clock_timestamp()-interval '1 second'");await page.unroute('**/api/v1/summaries');await page.getByRole('button',{name:'Retry same publication'}).click();await expect(page.getByRole('button',{name:'Prepare corrected submission'})).toBeVisible();
  await page.getByRole('button',{name:'Prepare corrected submission'}).click();await expect(page.getByLabel('Text',{exact:true})).toHaveValue('Authored independent summary');await expect(page.getByRole('button',{name:'Publish',exact:true})).toBeDisabled();await page.getByRole('button',{name:'Prepare declared sources',exact:true}).click();await expect(page.getByText(/Full discussion snapshot · 2 currently eligible/)).toBeVisible();
  await page.getByRole('button',{name:'Publish',exact:true}).click();await expect(page.getByText('Your publication is saved.',{exact:true})).toBeVisible();
});

test('summary review regression: successive updates use the current revision and recover failed fetch/save',async({page,context,server})=>{
  const f=await setup(page,context,server);await draft(page,server.origin,f.discussion);
  await page.getByRole('button',{name:'Prepare declared sources',exact:true}).click();
  await expect(page.getByText(/Full discussion snapshot/)).toBeVisible();
  await page.getByRole('button',{name:'Publish',exact:true}).click();
  await expect(page.getByText('Your publication is saved.',{exact:true})).toBeVisible();
  const first=(await journal(page,'summary.create')).result;
  await page.goto(server.origin+'/loom/resource/'+first.resource_id+'?edit=1');
  await page.getByLabel('Text',{exact:true}).fill('First browser update');
  await page.getByRole('button',{name:'Publish',exact:true}).click();
  await expect(page.getByText('Your publication is saved.',{exact:true})).toBeVisible();
  const previous=await journal(page,'summary.revise');
  await page.goto(server.origin+'/loom/resource/'+first.resource_id+'?edit=1');
  const editor=page.getByRole('region',{name:'Edit text',exact:true});
  const start=editor.getByRole('button',{name:'Start another revision',exact:true});
  await expect(start).toBeVisible();

  const content={...authored('Current summary [[mention:mreview]]',[{reference_id:randomUUID(),target:{kind:'contribution' as const,resource_id:f.opening.resource_id,revision_id:f.opening.revision_id},relationship:null,rationale:'Opening evidence'}]),
    mentions:[{token:'mreview',participant_id:f.person}]};
  const current=await f.admin.call('/api/v1/summary-revisions',{idempotency_key:randomUUID(),resource_id:first.resource_id,
    expected_revision_id:previous.result.revision_id,title:'Current summary title',content,coverage:{carry_forward_revision_id:previous.result.revision_id}});
  expect(current.status).toBe(201);expect((await f.reply()).status).toBe(201);
  const currentPath='**/api/v1/resources/'+first.resource_id;
  await page.route(currentPath,route=>route.abort('failed'));
  await start.click();await expect(editor.getByRole('alert')).toBeVisible();await expect(start).toBeEnabled();
  expect(await journal(page,'summary.revise',previous.key)).toEqual(previous);
  await page.unroute(currentPath);
  await page.evaluate(()=>{const original=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){
    if(k.startsWith('loom.intent.v1:')){const record=JSON.parse(v);if(record.kind==='summary.revise'&&record.state==='draft'){
      Storage.prototype.setItem=original;throw new DOMException('Injected summary draft save failure','QuotaExceededError');}}
    return original.call(this,k,v);
  };});
  await start.click();await expect(editor.getByRole('alert')).toHaveText('Injected summary draft save failure');await expect(start).toBeEnabled();
  expect(await journal(page,'summary.revise',previous.key)).toEqual(previous);
  await start.focus();await page.keyboard.press('Enter');
  await expect(page.getByLabel('Text',{exact:true})).toHaveValue(content.text);
  const key=new URL(page.url()).searchParams.get('intent');expect(key).toBeTruthy();expect(key).not.toBe(previous.key);
  const next=await journal(page,'summary.revise',key!);
  expect(next.state).toBe('draft');
  expect(next.body).toEqual({idempotency_key:key,resource_id:first.resource_id,expected_revision_id:current.body.revision_id,
    title:'Current summary title',content,coverage:{carry_forward_revision_id:current.body.revision_id}});
  await page.reload();await expect(page.getByLabel('Text',{exact:true})).toHaveValue(content.text);
  await expect(page.getByLabel('Title',{exact:true})).toHaveValue('Current summary title');
  expect((await journal(page,'summary.revise',key!)).body).toEqual(next.body);
  await page.getByLabel('Text',{exact:true}).fill('Second browser update [[mention:mreview]]');
  await page.getByRole('button',{name:'Publish',exact:true}).click();
  await expect(page.getByText('Your publication is saved.',{exact:true})).toBeVisible();
  const published=(await f.admin.call('/api/v1/resources/'+first.resource_id)).body;
  expect(published.revision_number).toBe('4');expect(published.title).toBe(next.body.title);
  expect(published.content).toEqual({...content,text:'Second browser update [[mention:mreview]]'});
  const coverage=await f.admin.call(`/api/v1/summaries/${first.resource_id}/revisions/${published.revision_id}/coverage`);
  expect(coverage.body.coverage).toEqual({scope:'full',uncovered_eligible:1,changed_eligible:0,unknown:false,comparison:'complete',claim:'author_declared; not_read_or_correctness_proof'});
});

test('summary review regression: generated title publishes at a supplementary Unicode boundary',async({page,context,server})=>{
  const f=await setup(page,context,server,'participant','a'.repeat(150)+'😀');
  await page.goto(server.origin+'/loom/discussion/'+f.discussion);
  await page.getByRole('link',{name:'Create first summary',exact:true}).click();
  await page.getByLabel('Text',{exact:true}).fill('Summary with the generated title');
  await page.getByRole('button',{name:'Prepare declared sources',exact:true}).click();
  await expect(page.getByText(/Full discussion snapshot/)).toBeVisible();
  await page.getByRole('button',{name:'Publish',exact:true}).click();
  await expect(page.getByText('Your publication is saved.',{exact:true})).toBeVisible();
  const saved=(await journal(page,'summary.create')).result;
  const published=await f.admin.call('/api/v1/resources/'+saved.resource_id);
  expect(published.body.title).toBe('Summary: '+'a'.repeat(150));
  expect(published.body.content.text).toBe('Summary with the generated title');
});

test('summary review regression: creation refreshes the optional summary without leaving the discussion',async({page,context,server})=>{
  const f=await setup(page,context,server);await draft(page,server.origin,f.discussion);
  await page.getByRole('button',{name:'Prepare declared sources',exact:true}).click();
  await expect(page.getByText(/Full discussion snapshot/)).toBeVisible();
  await page.getByRole('button',{name:'Publish',exact:true}).click();
  await expect(page.getByText('Your publication is saved.',{exact:true})).toBeVisible();
  const saved=(await journal(page,'summary.create')).result;
  const summary=page.getByRole('region',{name:'Discussion summary',exact:true});
  await expect(summary.getByRole('link',{name:'Human discussion summary',exact:true})).toHaveAttribute('href','/loom/resource/'+saved.resource_id);
  await expect(summary.getByText('No summary has been published.',{exact:true})).toHaveCount(0);
  await expect(summary.getByRole('link',{name:'Create first summary',exact:true})).toHaveCount(0);
  expect(new URL(page.url()).pathname).toBe('/loom/discussion/'+f.discussion);
  await expect(page.getByRole('heading',{name:'A discussion to summarize',exact:true})).toBeVisible();
});
