import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {fixture} from '../helpers/references.js';

for (const kind of ['artifact.create','revision.publish']) {
  test(`${kind}: omitting files cannot reuse an expired publication identity`,async t=>{
    const f=await fixture(t,{files:true});
    const base=kind==='revision.publish'?await f.artifact():undefined;
    const bytes=Buffer.from('Expired publication regression');
    const upload=await f.admin.call('/api/v1/file-uploads',{
      idempotency_key:randomUUID(),
      target:{kind:base?'artifact':'area',resource_id:base?.resource_id??f.area},
      path:'expired.txt',size:bytes.length,
      sha256:createHash('sha256').update(bytes).digest('hex'),media_type:'text/plain',
    });
    assert.equal(upload.status,201);
    const id=upload.body.upload_id;
    assert.equal((await f.admin.call(`/api/v1/file-uploads/${id}/bytes`,undefined,{bytes})).status,200);
    assert.equal((await f.admin.call(`/api/v1/file-uploads/${id}/finalize`,{})).status,200);
    await f.observer.query("UPDATE loom.file_uploads SET prepared_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[id]);

    const input={
      idempotency_key:randomUUID(),
      ...(base?{resource_id:base.resource_id,expected_revision_id:base.revision_id}:{area_id:f.area}),
      title:'Retained draft',
      // Nonempty text makes the request valid even when the file envelope is omitted.
      content:{format:'loom-markdown-v3',text:'Retained text',mentions:[],references:[]},
      change_note:null,change_account:null,
      file_set:{version:'artifact-files-v1',files:[{path:'expired.txt',source:{upload_id:id}}]},
    };
    const route=base?'/api/v1/revisions':'/api/v1/artifacts';
    const statusInput={operation_kind:kind,idempotency_key:input.idempotency_key};
    const publicationState=async()=>{
      const state:Record<string,unknown>={};
      for(const table of ['resources','artifacts','revisions','resource_editors','shared_activity',
        'outbox_intents','community_clocks','idempotency_records','artifact_file_sets','file_contexts']){
        state[table]=(await f.observer.query(`SELECT to_jsonb(t) AS row FROM loom.${table} t ORDER BY to_jsonb(t)::text`)).rows;
      }
      return state;
    };
    const refusalState=async()=>(await f.observer.query('SELECT to_jsonb(t) AS row FROM loom.file_publication_refusals t ORDER BY to_jsonb(t)::text')).rows;
    const expectExpired=(response:{status:number;body:any})=>{
      assert.equal(response.status,409);
      const {request_id,...error}=response.body.error;
      assert.ok(request_id);
      assert.deepEqual(error,{
        code:'file_expired',message:'This file preparation expired. Reconcile publication before explicitly correcting the draft.',
        recovery:{action:'retain_draft_and_reconcile'},operation_outcome:'rejected',
      });
    };
    const before=await publicationState();
    expectExpired(await f.admin.call(route,input));
    assert.deepEqual(await publicationState(),before);
    const refusals=await refusalState();
    assert.equal(refusals.length,1);
    expectExpired(await f.admin.call(route,input));
    const changed=await f.admin.call(route,{...input,title:'Changed draft'});
    assert.equal(changed.status,409);
    assert.equal(changed.body.error.code,'idempotency_conflict');

    const {file_set:_files,...textOnly}=input;
    for(const restart of [false,true]){
      if(restart)await f.restart();
      const omitted=await f.admin.call(route,textOnly);
      assert.equal(omitted.status,409,'Omitting files must not publish under a refused identity');
      assert.equal(omitted.body.error.code,'idempotency_conflict');
      expectExpired(await f.admin.call(route,input));
      expectExpired(await f.admin.call('/api/v1/operations/status',statusInput));
      assert.deepEqual(await publicationState(),before);
      assert.deepEqual(await refusalState(),refusals);
    }

    // Deliberate correction is still allowed, but needs its own publication identity.
    const corrected={...textOnly,idempotency_key:randomUUID()};
    const published=await f.admin.call(route,corrected);
    assert.equal(published.status,201);
    const afterCorrection=await publicationState();
    const replay=await f.admin.call(route,corrected);
    assert.equal(replay.status,201);
    assert.equal(replay.body.operation_id,published.body.operation_id);
    assert.equal(replay.body.revision_id,published.body.revision_id);
    expectExpired(await f.admin.call('/api/v1/operations/status',statusInput));
    assert.deepEqual(await publicationState(),afterCorrection);
    assert.deepEqual(await refusalState(),refusals);
  });
}
