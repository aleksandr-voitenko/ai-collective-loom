import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { readFile,writeFile } from 'node:fs/promises';
import { fixture } from '../helpers/summaries.js';
import { authored,reference } from '../helpers/references.js';

test('standalone HTTPS client and server restart preserve preparation, publication, references and lost acknowledgement',{timeout:90000},async t=>{
  const f=await fixture(t),agent=await f.participant('external_summarizer'),d=await f.discussion(),comment=await f.reply(d),target=await f.artifact();
  const credential=await f.admin.call('/api/v1/identity/credentials',{idempotency_key:randomUUID(),participant_id:agent.id,kind:'agent',purpose:null,label:'External summary client',replace_credential_id:null});assert.equal(credential.status,200);
  const input={discussion_id:d.id,title:'External summary',content:authored('Preserved external text\r\n🦉',[reference({kind:'artifact',resource_id:target.resource_id,revision_id:target.revision_id},'builds_on','Exact support')]),sources:{scope:'full'}};
  await writeFile(f.directory+'/token',credential.body.secret,{mode:0o600});await writeFile(f.directory+'/input.json',JSON.stringify(input),{mode:0o600});
  const journal=f.directory+'/summary-intent.json',run=(action:string)=>promisify(execFile)(process.execPath,['scripts/summary-client.mjs','--origin',f.origin,'--credential-file',f.directory+'/token','--ca',f.directory+'/cert.pem','--journal',journal,'--action',action,'--input',f.directory+'/input.json'],{timeout:20000});
  await run('prepare');const before=JSON.parse(await readFile(journal,'utf8'));assert.equal(before.state,'prepared');assert.ok(!(await readFile(journal,'utf8')).includes(credential.body.secret));
  const first=await agent.client.call(`/api/v1/summary-preparations/${before.body.coverage.preparation_id}/members?limit=1`);assert.ok(first.body.next_cursor);
  await f.restart();assert.equal((await agent.client.call(`/api/v1/summary-preparations/${before.body.coverage.preparation_id}/members?cursor=${first.body.next_cursor}`)).status,409);
  await run('prepare');assert.deepEqual(JSON.parse(await readFile(journal,'utf8')),before);await run('inspect');await f.reply(d,'Arrived after restart');
  await assert.rejects(run('lose-response'),(error:any)=>error.code===75);assert.equal(JSON.parse(await readFile(journal,'utf8')).state,'uncertain');await f.restart();await run('status');await run('retry');await run('inspect');
  const after=JSON.parse(await readFile(journal,'utf8'));assert.deepEqual(after.body,before.body);assert.equal(after.state,'committed');
  assert.equal((await f.coverage(after.result)).body.coverage.uncovered_eligible,1);
  assert.equal((await f.observer.query('SELECT count(*)::int n FROM loom.summary_coverage_members WHERE revision_id=$1',[after.result.revision_id])).rows[0].n,2);
  assert.ok((await agent.client.call(`/api/v1/summaries/${after.result.resource_id}/revisions/${after.result.revision_id}/members`)).body.items.some((i:any)=>i.source.revision_id===comment.revision_id));
});
