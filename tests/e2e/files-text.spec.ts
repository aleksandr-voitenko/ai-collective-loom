import {readFile} from 'node:fs/promises';
import {fileTest as test,expect} from '../helpers/browser-fixtures.js';
import {setup,journal,api} from '../helpers/change-browser.js';
import {randomUUID} from 'node:crypto';
import {NativeSearchWorker} from '../../scripts/lib/native-search-worker.js';
import {prepareText} from '../helpers/file-text.js';

test('Files search opens exact inert text pages, preserves tree/search navigation and downloads original bytes',async({page,context,server})=>{
  const f=await setup(page,context,server),external:string[]=[];
  page.on('request',request=>{if(!request.url().startsWith(server.origin))external.push(request.url());});
  const bytes=Buffer.from('quartzneedle <script>globalThis.__loomUploaded=1</script> <img src="https://invalid.test/image"> @browser_author\r\n'+'longline'.repeat(1200));
  await page.goto(server.origin+`/loom/area/${f.area}?compose=artifacts`);
  await page.getByLabel('Title',{exact:true}).fill('Manuscript package');
  for(const input of [{name:'chapter.md',path:'chapters/manuscript.md',type:'text/markdown',bytes},{name:'source.ts',path:'src/module.ts',type:'text/plain',bytes:Buffer.from('export const inert = "softwarepayload";')},{name:'opaque.zip',path:'archive.zip',type:'application/zip',bytes:Buffer.from('PK opaque')}]){
    await page.getByLabel('Select file',{exact:true}).setInputFiles({name:input.name,mimeType:input.type,buffer:input.bytes});await page.getByLabel('Relative path',{exact:true}).fill(input.path);
    await page.getByRole('button',{name:'Keep file selection',exact:true}).click();await page.getByRole('button',{name:'Upload and prepare '+input.path,exact:true}).click();
    await expect(page.getByRole('button',{name:'Upload and prepare '+input.path,exact:true})).toHaveCount(0);
  }
  await page.getByRole('button',{name:'Publish',exact:true}).click();await expect(page.getByText('Your publication is saved.',{exact:true})).toBeVisible();
  const published=(await journal(page,'artifact.create')).result;
  await page.goto(server.origin+`/loom/resource/${published.resource_id}/${published.revision_id}`);
  await page.getByRole('button',{name:'Open folder chapters',exact:true}).click();
  await expect(page.getByRole('link',{name:'Text processing chapters/manuscript.md',exact:true})).toBeVisible();
  const worker=new NativeSearchWorker(server.configuration,'file-text',server.fileFixture!.storage.configuration);
  try{
    await worker.start();await worker.observeUntil(async()=>(await server.observer.query('SELECT count(*)::int AS n FROM loom.file_text_documents')).rows[0].n===3);await worker.stop();
    await page.reload();await expect(page.getByRole('link',{name:'Text preview chapters/manuscript.md',exact:true})).toBeVisible();
    await page.getByRole('link',{name:'Text preview chapters/manuscript.md',exact:true}).focus();await page.keyboard.press('Enter');
    await expect(page.getByRole('heading',{name:'Literal text preview',exact:true})).toBeFocused();
    await expect(page.getByLabel('Literal file text')).toContainText('<script>globalThis.__loomUploaded=1</script>');
    expect(await page.evaluate(()=>typeof (globalThis as any).__loomUploaded)).toBe('undefined');expect(external).toEqual([]);
    await page.getByRole('button',{name:'Next text page',exact:true}).click();await expect(page.getByLabel('Literal file text')).not.toContainText('quartzneedle');
    await page.goBack();await expect(page.getByLabel('Literal file text')).toContainText('quartzneedle');
    const download=page.waitForEvent('download');await page.getByRole('button',{name:'Download original chapters/manuscript.md',exact:true}).click();expect(await readFile((await (await download).path())!)).toEqual(bytes);
    await page.getByRole('button',{name:'Back',exact:true}).click();await expect(page.getByRole('heading',{name:'Revision files',exact:true})).toBeFocused();
    await expect(page.getByRole('link',{name:'Text preview chapters/manuscript.md',exact:true})).toBeVisible();
    await page.goto(server.origin+'/loom/search');await page.getByLabel('Search mode',{exact:true}).selectOption('files');await page.getByLabel('Search terms',{exact:true}).fill('quartzneedle');await page.getByRole('button',{name:'Search files',exact:true}).click();
    await expect(page.getByRole('link',{name:'chapters/manuscript.md',exact:true})).toBeVisible();await expect(page.getByText('Partial literal text excerpt',{exact:true})).toBeVisible();
    const query=page.url();await page.getByRole('link',{name:'Open exact text preview',exact:true}).click();await expect(page.getByLabel('Literal file text')).toContainText('quartzneedle');
    await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.getByLabel('Literal file text').focus();await expect(page.getByLabel('Literal file text')).toBeFocused();
    await page.goBack();expect(page.url()).toBe(query);await expect(page.getByRole('heading',{name:'Search results',exact:true})).toBeFocused();
    expect((await server.observer.query('SELECT count(*)::int AS n FROM loom.revision_mentions WHERE revision_id=$1',[published.revision_id])).rows[0].n).toBe(0);
    expect((await server.observer.query('SELECT count(*)::int AS n FROM loom.reading_states WHERE resource_id=$1',[published.resource_id])).rows[0].n).toBe(0);
    expect(external).toEqual([]);
    await page.goto(server.origin+`/loom/file/artifact/${published.resource_id}/${published.revision_id}/${(await api(page,`/api/v1/artifacts/${published.resource_id}/revisions/${published.revision_id}/files?prefix=chapters`)).items[0].file_id}?cursor=expired`);
    await expect(page.getByRole('alert')).toBeVisible();await page.getByRole('link',{name:'First text page',exact:true}).click();await expect(page.getByLabel('Literal file text')).toContainText('quartzneedle');
  }finally{await worker.stop();}
});

