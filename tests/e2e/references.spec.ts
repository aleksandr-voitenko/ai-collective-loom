import { randomUUID } from 'node:crypto';
import { readFile,mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page,BrowserContext } from '@playwright/test';
import { test,expect } from '../helpers/browser-fixtures.js';
import { httpClient } from '../helpers/participation-http.js';
import type { syntheticServer } from '../helpers/participation-server.js';
import { plain,authored,reference,incoming } from '../helpers/references.js';

function barrier(){let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};}
async function api(page:Page,path:string,body?:unknown){
  const self=await(await page.request.get(new URL('/api/v1/identity/self',page.url()).href)).json();
  const response=body===undefined?await page.request.get(new URL(path,page.url()).href):await page.request.post(new URL(path,page.url()).href,{data:body,headers:{origin:new URL(page.url()).origin,'x-loom-csrf':self.csrf}});
  expect(response.ok()).toBeTruthy();return response.json();
}
async function setup(page:Page,context:BrowserContext,server:Awaited<ReturnType<typeof syntheticServer>>){
  const admin=httpClient(server.origin,await readFile(server.directory+'/cert.pem','utf8'));await admin.enroll(server.ticket);
  expect((await admin.call('/api/v1/community/setup',{idempotency_key:randomUUID(),community_name:'Reference browser',ordinary_area_name:'General',proposal_area_name:'Proposals',overview:plain('Overview')})).status).toBe(201);
  const area=(await admin.call('/api/v1/areas')).body.items.find((r:any)=>r.title==='General').id;
  const person=await admin.call('/api/v1/identity/accounts',{idempotency_key:randomUUID(),nickname:'browser_author',kind:'human',role:'participant'});expect(person.status).toBe(200);
  const ticket=await admin.call('/api/v1/identity/credentials',{idempotency_key:randomUUID(),participant_id:person.body.participant_id,kind:'enrollment',purpose:'enroll',label:'Reference browser',replace_credential_id:null});expect(ticket.status).toBe(200);
  const cdp=await context.newCDPSession(page);await cdp.send('WebAuthn.enable');await cdp.send('WebAuthn.addVirtualAuthenticator',{options:{protocol:'ctap2',transport:'internal',hasResidentKey:true,hasUserVerification:true,isUserVerified:true,automaticPresenceSimulation:true}});
  await page.goto(server.origin+'/loom');await page.getByText('Set up an admitted account',{exact:true}).click();await page.getByLabel('Enrollment ticket',{exact:true}).fill(ticket.body.secret);
  await page.getByRole('button',{name:'Create passkey',exact:true}).click();await expect(page.getByText('Your passkey is ready. Sign in to continue.')).toBeVisible();await page.getByRole('button',{name:'Sign in with passkey'}).click();await expect(page.getByRole('heading',{name:'Topics',exact:true})).toBeVisible();
  const target=await admin.call('/api/v1/artifacts',{idempotency_key:randomUUID(),area_id:area,title:'Target R1',content:plain('Original target text')});expect(target.status).toBe(201);
  return {admin,area,target:target.body,person:person.body.participant_id};
}
async function addReference(page:Page,target:{resource_id:string;revision_id:string},exact=true){
  const editor=page.locator('.reference-editor');await editor.getByRole('button',{name:'Add reference',exact:true}).click();
  await expect(editor.getByLabel('Target ID or Loom link')).toBeFocused();await editor.getByLabel('Target ID or Loom link').fill(target.resource_id);
  if(exact){await editor.getByLabel('Citation scope').selectOption('revision');await editor.getByLabel('Exact revision ID (or include it in the link)').fill(target.revision_id);}
  await editor.getByRole('button',{name:'Check target',exact:true}).click();await editor.getByRole('button',{name:exact?'Use this exact revision':'Use this resource',exact:true}).click();
  await expect(editor.getByRole('button',{name:'Add reference',exact:true})).toBeFocused();
}
async function draft(page:Page,server:Awaited<ReturnType<typeof syntheticServer>>,area:string,title='Browser synthesis'){
  await page.goto(server.origin+'/loom/area/'+area+'?compose=artifacts');await page.getByLabel('Title',{exact:true}).fill(title);await page.getByLabel('Text',{exact:true}).fill('Source authored text <script>inert</script>');
}

