import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import type {Page} from '@playwright/test';
import {test,expect} from '../helpers/browser-fixtures.js';
import {setup,api,journal} from '../helpers/change-browser.js';
import {content,note,exactPair,revisionBody,notePath,coveragePath} from '../helpers/changes.js';
import {authored,reference,incoming} from '../helpers/references.js';
function barrier(){let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};}
async function addNote(page:Page,text:string){await page.getByLabel('Add a revision change note',{exact:true}).check();await page.getByLabel('Change note',{exact:true}).fill(text);}
async function accountTarget(page:Page,target:{resource_id:string;revision_id:string}){
  await page.getByLabel('Described resource ID or exact Loom link').fill(`/loom/resource/${target.resource_id}/${target.revision_id}`);
  await page.getByRole('button',{name:'Check described revision',exact:true}).click();
  await page.getByRole('button',{name:'Describe this exact revision',exact:true}).focus();await page.keyboard.press('Enter');
}

test('revision notes and ordinary accounts have distinct authors, immutable exact scope, keyboard discovery and narrow rendering',async({page,context,server},info)=>{
  const f=await setup(page,context,server),r1=await api(page,'/api/v1/artifacts',{idempotency_key:randomUUID(),area_id:f.area,title:'Editor’s resource',content:authored('R1 original')});
  await page.goto(server.origin+'/loom/resource/'+r1.resource_id+'?edit=1');await expect(page.getByLabel('Add a revision change note')).not.toBeChecked();
  await page.getByLabel('Text',{exact:true}).fill('R2 material');await addNote(page,'Clarifies the evidence <script>inert</script>');
  await page.getByRole('button',{name:'Mention someone in the note'}).click();await page.getByRole('button',{name:'Mention @synthetic_admin in note',exact:true}).click();
  await expect.poll(async()=>(await journal(page,'revision.publish'))?.body.change_note?.mentions.length).toBe(1);
  await page.reload();await expect(page.getByLabel('Change note',{exact:true})).toHaveValue(/Clarifies the evidence/);
  const draft=await journal(page,'revision.publish');expect(draft.body.change_note.mentions).toHaveLength(1);
  await page.getByRole('button',{name:'Publish',exact:true}).click();await expect(page.getByText('Your publication is saved.',{exact:true})).toBeVisible();const r2=(await journal(page,'revision.publish')).result;
  await page.getByRole('button',{name:'Start another revision',exact:true}).click();await expect(page.getByLabel('Text',{exact:true})).toHaveValue('R2 material');await expect(page.getByLabel('Add a revision change note')).not.toBeChecked();
  await page.getByLabel('Text',{exact:true}).fill('R3 material');await page.getByRole('button',{name:'Publish',exact:true}).click();await expect(page.getByText('Your publication is saved.',{exact:true})).toBeVisible();
  expect((await f.admin.call(notePath(r2))).body.content).toEqual(draft.body.change_note);
  const opening=await f.admin.call('/api/v1/discussions',{idempotency_key:randomUUID(),area_id:f.area,title:'Independent accounts',content:authored('Discussion')});expect(opening.status).toBe(201);
  const discussion=(await f.admin.call('/api/v1/resources/'+opening.body.resource_id)).body.discussion_id;
  // Browser author has no editor rights on the described target created by admin.
  await page.goto(server.origin+'/loom/discussion/'+discussion);await page.getByRole('button',{name:'Reply',exact:true}).first().click();
  await page.getByLabel('Your reply',{exact:true}).fill('My independent explanation');await page.getByLabel('Explain a declared set of changes in this post').check();await accountTarget(page,f.target);
  await expect(page.getByLabel('Described resource ID or exact Loom link')).toBeFocused();await page.getByRole('button',{name:'Post reply',exact:true}).click();await expect(page.getByText('Your reply was posted.',{exact:true})).toBeVisible();
  const account=(await journal(page,'reply.create')).result;expect((await f.admin.call(coveragePath(account))).body.source.author.id).toBe(f.person);
  await page.goto(server.origin+`/loom/resource/${r2.resource_id}/${r2.revision_id}`);await expect(page.getByText(/Editor’s note for revision 2/)).toBeVisible();await expect(page.locator('.change-details script')).toHaveCount(0);
  await page.getByRole('button',{name:'Discover change explanations'}).click();await page.getByLabel('Explanation history').selectOption('all');await expect(page.getByRole('link',{name:/Editor’s revision note/})).toBeVisible();
  await page.getByRole('button',{name:'Refresh explanations'}).focus();await expect(page.getByRole('button',{name:'Refresh explanations'})).toBeEnabled();await page.keyboard.press('Enter');await expect(page.getByRole('heading',{name:'Change explanations',exact:true})).toBeFocused();
  // Deliberately curated synthetic screen evidence, separate from diagnostics.
  await page.screenshot({path:info.outputPath('note-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:info.outputPath('note-mobile.png'),fullPage:true});
  await page.goto(server.origin+`/loom/resource/${account.resource_id}/${account.revision_id}`);await expect(page.getByRole('heading',{name:'Change account by browser_author'})).toBeVisible();await expect(page.getByText('End of the selected declaration. Unavailable members remain undisclosed.')).toBeVisible();
  await page.screenshot({path:info.outputPath('account-mobile.png'),fullPage:true});
});

test('note autosave failure, stale rejection, correction and reload preserve all attempted fields',async({page,context,server})=>{
  const f=await setup(page,context,server),r1=await api(page,'/api/v1/artifacts',{idempotency_key:randomUUID(),area_id:f.area,title:'Recovery resource',content:content('Original'),change_note:note('Old note'),change_account:null});
  await page.goto(server.origin+'/loom/resource/'+r1.resource_id+'?edit=1');await addNote(page,'Attempted explanation');await page.getByLabel('Text',{exact:true}).fill('Attempted main');
  await expect.poll(async()=>(await journal(page,'revision.publish'))?.body.content.text).toBe('Attempted main');
  await page.evaluate(()=>{const original=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k.startsWith('loom.intent.v1:')){Storage.prototype.setItem=original;throw new DOMException('Injected note save failure','QuotaExceededError');}return original.call(this,k,v);};});
  await page.getByLabel('Change note',{exact:true}).fill('Retained after failed save');await expect(page.getByRole('alert')).toContainText('Injected note save failure');await expect(page.getByLabel('Change note',{exact:true})).toHaveValue('Retained after failed save');
  const newer=await f.admin.call('/api/v1/revisions',revisionBody(r1,'Concurrent main',note('Concurrent explanation')));expect(newer.status).toBe(201);
  await page.getByRole('button',{name:'Publish',exact:true}).click();await expect(page.getByRole('button',{name:'Prepare corrected submission'})).toBeVisible();await page.reload();await expect(page.getByLabel('Change note',{exact:true})).toHaveValue('Retained after failed save');
  const old=await journal(page,'revision.publish');await page.getByRole('button',{name:'Prepare corrected submission'}).click();await expect(page.getByLabel('Text',{exact:true})).toBeEnabled();await page.reload();
  const corrected=await journal(page,'revision.publish');expect(corrected.key).not.toBe(old.key);expect(corrected.body.change_note).toEqual(old.body.change_note);expect(corrected.body.expected_revision_id).toBe(newer.body.revision_id);await expect(page.getByLabel('Text',{exact:true})).toHaveValue('Attempted main');
  await page.getByRole('button',{name:'Publish',exact:true}).click();await expect(page.getByText('Your publication is saved.',{exact:true})).toBeVisible();
  expect((await f.admin.call(notePath((await journal(page,'revision.publish')).result))).body.content).toEqual(corrected.body.change_note);
});

test('v2 to v3 correction preserves added, edited and withdrawn references after reload and publication',async({page,context,server})=>{
  const f=await setup(page,context,server),refs=[reference(exactPair(f.target),'builds_on','Initial rationale'),reference({kind:'artifact',resource_id:f.target.resource_id})];
  const added=await f.admin.call('/api/v1/artifacts',{idempotency_key:randomUUID(),area_id:f.area,title:'Added target',content:authored('Added target')});expect(added.status).toBe(201);
  const source=await api(page,'/api/v1/artifacts',{idempotency_key:randomUUID(),area_id:f.area,title:'V2 correction',content:authored('Original',refs)});
  await page.goto(server.origin+'/loom/resource/'+source.resource_id+'?edit=1');
  // Canonical order is by reference ID, so select the existing relationship explicitly.
  const edited=page.locator('.reference-draft').filter({has:page.locator('select option:checked[value="builds_on"]')});
  await edited.locator('textarea').fill('Attempted rationale');
  await page.locator('.reference-draft').filter({has:page.locator('select option:checked[value=""]')}).getByRole('button',{name:/Remove reference/}).click();
  await page.getByRole('button',{name:'Add reference',exact:true}).click();await page.getByLabel('Target ID or Loom link').fill(added.body.resource_id);
  await page.getByRole('button',{name:'Check target',exact:true}).click();await page.getByRole('button',{name:'Use this resource',exact:true}).click();
  await page.getByRole('combobox',{name:'Relationship 2',exact:true}).selectOption('related_to');await page.getByLabel('Rationale 2 (optional)',{exact:true}).fill('Added rationale');
  await page.getByLabel('Text',{exact:true}).fill('Attempted main');
  await expect.poll(async()=>(await journal(page,'revision.publish'))?.body.content.text).toBe('Attempted main');
  const attempted=await journal(page,'revision.publish');
  expect(attempted.body.content).toEqual({...authored('Attempted main'),references:[
    {...refs[0]!,rationale:'Attempted rationale'},
    {reference_id:expect.any(String),target:{kind:'artifact',resource_id:added.body.resource_id},relationship:'related_to',rationale:'Added rationale'},
  ]});
  const newer=await f.admin.call('/api/v1/revisions',{...revisionBody(source,'Concurrent main',note('Concurrent explanation')),content:content('Concurrent main',refs)});expect(newer.status).toBe(201);
  await page.getByRole('button',{name:'Publish',exact:true}).click();await expect(page.getByText('Your draft is preserved.',{exact:true})).toBeVisible();await page.reload();
  await expect(page.getByRole('button',{name:'Prepare corrected submission'})).toBeEnabled();
  const rejected=await journal(page,'revision.publish');expect(rejected.body).toEqual(attempted.body);expect(rejected.state).toBe('rejected');
  await page.getByRole('button',{name:'Prepare corrected submission'}).click();await expect(page.getByLabel('Text',{exact:true})).toBeEnabled();await page.reload();
  await expect(page.getByLabel('Text',{exact:true})).toHaveValue('Attempted main');
  const corrected=await journal(page,'revision.publish');
  expect(corrected.body.content).toEqual({...attempted.body.content,format:'loom-markdown-v3'});
  expect(corrected.key).not.toBe(rejected.key);expect(await journal(page,'revision.publish',rejected.key)).toBeUndefined();
  expect(corrected.body).toEqual({...attempted.body,idempotency_key:corrected.key,expected_revision_id:newer.body.revision_id,
    content:{...attempted.body.content,format:'loom-markdown-v3'},change_note:null,change_account:null});
  await expect(page.locator('.reference-draft')).toHaveCount(2);await expect(edited.locator('textarea')).toHaveValue('Attempted rationale');
  await expect(page.locator('.reference-draft').filter({has:page.locator('select option:checked[value="related_to"]')}).locator('textarea')).toHaveValue('Added rationale');
  await expect(page.getByLabel('Add a revision change note')).not.toBeChecked();
  await page.getByRole('button',{name:'Publish',exact:true}).click();await expect(page.getByText('Your publication is saved.',{exact:true})).toBeVisible();
  const current=(await f.admin.call('/api/v1/resources/'+source.resource_id)).body;
  expect(current.content).toEqual({...corrected.body.content,references:[...corrected.body.content.references].sort((a,b)=>a.reference_id.localeCompare(b.reference_id))});
  expect((await f.admin.call(incoming({kind:'artifact',resource_id:f.target.resource_id}))).body.items).toEqual([]);
  const withdrawn=(await f.admin.call(incoming({kind:'artifact',resource_id:f.target.resource_id},{history:'all'}))).body.items;
  expect(withdrawn.length).toBeGreaterThan(0);expect(withdrawn.every((item:any)=>item.membership==='withdrawn')).toBe(true);
});

test('uncertain notes survive competing tabs and browser restart without copying or changing the original request',async({server,diagnostics})=>{
  const directory=await mkdtemp(join(tmpdir(),'loom-change-browser-')),options={ignoreHTTPSErrors:true,viewport:{width:1280,height:900}};let context=await diagnostics.launchPersistentContext(directory,options);
  try{let page=await context.newPage();const f=await setup(page,context,server);await page.goto(server.origin+'/loom/area/'+f.area+'?compose=artifacts');await page.getByLabel('Title',{exact:true}).fill('Frozen note publication');await page.getByLabel('Text',{exact:true}).fill('Frozen main');await addNote(page,'Frozen note');
    await expect.poll(async()=>(await journal(page,'artifact.create'))?.body.change_note?.text).toBe('Frozen note');const before=await journal(page,'artifact.create'),other=await context.newPage();await other.goto(page.url());await expect(other.getByLabel('Change note',{exact:true})).toHaveValue('Frozen note');
    await page.route('**/api/v1/artifacts',async route=>{await route.fetch();await route.abort('failed');});await page.getByRole('button',{name:'Publish',exact:true}).click();await expect(page.getByRole('button',{name:'Retry same publication'})).toBeVisible();
    await other.getByLabel('Change note',{exact:true}).fill('Separate tab note');await expect(other.getByText('Your changes were saved separately.')).toBeVisible();expect((await journal(page,'artifact.create',before.key)).body).toEqual(before.body);
    await context.close();context=await diagnostics.launchPersistentContext(directory,options);page=await context.newPage();await page.goto(server.origin+`/loom/area/${f.area}?compose=artifacts&intent=${before.key}`);await expect(page.getByRole('button',{name:'Retry same publication'})).toBeVisible();await expect(page.getByLabel('Change note',{exact:true})).toHaveValue('Frozen note');
    await page.getByRole('button',{name:'Retry same publication'}).click();await expect(page.getByText('Your publication is saved.',{exact:true})).toBeVisible();expect((await journal(page,'artifact.create',before.key)).body).toEqual(before.body);
    expect((await server.observer.query('SELECT count(*)::int n FROM loom.revision_change_notes')).rows[0].n).toBe(1);
  }finally{await context.close();await rm(directory,{recursive:true,force:true});}
});

test('late account selection preserves newer typing; reload and uncertain retry retain its complete declaration',async({page,context,server})=>{
  const f=await setup(page,context,server);await page.goto(server.origin+'/loom/area/'+f.area+'?compose=discussions');await page.getByLabel('Title',{exact:true}).fill('Account draft');await page.getByLabel('Text',{exact:true}).fill('Initial typing');await page.getByLabel('Explain a declared set of changes in this post').check();
  const entered=barrier(),release=barrier();await page.route('**/api/v1/references/target?*',async route=>{const response=await route.fetch();entered.release();await release.promise;await route.fulfill({response});});
  await page.getByLabel('Described resource ID or exact Loom link').fill(`/loom/resource/${f.target.resource_id}/${f.target.revision_id}`);await page.getByRole('button',{name:'Check described revision'}).click();
  try{await entered.promise;await page.getByLabel('Text',{exact:true}).fill('Latest typing while checking a target');}finally{release.release();}
  await page.getByRole('button',{name:'Describe this exact revision'}).click();await page.unroute('**/api/v1/references/target?*');await expect.poll(async()=>(await journal(page,'discussion.create'))?.body.change_account?.revisions).toEqual([exactPair(f.target)]);await page.reload();await expect(page.getByLabel('Text',{exact:true})).toHaveValue('Latest typing while checking a target');
  const before=await journal(page,'discussion.create');expect(before.body.change_account.revisions).toEqual([exactPair(f.target)]);expect(before.body.content.references).toHaveLength(1);
  await page.route('**/api/v1/discussions',route=>route.abort('failed'));await page.getByRole('button',{name:'Publish',exact:true}).click();await expect(page.getByRole('button',{name:'Retry same publication'})).toBeVisible();await page.reload();await expect(page.getByRole('button',{name:'Retry same publication'})).toBeVisible();expect((await journal(page,'discussion.create')).body).toEqual(before.body);
  await page.unroute('**/api/v1/discussions');await page.getByRole('button',{name:'Retry same publication'}).click();await expect(page.getByText('Your publication is saved.',{exact:true})).toBeVisible();expect((await f.admin.call(coveragePath((await journal(page,'discussion.create')).result))).body.items[0].target).toEqual(exactPair(f.target));
});

test('account conflict can explicitly carry the comparison declaration without disclosing unavailable targets',async({page,context,server})=>{
  const f=await setup(page,context,server),account=await api(page,'/api/v1/discussions',{idempotency_key:randomUUID(),area_id:f.area,title:'Carry account',
    content:content('Original explanation'),change_note:null,change_account:{revisions:[exactPair(f.target)]}});
  await page.goto(server.origin+'/loom/resource/'+account.resource_id+'?edit=1');await page.getByLabel('Text',{exact:true}).fill('My unrelated correction');
  const newer=await f.admin.call('/api/v1/revisions',{idempotency_key:randomUUID(),resource_id:account.resource_id,expected_revision_id:account.revision_id,title:'Carry account',
    content:content('Concurrent explanation'),change_note:null,change_account:{carry_forward_revision_id:account.revision_id}});expect(newer.status).toBe(201);
  await server.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='suppressed' WHERE id=$1",[f.target.resource_id]));
  await page.getByRole('button',{name:'Publish',exact:true}).click();await expect(page.getByRole('button',{name:'Prepare corrected submission'})).toBeVisible();
  const rejected=await journal(page,'revision.publish');await page.getByRole('button',{name:'Prepare corrected submission'}).click();
  await expect(page.getByRole('button',{name:'Publish',exact:true})).toBeDisabled();await expect(page.getByLabel('Text',{exact:true})).toHaveValue('My unrelated correction');
  expect((await journal(page,'revision.publish')).body.change_account).toEqual(rejected.body.change_account);
  await page.getByRole('button',{name:'Keep declaration from comparison revision'}).click();await expect.poll(async()=>(await journal(page,'revision.publish')).body.change_account).toEqual({carry_forward_revision_id:newer.body.revision_id});
  await page.reload();await expect(page.getByLabel('Text',{exact:true})).toHaveValue('My unrelated correction');await page.getByRole('button',{name:'Publish',exact:true}).click();await expect(page.getByText('Your publication is saved.',{exact:true})).toBeVisible();
  const result=(await journal(page,'revision.publish')).result,coverage=(await f.admin.call(coveragePath(result))).body;expect(coverage.unknown).toBe(true);expect(coverage.items).toEqual([]);expect(JSON.stringify(coverage)).not.toContain(f.target.resource_id);
});