test('Files contexts keep promoted artifacts and eligible replies independent while suppressed sources stay hidden',async({page,context,server})=>{
  const f=await setup(page,context,server),parent=(await f.admin.call('/api/v1/discussions',{idempotency_key:randomUUID(),area_id:f.area,title:'Attachment parent',content:{format:'loom-markdown-v1',text:'Opening',mentions:[]}})).body;
  const discussion=(await f.admin.call('/api/v1/resources/'+parent.resource_id)).body.discussion_id;
  const member=await prepareText(f.admin,{kind:'reply',resource_id:parent.resource_id},'source.txt',Buffer.from('orchidneedle source bytes'));
  const source=(await f.admin.call('/api/v1/replies',{idempotency_key:randomUUID(),discussion_id:discussion,parent_id:parent.resource_id,content:{format:'loom-markdown-v1',text:'Source comment',mentions:[]},attachment_set:{version:'contribution-attachments-v1',files:[member]}})).body;
  const file=(await f.admin.call(`/api/v1/contributions/${source.resource_id}/revisions/${source.revision_id}/attachments`)).body.items[0];
  const childMember=await prepareText(f.admin,{kind:'reply',resource_id:source.resource_id},'child.txt',Buffer.from('orchidneedle eligible child'));
  const child=(await f.admin.call('/api/v1/replies',{idempotency_key:randomUUID(),discussion_id:discussion,parent_id:source.resource_id,content:{format:'loom-markdown-v1',text:'Child comment',mentions:[]},attachment_set:{version:'contribution-attachments-v1',files:[childMember]}})).body;
  const promoted=await api(page,'/api/v1/attachment-promotions',{idempotency_key:randomUUID(),source:{contribution_id:source.resource_id,revision_id:source.revision_id,file_id:file.file_id},area_id:f.area,title:'Independent publication'});
  const worker=new NativeSearchWorker(server.configuration,'file-text',server.fileFixture!.storage.configuration);
  const suppress=async(id:string,value=true)=>{const state=(await f.admin.call('/api/v1/admin/moderation/resources/'+id)).body;expect((await f.admin.call('/api/v1/admin/moderation/state',{idempotency_key:randomUUID(),target:state.target,suppressed:value,expected_version:state.version})).status).toBe(200);};
  try{
    await worker.start();await worker.observeUntil(async()=>(await server.observer.query('SELECT count(*)::int AS n FROM loom.file_text_documents')).rows[0].n===3);await worker.stop();
    await page.goto(server.origin+'/loom/search?mode=files&q=orchidneedle');await expect(page.getByRole('link',{name:'Open exact text preview',exact:true})).toHaveCount(3);
    await page.goto(server.origin+`/loom/file/contribution/${source.resource_id}/${source.revision_id}/${file.file_id}`);await expect(page.getByLabel('Literal file text')).toHaveText('orchidneedle source bytes');
    await suppress(source.resource_id);await page.getByRole('button',{name:'Refresh text processing',exact:true}).click();await expect(page.getByRole('button',{name:'Retry protected view',exact:true})).toBeVisible();
    await page.goto(server.origin+'/loom/search?mode=files&q=orchidneedle');await expect(page.getByRole('link',{name:'Open exact text preview',exact:true})).toHaveCount(2);
    await suppress(discussion);await page.reload();await expect(page.getByRole('link',{name:'Open exact text preview',exact:true})).toHaveCount(1);
    await page.getByRole('link',{name:'Open exact text preview',exact:true}).click();await expect(page.getByLabel('Literal file text')).toHaveText('orchidneedle source bytes');await page.reload();await expect(page.getByLabel('Literal file text')).toHaveText('orchidneedle source bytes');
    const download=page.waitForEvent('download');await page.getByRole('button',{name:'Download original source.txt',exact:true}).click();expect((await readFile((await (await download).path())!)).toString()).toBe('orchidneedle source bytes');
    await suppress(discussion,false);await page.goto(server.origin+'/loom/search?mode=files&q=orchidneedle');await expect(page.getByRole('link',{name:'Open exact text preview',exact:true})).toHaveCount(2);
    const items=(await api(page,'/api/v1/search/files?q=orchidneedle')).items;expect(items.map((r:any)=>r.source_resource_id).sort()).toEqual([promoted.resource_id,child.resource_id].sort());
    await suppress(promoted.resource_id);await page.reload();await expect(page.getByRole('link',{name:'Open exact text preview',exact:true})).toHaveCount(1);await page.getByRole('link',{name:'Open exact text preview',exact:true}).click();await expect(page.getByLabel('Literal file text')).toHaveText('orchidneedle eligible child');
  }finally{await worker.stop();}
});