test('ordinary human and agent reference publication share targets; exact browsing, keyboard and narrow layout preserve scope',async({page,context,server},info)=>{
  const f=await setup(page,context,server);await draft(page,server,f.area);
  const count=(await server.observer.query('SELECT count(*)::int n FROM loom.shared_activity')).rows[0].n;
  await page.getByRole('button',{name:'Add reference',exact:true}).click();await page.getByLabel('Target ID or Loom link').fill(randomUUID());await page.getByRole('button',{name:'Check target',exact:true}).click();await expect(page.getByRole('alert')).toContainText('unavailable');
  await page.getByLabel('Target ID or Loom link').fill(server.origin+`/loom/resource/${f.target.resource_id}/${f.target.revision_id}`);await page.getByLabel('Citation scope').selectOption('revision');
  await page.getByRole('button',{name:'Check target',exact:true}).click();await page.getByRole('button',{name:'Use this exact revision',exact:true}).focus();await page.keyboard.press('Enter');
  await page.getByRole('combobox',{name:'Relationship 1',exact:true}).selectOption('contradicts');await page.getByLabel('Rationale 1 (required)',{exact:true}).fill('The synthetic measurement differs.');
  expect((await server.observer.query('SELECT count(*)::int n FROM loom.shared_activity')).rows[0].n).toBe(count);
  expect((await server.observer.query('SELECT count(*)::int n FROM loom.search_documents')).rows[0].n).toBe(0);
  await page.getByRole('button',{name:'Publish',exact:true}).click();await expect(page.getByText('Your publication is saved.',{exact:true})).toBeVisible();
  const source=(await server.observer.query('SELECT resource_id,id FROM loom.revisions WHERE title=$1',['Browser synthesis'])).rows[0];
  const stored=(await f.admin.call(`/api/v1/resources/${source.resource_id}/revisions/${source.id}`)).body;
  expect(stored.content.references[0].target).toEqual({kind:'artifact',resource_id:f.target.resource_id,revision_id:f.target.revision_id});expect(stored.publisher.id).toBe(f.person);
  const changed=await f.admin.call('/api/v1/revisions',{idempotency_key:randomUUID(),resource_id:f.target.resource_id,expected_revision_id:f.target.revision_id,title:'Target R2',content:plain('Changed target text')});expect(changed.status).toBe(201);
  await page.getByRole('link',{name:'Inspect exact revision'}).click();await page.getByRole('button',{name:'References',exact:true}).click();
  await expect(page.locator('.reference-row')).toHaveCount(1);await expect(page.locator('.reference-row')).toContainText('Asserted by browser_author');await expect(page.locator('.reference-row')).toContainText('Contradicts');
  await expect(page.locator('.prose script')).toHaveCount(0);
  await page.locator('.reference-row').getByRole('link',{name:'Target R1',exact:true}).click();await expect(page).toHaveURL(server.origin+`/loom/resource/${f.target.resource_id}/${f.target.revision_id}`);await expect(page.getByText('Original target text',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Referenced by',exact:true}).click();await expect(page.getByLabel('Incoming target scope')).toHaveValue('revision');await expect(page.locator('.reference-row')).toHaveCount(1);
  await page.getByLabel('Incoming target scope').selectOption('resource');await expect(page.getByText('No recorded references in this scope.')).toBeVisible();
  await page.getByLabel('Incoming target scope').selectOption('revision');await expect(page.locator('.reference-row')).toHaveCount(1);
  await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.getByRole('button',{name:'Refresh references',exact:true}).focus();await page.keyboard.press('Enter');await expect(page.getByRole('heading',{name:'Recorded reference results'})).toBeFocused();
  await page.screenshot({path:info.outputPath('references-mobile.png'),fullPage:true});
  expect((await server.observer.query('SELECT count(*)::int n FROM loom.saved_items')).rows[0].n).toBe(0);
  const account=await f.admin.call('/api/v1/identity/accounts',{idempotency_key:randomUUID(),nickname:'parity_agent',kind:'agent',role:'participant'});
  const credential=await f.admin.call('/api/v1/identity/credentials',{idempotency_key:randomUUID(),participant_id:account.body.participant_id,kind:'agent',purpose:null,label:'Parity',replace_credential_id:null});
  const agent=httpClient(server.origin,await readFile(server.directory+'/cert.pem','utf8'),credential.body.secret);
  const published=await agent.call('/api/v1/artifacts',{idempotency_key:randomUUID(),area_id:f.area,title:'Agent synthesis',content:authored('Agent text',stored.content.references)});expect(published.status).toBe(201);
  const entries=(await agent.call(incoming(stored.content.references[0].target))).body.items;expect(entries.map((r:any)=>r.original_assertion.participant.id).sort()).toEqual([f.person,account.body.participant_id].sort());
  await page.getByRole('button',{name:'Refresh references',exact:true}).click();await expect(page.locator('.reference-row')).toHaveCount(2);
});

test('reference changes and withdrawal survive stale conflicts, explicit correction and reload',async({page,context,server})=>{
  const f=await setup(page,context,server),refs=[reference({kind:'artifact',resource_id:f.target.resource_id,revision_id:f.target.revision_id},'builds_on','Initial rationale'),reference({kind:'artifact',resource_id:f.target.resource_id})];
  const source=await api(page,'/api/v1/artifacts',{idempotency_key:randomUUID(),area_id:f.area,title:'Editable source',content:authored('Original',refs)});
  await page.goto(server.origin+'/loom/resource/'+source.resource_id+'?edit=1');
  // Canonical declaration order is UUID order, so locate the typed entry explicitly.
  const typed=page.locator('.reference-draft').filter({has:page.locator('select option:checked[value="builds_on"]')});
  await expect(typed.locator('textarea')).toHaveValue('Initial rationale');
  await typed.locator('textarea').fill('Human corrected rationale');
  const untyped=page.locator('.reference-draft').filter({has:page.locator('select option:checked[value=""]')});await untyped.getByRole('button',{name:/Remove reference/}).click();
  await page.getByLabel('Text',{exact:true}).fill('Preserved human correction');
  expect((await f.admin.call('/api/v1/revisions',{idempotency_key:randomUUID(),resource_id:source.resource_id,expected_revision_id:source.revision_id,title:'Editable source',content:authored('Concurrent editor text',refs)})).status).toBe(201);
  await page.getByRole('button',{name:'Publish',exact:true}).click();await expect(page.getByText('Your draft is preserved.')).toBeVisible();await page.reload();
  await expect(page.locator('.reference-editor textarea')).toHaveValue('Human corrected rationale');await expect(page.locator('.reference-draft')).toHaveCount(1);
  await page.getByRole('button',{name:'Prepare corrected submission'}).click();await expect(page.getByLabel('Text',{exact:true})).toBeEnabled();await page.reload();
  await expect(page.getByLabel('Text',{exact:true})).toHaveValue('Preserved human correction');await expect(page.locator('.reference-editor textarea')).toHaveValue('Human corrected rationale');
  await page.getByRole('button',{name:'Publish',exact:true}).click();await expect(page.getByText('Your publication is saved.',{exact:true})).toBeVisible();
  const current=(await f.admin.call('/api/v1/resources/'+source.resource_id)).body;expect(current.content.references).toHaveLength(1);expect(current.content.references[0].rationale).toBe('Human corrected rationale');
  expect((await f.admin.call(incoming({kind:'artifact',resource_id:f.target.resource_id}))).body.items).toEqual([]);
  expect((await f.admin.call(incoming({kind:'artifact',resource_id:f.target.resource_id},{history:'all'}))).body.items.every((r:any)=>r.membership==='withdrawn')).toBe(true);
});

test('lost acknowledgement, competing tabs and browser restart preserve exact reference intent',async({server,diagnostics})=>{
  const directory=await mkdtemp(join(tmpdir(),'loom-reference-browser-')),options={ignoreHTTPSErrors:true,viewport:{width:1280,height:900}};
  let context=await diagnostics.launchPersistentContext(directory,options);
  try{
    let page=await context.newPage();const f=await setup(page,context,server);await draft(page,server,f.area,'Restart source');await addReference(page,f.target);
    await page.getByRole('combobox',{name:'Relationship 1',exact:true}).selectOption('related_to');await page.getByLabel('Rationale 1 (optional)',{exact:true}).fill('Original frozen rationale');
    await expect.poll(async()=>page.evaluate(()=>Object.values(localStorage).some(value=>value.includes('Original frozen rationale')))).toBe(true);
    const original=await page.evaluate(()=>Object.entries(localStorage).filter(([key])=>key.startsWith('loom.intent.v1:')).map(([,value])=>JSON.parse(value)).find(r=>r.kind==='artifact.create'));
    const other=await context.newPage();await other.goto(page.url());await expect(other.locator('.reference-editor textarea')).toHaveValue('Original frozen rationale');
    await page.route('**/api/v1/artifacts',async route=>{await route.fetch();await route.abort('failed');});
    await page.getByRole('button',{name:'Publish',exact:true}).click();await expect(page.getByRole('button',{name:'Retry same publication',exact:true})).toBeVisible();
    await other.locator('.reference-editor textarea').fill('Separately saved rationale');await expect(other.getByText('Your changes were saved separately.')).toBeVisible();
    const separateUrl=other.url();const retained=await page.evaluate((key)=>JSON.parse(localStorage.getItem(key)!),Object.keys(await page.evaluate(()=>({...localStorage}))).find(key=>key.endsWith(original.key))!);
    expect(retained.body.content.references).toEqual(original.body.content.references);expect(retained.state).toBe('uncertain');
    await context.close();context=await diagnostics.launchPersistentContext(directory,options);page=await context.newPage();
    await page.goto(server.origin+`/loom/area/${f.area}?compose=artifacts&intent=${original.key}`);await expect(page.getByRole('button',{name:'Retry same publication',exact:true})).toBeVisible();
    await page.getByRole('button',{name:'Retry same publication',exact:true}).click();await expect(page.getByText('Your publication is saved.',{exact:true})).toBeVisible();
    expect((await server.observer.query('SELECT count(*)::int n FROM loom.revisions WHERE title=$1',['Restart source'])).rows[0].n).toBe(1);
    expect((await server.observer.query('SELECT count(*)::int n FROM loom.revision_references')).rows[0].n).toBe(1);
    await page.goto(separateUrl);await expect(page.locator('.reference-editor textarea')).toHaveValue('Separately saved rationale');await expect(page.getByText('Your changes were saved separately.')).toBeVisible();
  }finally{await context.close();await rm(directory,{recursive:true,force:true});}
});

test('failed autosave cannot dispatch stale references and picker responses belong to their route',async({page,context,server})=>{
  const f=await setup(page,context,server);await draft(page,server,f.area,'Autosave references');await addReference(page,f.target);
  await page.getByRole('combobox',{name:'Relationship 1',exact:true}).selectOption('related_to');await page.getByLabel('Rationale 1 (optional)',{exact:true}).fill('Saved rationale');
  await expect.poll(async()=>page.evaluate(()=>Object.values(localStorage).some(value=>value.includes('Saved rationale')))).toBe(true);
  await page.evaluate(()=>{const original=Storage.prototype.setItem;(window as any).restoreReferenceStorage=()=>{Storage.prototype.setItem=original;};Storage.prototype.setItem=function(key,value){if(key.startsWith('loom.intent.v1:'))throw new Error('Synthetic reference autosave failure');return original.call(this,key,value);};});
  await page.getByRole('textbox',{name:'Rationale 1 (optional)',exact:true}).fill('Visible unsaved rationale');await expect(page.getByRole('alert')).toContainText('Synthetic reference autosave failure');
  await page.getByRole('button',{name:'Publish',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('Synthetic reference autosave failure');await expect(page.getByRole('button',{name:'Publish',exact:true})).toBeEnabled();
  expect((await server.observer.query('SELECT count(*)::int n FROM loom.revision_references')).rows[0].n).toBe(0);
  await page.evaluate(()=>(window as any).restoreReferenceStorage());await page.getByRole('button',{name:'Publish',exact:true}).click();await expect(page.getByText('Your publication is saved.',{exact:true})).toBeVisible();
  expect((await server.observer.query('SELECT rationale FROM loom.revision_references')).rows[0].rationale).toBe('Visible unsaved rationale');
  await page.getByRole('button',{name:'Write another',exact:true}).click();await page.getByRole('button',{name:'Add reference',exact:true}).click();await page.getByLabel('Target ID or Loom link').fill(f.target.resource_id);
  const entered=barrier(),release=barrier();await page.route('**/api/v1/references/target?**',async route=>{const response=await route.fetch();entered.release();await release.promise;await route.fulfill({response}).catch(()=>{});});
  try{await page.getByRole('button',{name:'Check target',exact:true}).click();await entered.promise;await page.getByRole('link',{name:'Artifacts',exact:true}).first().click();release.release();await expect(page.getByRole('heading',{name:'Artifacts',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Use this resource',exact:true})).toHaveCount(0);}
  finally{release.release();await page.unrouteAll({behavior:'wait'});}
});

test('backlink pages preserve failed positions, restart changed views and discard late account results',async({page,context,server})=>{
  const f=await setup(page,context,server),target={kind:'artifact' as const,resource_id:f.target.resource_id};
  const sources=[];for(let i=0;i<14;i++){
    const r=await f.admin.call('/api/v1/artifacts',{idempotency_key:randomUUID(),area_id:f.area,title:'Backlink source '+i,content:authored('Source '+i,[reference(target)])});expect(r.status).toBe(201);sources.push(r.body);
  }
  await page.goto(server.origin+'/loom/resource/'+f.target.resource_id);await page.getByRole('button',{name:'Referenced by',exact:true}).click();await expect(page.locator('.reference-row')).toHaveCount(12);
  let fail=true;await page.route('**/api/v1/references/incoming?**',async route=>{if(fail&&new URL(route.request().url()).searchParams.has('cursor')){fail=false;await route.abort('failed');}else await route.continue();});
  await page.getByRole('button',{name:'Next references',exact:true}).click();await expect(page.getByRole('button',{name:'Retry reference page'})).toBeVisible();await expect(page.locator('.reference-row')).toHaveCount(12);
  await page.getByRole('button',{name:'Retry reference page'}).click();await expect(page.locator('.reference-row')).toHaveCount(2);await expect(page.getByRole('heading',{name:'Recorded reference results'})).toBeFocused();
  await page.getByRole('button',{name:'Refresh references',exact:true}).click();await expect(page.locator('.reference-row')).toHaveCount(12);
  const source=sources[0];expect((await f.admin.call('/api/v1/revisions',{idempotency_key:randomUUID(),resource_id:source.resource_id,expected_revision_id:source.revision_id,title:'Withdrawn source',content:authored('Withdrawn',[])})).status).toBe(201);
  await page.getByRole('button',{name:'Next references',exact:true}).click();await expect(page.getByRole('alert')).toContainText('changed or expired');
  await page.getByRole('button',{name:'Refresh references',exact:true}).click();await expect(page.locator('.reference-row')).toHaveCount(12);await page.getByLabel('Source membership').selectOption('all');await expect(page.locator('.reference-row')).toHaveCount(12);
  await page.unrouteAll({behavior:'wait'});
  const entered=barrier(),release=barrier();await page.route('**/api/v1/references/incoming?**',async route=>{const response=await route.fetch();entered.release();await release.promise;await route.fulfill({response}).catch(()=>{});});
  try{await page.getByRole('button',{name:'Refresh references',exact:true}).click();await entered.promise;await page.getByRole('button',{name:'Sign out',exact:true}).click();
    const confirm=page.getByRole('button',{name:'Clear local drafts and sign out'});if(await confirm.isVisible())await confirm.click();await expect(page.getByRole('button',{name:'Sign in with passkey'})).toBeVisible();release.release();await expect(page.locator('.reference-row')).toHaveCount(0);
  }finally{release.release();await page.unrouteAll({behavior:'wait'});}
});

test('an uncertain v1 edit never adopts references from a newer v2 source after reload',async({page,context,server})=>{
  const f=await setup(page,context,server);
  const source=await api(page,'/api/v1/artifacts',{idempotency_key:randomUUID(),area_id:f.area,title:'Legacy editor',content:plain('Legacy original')});
  await page.goto(server.origin+'/loom/resource/'+source.resource_id+'?edit=1');await page.getByLabel('Text',{exact:true}).fill('Legacy pending revision');
  await page.route('**/api/v1/revisions',async route=>{await route.fetch();await route.abort('failed');});
  await page.getByRole('button',{name:'Publish',exact:true}).click();await expect(page.getByRole('button',{name:'Retry same publication',exact:true})).toBeVisible();
  const retained=await page.evaluate(()=>Object.entries(localStorage).filter(([key])=>key.startsWith('loom.intent.v1:')).map(([,value])=>JSON.parse(value)).find(r=>r.kind==='revision.publish'));
  const pending=(await f.admin.call('/api/v1/resources/'+source.resource_id)).body;
  const current=await f.admin.call('/api/v1/revisions',{idempotency_key:randomUUID(),resource_id:source.resource_id,expected_revision_id:pending.revision_id,title:'New reference edit',content:authored('A later v2 revision',[reference({kind:'artifact',resource_id:f.target.resource_id})])});expect(current.status).toBe(201);
  await page.unrouteAll({behavior:'wait'});await page.reload();await expect(page.getByRole('button',{name:'Retry same publication',exact:true})).toBeVisible();
  await expect(page.locator('.reference-draft')).toHaveCount(0);
  await expect(page.getByRole('textbox',{name:'Text',exact:true})).toHaveValue('Legacy pending revision');
  await page.getByRole('button',{name:'Retry same publication',exact:true}).click();await expect(page.getByText('Your publication is saved.',{exact:true})).toBeVisible();
  const recovered=await page.evaluate(key=>Object.entries(localStorage).filter(([name])=>name.endsWith(key)).map(([,value])=>JSON.parse(value))[0],retained.key);
  expect(recovered.body).toEqual(retained.body);expect(recovered.result.revision_id).toBe(pending.revision_id);
  expect((await f.admin.call('/api/v1/resources/'+source.resource_id)).body.revision_id).toBe(current.body.revision_id);
});

for (const mode of ['empty references','recorded references','format refusal']) test(`a rejected v1 draft corrects to a v2 base after ${mode}`,async({page,context,server})=>{
  const f=await setup(page,context,server);
  const source=await api(page,'/api/v1/artifacts',{idempotency_key:randomUUID(),area_id:f.area,title:'Legacy correction',content:plain('Original v1 text')});
  const saved=()=>page.evaluate(resource=>Object.entries(localStorage).filter(([key])=>key.startsWith('loom.intent.v1:'))
    .map(([,value])=>JSON.parse(value)).find(r=>r.kind==='revision.publish'&&r.body.resource_id===resource),source.resource_id);
  await page.goto(server.origin+'/loom/resource/'+source.resource_id+'?edit=1');
  await page.getByRole('textbox',{name:'Text',exact:true}).fill('Preserved legacy correction');
  await expect.poll(saved).toMatchObject({state:'draft',body:{content:plain('Preserved legacy correction')}});
  let original=await saved();
  const refs=mode==='empty references'?[]:[reference({kind:'artifact',resource_id:f.target.resource_id,revision_id:f.target.revision_id},'builds_on','Keep the current assertion')];
  const current=await f.admin.call('/api/v1/revisions',{idempotency_key:randomUUID(),resource_id:source.resource_id,expected_revision_id:source.revision_id,title:'Concurrent v2 source',content:authored('Concurrent text',refs)});
  expect(current.status).toBe(201);
  if(mode==='format refusal') {
    // Model an older client's unsent v1 journal against an already-v2 base.
    // This also represents the refused draft left by the earlier correction bug.
    await page.evaluate(({key,revision})=>{
      const entry=Object.entries(localStorage).find(([name])=>name.startsWith('loom.intent.v1:')&&name.endsWith(key))!;
      const record=JSON.parse(entry[1]);record.body.expected_revision_id=revision;record.sequence++;
      localStorage.setItem(entry[0],JSON.stringify(record));
    },{key:original.key,revision:current.body.revision_id});
    original=await saved();
  }
  const comparison=server.origin+`/api/v1/resources/${source.resource_id}/revisions/${current.body.revision_id}`;
  if(mode==='recorded references')await page.route(comparison,route=>route.abort('failed'));
  await page.goto(server.origin+`/loom/resource/${source.resource_id}?edit=1&intent=${original.key}`);
  await expect(page.getByRole('textbox',{name:'Text',exact:true})).toHaveValue('Preserved legacy correction');
  await expect(page.locator('.reference-draft')).toHaveCount(0);
  await page.getByRole('button',{name:'Publish',exact:true}).click();
  await expect(page.getByText('Your draft is preserved.',{exact:true})).toBeVisible();
  expect((await saved()).body).toEqual(original.body);
  if(mode==='format refusal') {
    expect((await saved()).conflict_revision_id).toBeUndefined();
    await expect(page.getByRole('alert')).toContainText('loom-markdown-v2');
  }
  if(mode==='recorded references') {
    await expect(page.getByRole('button',{name:'Prepare corrected submission',exact:true})).toBeDisabled();
    await expect(page.getByText('The comparison revision could not be loaded. Your draft is preserved.')).toBeVisible();
    await page.unroute(comparison);
    await page.getByRole('button',{name:'Retry comparison revision',exact:true}).click();
  }
  await expect(page.getByText(/^Current revision 2 by /)).toBeVisible();
  await expect(page.getByText('The comparison revision’s references will be copied into your corrected draft. Review or remove them before publishing.')).toBeVisible();
  if(mode==='recorded references') {
    await page.evaluate(()=>{
      const write=Storage.prototype.setItem;
      Storage.prototype.setItem=function(key,value){if(key.startsWith('loom.intent.v1:'))throw new Error('Synthetic correction save failure');write.call(this,key,value);};
      (window as any).restoreCorrectionStorage=()=>{Storage.prototype.setItem=write;};
    });
    await page.getByRole('button',{name:'Prepare corrected submission',exact:true}).click();
    await expect(page.getByRole('alert')).toContainText('Synthetic correction save failure');
    await expect(page.getByRole('button',{name:'Prepare corrected submission',exact:true})).toBeEnabled();
    expect(await saved()).toMatchObject({key:original.key,state:'rejected',body:original.body});
    await expect(page.locator('.reference-draft')).toHaveCount(0);
    await page.evaluate(()=>(window as any).restoreCorrectionStorage());
  }
  await page.getByRole('button',{name:'Prepare corrected submission',exact:true}).click();
  await expect(page.getByRole('textbox',{name:'Text',exact:true})).toBeEnabled();
  await page.reload();
  await expect(page.getByRole('textbox',{name:'Text',exact:true})).toHaveValue('Preserved legacy correction');
  await expect(page.locator('.reference-draft')).toHaveCount(refs.length);
  if(refs.length)await expect(page.getByRole('textbox',{name:'Rationale 1 (required)',exact:true})).toHaveValue(refs[0]!.rationale!);
  const retained=await saved();
  expect(retained.body.content).toEqual(authored('Preserved legacy correction',refs));
  if(mode==='format refusal') {
    await page.getByRole('button',{name:'Remove reference 1',exact:true}).click();
    await expect.poll(saved).toMatchObject({body:{content:authored('Preserved legacy correction',[])}});
  }
  const expectedReferences=mode==='format refusal'?[]:refs,corrected=await saved();
  const publication=page.waitForResponse(response=>response.url()===server.origin+'/api/v1/revisions'&&response.request().method()==='POST');
  await page.getByRole('button',{name:'Publish',exact:true}).click();
  expect((await publication).status()).toBe(201);
  await expect(page.getByText('Your publication is saved.',{exact:true})).toBeVisible();
  expect(corrected.key).not.toBe(original.key);
  expect(corrected.body).toEqual({...original.body,idempotency_key:corrected.key,expected_revision_id:current.body.revision_id,content:authored('Preserved legacy correction',expectedReferences)});
  expect(new URL(page.url()).searchParams.get('intent')).toBe(corrected.key);
  const published=(await f.admin.call('/api/v1/resources/'+source.resource_id)).body;
  expect(published.content).toEqual(authored('Preserved legacy correction',expectedReferences));
  expect(published.revision_number).toBe('3');
  expect(published.publisher.id).toBe(f.person);
});
