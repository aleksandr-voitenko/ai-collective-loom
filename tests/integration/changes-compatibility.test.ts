import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile,writeFile } from 'node:fs/promises';
import { fixture,content,note,exactPair,coveragePath,notePath } from '../helpers/changes.js';
import { authored,plain,reference } from '../helpers/references.js';
import { SearchWorker } from '../../src/server/modules/search/worker.js';

test('populated pre-note upgrade preserves old columns, retry digests, preparations and uncertain outcomes',{timeout:90000},async t=>{
  const f=await fixture(t,{throughMigration:10}),person=await f.participant('upgrade_mention'),target=await f.artifact();
  const body={idempotency_key:randomUUID(),area_id:f.area,title:'Preserved v2',content:{...authored('Exact bytes\r\n🦉 [[mention:m]]',[reference(exactPair(target))]),mentions:[{token:'m',participant_id:person.id}]}};
  const legacy={...body,idempotency_key:randomUUID(),title:'Preserved v1',content:plain('Old text\r\n')};
  const published=await f.admin.call('/api/v1/artifacts',body),v1=await f.admin.call('/api/v1/artifacts',legacy);assert.equal(published.status,201);assert.equal(v1.status,201);
  const d=await f.discussion(),s=await f.create(d.id),preparation=await f.prepare(d.id);
  assert.equal((await f.admin.call('/api/v1/me/saved-items/state',{idempotency_key:randomUUID(),target:{kind:'revision',resource_id:target.resource_id,revision_id:target.revision_id},saved:true,expected_version:0})).status,200);
  const worker=new SearchWorker(f.database);await worker.tick();
  const tables=['resources','revisions','revision_mentions','revision_references','reference_withdrawals','summaries','summary_preparations','summary_preparation_members','summary_coverage_sets','summary_coverage_members','resource_editors','saved_items','saved_operations','saved_collections','search_state','search_documents','search_jobs','idempotency_records','shared_activity','outbox_intents'];
  const columns:Record<string,string>={};for(const table of tables)columns[table]=(await f.observer.query("SELECT column_name FROM information_schema.columns WHERE table_schema='loom' AND table_name=$1 ORDER BY ordinal_position",[table])).rows.map(r=>'"'+r.column_name+'"').join(',');
  const snapshot=async()=>{const rows:Record<string,unknown>={};for(const table of tables)rows[table]=(await f.observer.query(`SELECT ${columns[table]} FROM loom.${table} ORDER BY 1,2`)).rows;return rows;};
  const before=await snapshot();await f.migrate();await f.migrate();assert.deepEqual(await snapshot(),before);
  assert.deepEqual((await f.observer.query("SELECT (SELECT count(*) FROM loom.revision_change_notes)::int notes,(SELECT count(*) FROM loom.change_account_sets)::int accounts")).rows,[{notes:0,accounts:0}]);
  assert.equal((await f.observer.query("SELECT count(*)::int n FROM loom.revision_mentions WHERE source_field<>'main'")).rows[0].n,0);
  await f.restart();
  // Treat pre-upgrade acknowledgements as lost: status and exact request retry
  // retain the recorded semantic version/digest and original publication.
  for(const [input,result] of [[body,published.body],[legacy,v1.body]]){
    assert.equal((await f.admin.call('/api/v1/operations/status',{operation_kind:'artifact.create',idempotency_key:input.idempotency_key})).body.revision_id,result.revision_id);
    assert.equal((await f.admin.call('/api/v1/artifacts',input)).body.revision_id,result.revision_id);
    assert.deepEqual((await f.admin.call('/api/v1/resources/'+result.resource_id)).body.content,input.content);
  }
  assert.equal((await f.admin.call('/api/v1/summaries',s.body)).body.revision_id,s.revision_id);
  assert.equal((await f.admin.call('/api/v1/summary-revisions',{idempotency_key:randomUUID(),resource_id:s.resource_id,expected_revision_id:s.revision_id,title:'Old prepared update',content:authored('Old semantic summary'),coverage:{preparation_id:preparation.preparation_id}})).status,201);
  assert.equal((await f.admin.call(notePath(published.body))).body.state,'absent');
  assert.equal((await f.admin.call('/api/v1/search?q=Preserved')).status,200);
});

test('standalone reply and summary clients keep every change field across process/server restart and response loss',{timeout:90000},async t=>{
  const f=await fixture(t),agent=await f.participant('change_client'),d=await f.discussion(),target=await f.artifact();
  const credential=await f.admin.call('/api/v1/identity/credentials',{idempotency_key:randomUUID(),participant_id:agent.id,kind:'agent',purpose:null,label:'Change client',replace_credential_id:null});assert.equal(credential.status,200);
  await writeFile(f.directory+'/token',credential.body.secret,{mode:0o600});
  const account={revisions:[exactPair(target)]},text='Independent account [[mention:m_a]] [[mention:m0]]';
  const canonicalMentions=[{token:'m0',participant_id:agent.id},{token:'m_a',participant_id:f.administratorId}];
  const mentions=[...canonicalMentions].reverse().map(m=>({...m,participant_id:m.participant_id.toUpperCase()}));
  const canonicalRefs=[reference(exactPair(target),'related_to','Chosen support')];
  const refs=canonicalRefs.map(ref=>({...ref,reference_id:ref.reference_id.toUpperCase(),target:{...ref.target,resource_id:ref.target.resource_id.toUpperCase(),revision_id:ref.target.revision_id!.toUpperCase()}}));
  const input={discussion_id:d.id,title:'Client summary note',content:content('Summary text'),sources:{scope:'full'},
    change_note:{...note('New summary explanation [[mention:m_a]] [[mention:m0]]'),mentions,references:refs},change_account:null};
  for(const [name,value] of Object.entries({'input.json':JSON.stringify(input),'account.json':JSON.stringify(account),'mentions.json':JSON.stringify(mentions),'refs.json':JSON.stringify(refs),'text.txt':text}))await writeFile(f.directory+'/'+name,value,{mode:0o600});
  for(const kind of ['summary','participation']){
    const journal=f.directory+'/'+kind+'.json',args=kind==='summary'?['--input',f.directory+'/input.json']:['--parent',d.opening.resource_id,'--text-file',f.directory+'/text.txt','--mentions-file',f.directory+'/mentions.json','--references-file',f.directory+'/refs.json','--change-account-file',f.directory+'/account.json'];
    const run=(action:string)=>promisify(execFile)(process.execPath,['scripts/'+kind+'-client.mjs','--origin',f.origin,'--credential-file',f.directory+'/token','--ca',f.directory+'/cert.pem','--journal',journal,'--action',action,...args],{timeout:20000});
    await run('prepare');const before=JSON.parse(await readFile(journal,'utf8'));assert.ok(!(await readFile(journal,'utf8')).includes(credential.body.secret));
    await assert.rejects(run('lose-response'),(e:any)=>e.code===75);assert.equal(JSON.parse(await readFile(journal,'utf8')).state,'uncertain');
    await f.restart();await run('status');await run('retry');await run('inspect');const after=JSON.parse(await readFile(journal,'utf8'));
    assert.deepEqual(after.body,before.body);assert.equal(after.state,'committed');
    if(kind==='summary')assert.deepEqual((await agent.client.call(notePath(after.result))).body.content,{...input.change_note,mentions:canonicalMentions,references:canonicalRefs});
    else{assert.deepEqual((await agent.client.call(coveragePath(after.result))).body.items.map((i:any)=>i.target),account.revisions);assert.deepEqual(before.body.content,{format:'loom-markdown-v3',text,mentions,references:refs});}
  }
});