test('production file boundaries reject held success after denial, repeated restoration, navigation and sign-out',async({page,context,server})=>{
  const f=await setup(page,context,server),member=await prepareText(f.admin,{kind:'area',resource_id:f.area},'held.txt',Buffer.from('heldpreviewneedle'));
  const published=(await f.admin.call('/api/v1/artifacts',{idempotency_key:randomUUID(),area_id:f.area,title:'Held preview',content:{format:'loom-markdown-v3',text:'',mentions:[],references:[]},change_note:null,change_account:null,file_set:{version:'artifact-files-v1',files:[member]}})).body;
  const file=(await f.admin.call(`/api/v1/artifacts/${published.resource_id}/revisions/${published.revision_id}/files`)).body.items[0];
  const worker=new NativeSearchWorker(server.configuration,'file-text',server.fileFixture!.storage.configuration);await worker.start();await worker.observeUntil(async()=>(await server.observer.query('SELECT count(*)::int AS n FROM loom.file_text_documents')).rows[0].n===1);await worker.stop();
  const url=server.origin+`/loom/file/artifact/${published.resource_id}/${published.revision_id}/${file.file_id}`,apiPath=file.download_url.replace('/download','/text');
  const suppress=async(value:boolean)=>{const state=(await f.admin.call('/api/v1/admin/moderation/resources/'+published.resource_id)).body;expect((await f.admin.call('/api/v1/admin/moderation/state',{idempotency_key:randomUUID(),target:state.target,suppressed:value,expected_version:state.version})).status).toBe(200);};
  let arm=false,release:(()=>void)|undefined,entered:(()=>void)|undefined;
  await page.route(u=>u.pathname===apiPath,async route=>{if(!arm){await route.continue();return;}arm=false;const response=await route.fetch();const wait=new Promise<void>(resolve=>release=resolve);entered?.();await wait;await route.fulfill({response});});
  const hold=async()=>{const pending=new Promise<void>(resolve=>entered=resolve);arm=true;await page.getByRole('button',{name:'Refresh text processing',exact:true}).click();await pending;};
  try{
    await page.goto(url);await expect(page.getByLabel('Literal file text')).toHaveText('heldpreviewneedle');
    await hold();await suppress(true);await page.getByRole('button',{name:'Check file status',exact:true}).click();await expect(page.getByRole('button',{name:'Retry protected view',exact:true})).toBeVisible();release!();await expect(page.getByLabel('Literal file text')).toHaveCount(0);
    await suppress(false);await page.getByRole('button',{name:'Retry protected view',exact:true}).click();await expect(page.getByLabel('Literal file text')).toHaveText('heldpreviewneedle');
    await suppress(true);await page.getByRole('button',{name:'Refresh text processing',exact:true}).click();await expect(page.getByLabel('Literal file text')).toHaveCount(0);
    await suppress(false);await page.goto(url);await expect(page.getByLabel('Literal file text')).toHaveText('heldpreviewneedle');
    await hold();await page.getByRole('link',{name:'Search',exact:true}).click();release!();await expect(page.getByRole('heading',{name:'Search',exact:true})).toBeVisible();await expect(page.getByLabel('Literal file text')).toHaveCount(0);
    await page.goto(url);await expect(page.getByLabel('Literal file text')).toHaveText('heldpreviewneedle');await hold();await page.getByRole('button',{name:'Sign out',exact:true}).click();release!();await expect(page.getByRole('button',{name:'Sign in with passkey',exact:true})).toBeVisible();await expect(page.getByLabel('Literal file text')).toHaveCount(0);
  }finally{release?.();await worker.stop();}
});

test('Operational health observes a stopped file worker independently and refreshes after native resume',async({page,context,server})=>{
 const f=await setup(page,context,server);await server.observer.query("UPDATE loom.participants SET role='administrator' WHERE id=$1",[f.person]);
 const worker=new NativeSearchWorker(server.configuration,'file-text',server.fileFixture!.storage.configuration);
 try{
  await worker.start();await worker.observeUntil(async()=>(await f.admin.call('/api/v1/admin/operational-health')).body.files.value?.worker.state==='recent');await worker.stop();
  const bytes=Buffer.from('Exact original retained through inspection'),member=await prepareText(f.admin,{kind:'area',resource_id:f.area},'inspection.txt',bytes);
  const publication=await f.admin.call('/api/v1/artifacts',{idempotency_key:randomUUID(),area_id:f.area,title:'File worker observation',content:{format:'loom-markdown-v3',text:'',mentions:[],references:[]},change_note:null,change_account:null,file_set:{version:'artifact-files-v1',files:[member]}});expect(publication.status).toBe(201);
  expect((await f.admin.call('/health/ready')).status).toBe(200);
  await page.goto(server.origin+'/loom/admin');await page.getByText('Operational health',{exact:true}).click();
  const file=page.getByRole('region',{name:'File indexing health'});await expect(file).toContainText('Undiscovered contexts: true');
  await expect(page.getByRole('region',{name:'Authored indexing health'})).toContainText('not established');
  await worker.start();await worker.observeUntil(async()=>(await f.admin.call('/api/v1/admin/operational-health')).body.files.value?.jobs.complete===1);await worker.stop();
  const refresh=page.getByRole('button',{name:'Refresh operational health'});await refresh.focus();await page.keyboard.press('Enter');await expect(file).toContainText('1 complete jobs');await expect(file).toContainText('Undiscovered contexts: false');
  await expect(page.getByRole('region',{name:'Authored indexing health'})).toContainText('not established');
  const result=publication.body,files=(await f.admin.call(`/api/v1/artifacts/${result.resource_id}/revisions/${result.revision_id}/files`)).body;
  expect((await f.admin.call(files.items[0].download_url)).body).toBe(bytes.toString());expect((await f.admin.call('/api/v1/resources/'+result.resource_id)).body.revision_id).toBe(result.revision_id);
  await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  if(process.env.LOOM_OPERATIONS_REVIEW_SCREENS==='1'){
   const {mkdir}=await import('node:fs/promises');await mkdir('/tmp/loom-review-evidence/operations',{recursive:true});
   await page.screenshot({path:'/tmp/loom-review-evidence/operations/operational-health-narrow.png',fullPage:true});
  }
 }finally{await worker.stop();}
});
