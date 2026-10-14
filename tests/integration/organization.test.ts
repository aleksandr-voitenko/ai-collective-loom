import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { open, readFile, writeFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type { QueryResultRow } from 'pg';
import SwaggerParser from '@apidevtools/swagger-parser';
import { syntheticServer } from '../helpers/participation-server.js';
import { isolatedPublicationPostgres } from '../helpers/publication-postgres.js';
import { httpClient } from '../helpers/participation-http.js';
import type { OrganizationResourceView } from '../../src/contracts/organization.js';

const content=(text:string)=>({format:'loom-markdown-v1',text,mentions:[]});
const changes='/api/v1/organization/changes';
function barrier(){let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};}

test('populated migration 0005 upgrades without changing retained identities or content', {timeout:120000}, async t=>{
  const fixture=await isolatedPublicationPostgres({throughMigration:5});t.after(fixture.close);
  const participant=await fixture.participant('administrator');
  const ids=Object.fromEntries(['area','proposal','discussion','opening','reply','artifact','r1','r2','replyRevision','artifactRevision','saved'].map(k=>[k,randomUUID()]));
  await fixture.database.transaction(async tx=>{
    for(const area of [ids.area!,ids.proposal!]) {
      await tx.query("INSERT INTO loom.resources(id,kind) VALUES ($1,'area')",[area]);
      await tx.query('INSERT INTO loom.areas(id,title,description) VALUES ($1,$2,$3)',[area,'Retained '+area,'Original scope']);
    }
    for(const [id,kind,owner] of [[ids.discussion,'discussion',ids.area],[ids.opening,'contribution',ids.discussion],[ids.reply,'contribution',ids.discussion],[ids.artifact,'artifact',ids.area]])
      await tx.query('INSERT INTO loom.resources(id,kind,owner_resource_id,original_author_id) VALUES ($1,$2,$3,$4)',[id,kind,owner,participant.participantId]);
    await tx.query('INSERT INTO loom.discussions VALUES ($1,$2)',[ids.discussion,ids.opening]);
    await tx.query('INSERT INTO loom.contributions(id,discussion_id,parent_id) VALUES ($1,$2,NULL),($3,$2,$1)',[ids.opening,ids.discussion,ids.reply]);
    await tx.query('INSERT INTO loom.artifacts VALUES ($1)',[ids.artifact]);
    for(const [revision,resource,n,title,text] of [[ids.r1,ids.opening,1,'Before','Exact first\nrevision'],[ids.r2,ids.opening,2,'After','Exact second'],[ids.replyRevision,ids.reply,1,null,'Actual parent'],[ids.artifactRevision,ids.artifact,1,'Package','Artifact bytes']])
      await tx.query("INSERT INTO loom.revisions(id,resource_id,revision_number,publisher_id,content_format,content_text,title) VALUES ($1,$2,$3,$4,'loom-markdown-v1',$5,$6)",[revision,resource,n,participant.participantId,text,title]);
    for(const [id,revision] of [[ids.opening,ids.r2],[ids.reply,ids.replyRevision],[ids.artifact,ids.artifactRevision]])await tx.query('UPDATE loom.resources SET current_revision_id=$2 WHERE id=$1',[id,revision]);
    await tx.query('INSERT INTO loom.resource_editors VALUES ($1,$2)',[ids.artifact,participant.participantId]);
    await tx.query('UPDATE loom.community_settings SET version=1,community_name=$1,overview_id=$2,proposal_area_id=$3 WHERE id=1',['Retained community',ids.artifact,ids.proposal]);
    await tx.query("INSERT INTO loom.saved_items(id,participant_id,target_kind,resource_id,content_resource_id,revision_id,observed_revision_id,saved,version) VALUES ($1,$2,'revision',$3,$3,$4,$4,true,1)",[ids.saved,participant.participantId,ids.opening,ids.r1]);
  });
  const snapshot=async()=>{
    const result:Record<string,unknown>={};
    for(const table of ['participants','participant_credentials','discussions','contributions','artifacts','revisions','resource_editors','community_settings','saved_items']) result[table]=(await fixture.observer.query(`SELECT * FROM loom.${table} ORDER BY 1`)).rows;
    result.resources=(await fixture.observer.query('SELECT id,kind,owner_resource_id,current_revision_id,state,publication_open,editors_version FROM loom.resources ORDER BY id')).rows;
    result.areas=(await fixture.observer.query('SELECT id,title,description FROM loom.areas ORDER BY id')).rows;
    return result;
  };
  const before=await snapshot();await fixture.migrate();assert.deepEqual(await snapshot(),before);await fixture.migrate();assert.deepEqual(await snapshot(),before);
  const history=(await fixture.observer.query('SELECT area_id,title,description,version,publisher_id,baseline FROM loom.area_metadata_revisions ORDER BY area_id')).rows;
  assert.equal(history.length,2);assert.ok(history.every(r=>r.baseline&&r.publisher_id===null&&r.version===1));
  assert.equal((await fixture.observer.query('SELECT count(*)::int AS n FROM loom.shared_activity')).rows[0].n,0,'upgrade invents no activity ancestry');
});

test('organization over actual HTTPS, current identities and isolated PostgreSQL', {timeout:240000}, async t=>{
  let loseKey='',rollback=false;
  let hold:{exclusive:boolean;entered:ReturnType<typeof barrier>;release:ReturnType<typeof barrier>;attempted:ReturnType<typeof barrier>}|undefined;
  let holding=false;
  const server=await syntheticServer({transactionWrapper:database=>({transaction:async work=>{
    let key='';
    const result=await database.transaction(tx=>work({query:async <Row extends QueryResultRow>(sql:string,values:readonly unknown[])=>{
      const structure=sql.includes('pg_advisory_xact_lock') && values[0]===0x4c4f4f4d && values[1]===1;
      const gate=hold;
      if(structure&&holding) gate?.attempted.release();
      const result=await tx.query<Row>(sql,values);
      if(structure&&gate&&!holding&&sql.includes('_shared')!==gate.exclusive) {
        holding=true;gate.entered.release();await gate.release.promise;hold=undefined;holding=false;
      }
      if(sql.startsWith('INSERT INTO loom.organization_operations')) {key=String(values[3]);if(rollback)throw new Error('synthetic rollback');}
      return result;
    }}));
    if(key&&key===loseKey){loseKey='';throw new Error('lost committed response');}
    return result;
  }})});t.after(server.close);
  const cert=await readFile(server.directory+'/cert.pem','utf8'),admin=httpClient(server.origin,cert);await admin.enroll(server.ticket);
  async function account(nickname:string,kind:'human'|'agent',role='participant') {
    const created=await admin.call('/api/v1/identity/accounts',{idempotency_key:randomUUID(),nickname,kind,role});assert.equal(created.status,200);
    const issued=await admin.call('/api/v1/identity/credentials',{idempotency_key:randomUUID(),participant_id:created.body.participant_id,kind:kind==='agent'?'agent':'enrollment',purpose:kind==='agent'?null:'enroll',label:'Organization test',replace_credential_id:null});assert.equal(issued.status,200);
    const client=httpClient(server.origin,cert,kind==='agent'?issued.body.secret:undefined);if(kind==='human')await client.enroll(issued.body.secret);
    return {client,id:created.body.participant_id as string,secret:issued.body.secret as string,credential:issued.body.credential_id as string};
  }
  const human=await account('organizing_human','human'),agent=await account('organizing_agent','agent'),agentAdmin=await account('organizing_admin','agent','administrator');
  assert.equal((await admin.call('/api/v1/community/setup',{idempotency_key:randomUUID(),community_name:'Organization trial',ordinary_area_name:'General',proposal_area_name:'Feedback',overview:content('Synthetic overview')})).status,201);
  const initial=(await admin.call('/api/v1/areas')).body.items;
  const general=initial.find((r:any)=>r.title==='General').id as string,feedback=initial.find((r:any)=>r.title==='Feedback').id as string;
  const get=async(id:string,client=admin)=>{const r=await client.call('/api/v1/organization/resources/'+id);assert.equal(r.status,200,JSON.stringify(r.body));return r.body as OrganizationResourceView;};
  const epoch=async()=> (await admin.call('/api/v1/organization/children?limit=1')).body.hierarchy_version as number;
  const fresh=async(id:string,kind:string,fields:Record<string,unknown>={})=>{const r=await get(id);return {idempotency_key:randomUUID(),kind,resource_id:id,expected_version:r.version,expected_hierarchy_version:r.hierarchy_version,...fields};};
  const apply=async(input:unknown,client=admin)=>{const r=await client.call(changes,input);assert.equal(r.status,200,JSON.stringify(r.body));return r.body;};
  const create=async(title:string,parent_id:string|null=null,client=admin)=>apply({idempotency_key:randomUUID(),kind:'area.create',parent_id,title,description:'Scope of '+title,expected_hierarchy_version:await epoch()},client);
  let a='',b='',c='',child='',discussion='',opening='',reply='',artifact='',artifactRevision='';

  await t.test('human/agent administrator parity, participant contribution and structural/audit denial',async()=>{
    const body={idempotency_key:randomUUID(),kind:'area.create',parent_id:null,title:'Research',description:'Research scope',expected_hierarchy_version:await epoch()};
    for(const client of [human.client,agent.client]) {
      assert.equal((await client.call(changes,body)).status,403);
      assert.equal((await client.call('/api/v1/organization/status',{kind:body.kind,idempotency_key:body.idempotency_key})).status,403);
      assert.equal((await client.call('/api/v1/organization/audit')).status,403);
      assert.equal((await client.call('/api/v1/artifacts',{idempotency_key:randomUUID(),area_id:general,title:'Participant work',content:content('Ordinary contribution')})).status,201);
    }
    a=(await apply(body)).current.resource_id;b=(await create('Writing',null,agentAdmin.client)).current.resource_id;c=(await create('Archive')).current.resource_id;
    child=(await create('Reviews',a)).current.resource_id;
    assert.equal((await get(child)).ancestors[0]!.id,a);
    assert.equal((await agentAdmin.client.call('/api/v1/organization/audit')).status,200);
    assert.equal((await admin.call(changes,{...body,unexpected:true})).status,400);
    await SwaggerParser.validate((await admin.call('/api/v1/openapi.json')).body);
  });
  await t.test('metadata history is attributable and distinct from subtree moves and content revisions',async()=>{
    const before=(await server.observer.query('SELECT count(*)::int AS n FROM loom.revisions')).rows[0].n;
    await apply(await fresh(a,'area.edit',{title:'Science',description:'Updated scope'}),agentAdmin.client);
    const history=(await human.client.call('/api/v1/areas/'+a+'/metadata-history')).body.items;
    assert.deepEqual(history.map((r:any)=>[r.version,r.title,r.publisher.id,r.baseline]),[[1,'Research',server.administratorId,false],[2,'Science',agentAdmin.id,false]]);
    await apply(await fresh(a,'area.move',{parent_id:b}));
    assert.deepEqual((await get(child)).ancestors.map(r=>r.id),[b,a]);
    assert.equal((await server.observer.query('SELECT count(*)::int AS n FROM loom.revisions')).rows[0].n,before);
    assert.equal((await server.observer.query('SELECT count(*)::int AS n FROM loom.area_metadata_revisions WHERE area_id=$1',[a])).rows[0].n,2);
  });
  await t.test('self/descendant, absent/wrong-kind parents and simultaneous opposite moves cannot create cycles',async()=>{
    for(const parent of [a,child]) assert.equal((await admin.call(changes,await fresh(a,'area.move',{parent_id:parent}))).body.error.code,'organization_cycle');
    assert.equal((await admin.call(changes,await fresh(a,'area.move',{parent_id:randomUUID()}))).status,404);
    const overview=(await admin.call('/api/v1/community')).body.overview.resource_id;
    assert.equal((await admin.call(changes,await fresh(a,'area.move',{parent_id:overview}))).status,404);
    const x=(await create('X')).current.resource_id,y=(await create('Y')).current.resource_id;
    const first=await fresh(x,'area.move',{parent_id:y}),second=await fresh(y,'area.move',{parent_id:x});
    const gate={exclusive:true,entered:barrier(),release:barrier(),attempted:barrier()};hold=gate;
    const one=admin.call(changes,first);await gate.entered.promise;
    const two=agentAdmin.client.call(changes,second);await gate.attempted.promise;gate.release.release();
    const results=await Promise.all([one,two]);assert.deepEqual(results.map(r=>r.status),[200,409]);
    assert.equal((await get(x)).parent_id,y);assert.equal((await get(y)).parent_id,null);
  });
  await t.test('discussion/artifact moves preserve revisions, reply parents, editors and private exact bookmarks',async()=>{
    const opened=await human.client.call('/api/v1/discussions',{idempotency_key:randomUUID(),area_id:child,title:'Stable conversation',content:content('Opening')});assert.equal(opened.status,201);opening=opened.body.resource_id;
    discussion=(await human.client.call('/api/v1/resources/'+opening)).body.discussion_id;
    reply=(await agent.client.call('/api/v1/replies',{idempotency_key:randomUUID(),discussion_id:discussion,parent_id:opening,content:content('Actual child')})).body.resource_id;
    const packageResult=await human.client.call('/api/v1/artifacts',{idempotency_key:randomUUID(),area_id:child,title:'Stable artifact',content:content('Exact artifact')});artifact=packageResult.body.resource_id;artifactRevision=packageResult.body.revision_id;
    await human.client.call('/api/v1/me/saved-items/state',{idempotency_key:randomUUID(),target:{kind:'revision',resource_id:artifact,revision_id:artifactRevision},saved:true,expected_version:0});
    const before={revisions:(await server.observer.query('SELECT * FROM loom.revisions ORDER BY id')).rows,parents:(await server.observer.query('SELECT * FROM loom.contributions ORDER BY id')).rows,editors:(await server.observer.query('SELECT * FROM loom.resource_editors ORDER BY 1,2')).rows,saved:(await server.observer.query('SELECT * FROM loom.saved_items ORDER BY id')).rows,events:(await server.observer.query("SELECT * FROM loom.shared_activity WHERE kind='revision.published' ORDER BY position")).rows};
    for(const [id,kind] of [[discussion,'discussion.move'],[artifact,'artifact.move']]) {
      const command=await fresh(id!,kind!,{parent_id:c});assert.equal((await human.client.call(changes,command)).status,403);await apply(command);
    }
    assert.equal((await human.client.call('/api/v1/resources/'+reply)).body.parent_id,opening);
    assert.equal((await human.client.call('/api/v1/resources/'+artifact+'/revisions/'+artifactRevision)).body.area_id,c);
    assert.deepEqual({revisions:(await server.observer.query('SELECT * FROM loom.revisions ORDER BY id')).rows,parents:(await server.observer.query('SELECT * FROM loom.contributions ORDER BY id')).rows,editors:(await server.observer.query('SELECT * FROM loom.resource_editors ORDER BY 1,2')).rows,saved:(await server.observer.query('SELECT * FROM loom.saved_items ORDER BY id')).rows,events:(await server.observer.query("SELECT * FROM loom.shared_activity WHERE kind='revision.published' ORDER BY position")).rows},before);
    assert.equal((await human.client.call('/api/v1/me/saved-items')).body.items[0].source.resource.revision_id,artifactRevision);
  });
  await t.test('stale versions, exact retained retry and rollback do not replace newer organization',async()=>{
    const k1=await fresh(artifact,'artifact.move',{parent_id:b});loseKey=k1.idempotency_key;
    const lost=await admin.call(changes,k1);assert.equal(lost.status,503);assert.equal(lost.body.error.operation_outcome,'unknown');
    const k2=await fresh(artifact,'artifact.move',{parent_id:c});await apply(k2);
    const replay=await apply(k1);assert.equal(replay.outcome.parent_id,b);assert.equal(replay.current.parent_id,c);assert.equal(replay.idempotency,'replayed');
    assert.equal((await admin.call(changes,{...k1,parent_id:a})).status,409);
    assert.equal((await admin.call(changes,{...k1,idempotency_key:randomUUID()})).body.error.code,'organization_conflict');
    const status=await admin.call('/api/v1/organization/status',{kind:k1.kind,idempotency_key:k1.idempotency_key});assert.equal(status.body.current.parent_id,c);
    assert.equal((await server.observer.query('SELECT count(*)::int AS n FROM loom.organization_operations WHERE idempotency_key=$1',[k1.idempotency_key])).rows[0].n,1);
    const original=await get(c),tail=(await server.observer.query('SELECT shared_position FROM loom.community_clocks')).rows;
    rollback=true;const command=await fresh(c,'area.edit',{title:'Rollback',description:'Never committed'});assert.equal((await admin.call(changes,command)).status,503);rollback=false;
    assert.deepEqual(await get(c),original);assert.deepEqual((await server.observer.query('SELECT shared_position FROM loom.community_clocks')).rows,tail);
    assert.equal((await admin.call('/api/v1/organization/status',{kind:command.kind,idempotency_key:command.idempotency_key})).body.operation_state,'not_recorded');
  });
  await t.test('concurrent exact commands create one decision, event, outbox intent and audit record',async()=>{
    const command=await fresh(c,'area.open');
    const results=await Promise.all([admin.call(changes,command),admin.call(changes,command)]);
    assert.deepEqual(results.map(r=>r.status),[200,200]);
    assert.equal(results[0]!.body.operation_id,results[1]!.body.operation_id);
    assert.deepEqual(results.map(r=>r.body.idempotency).sort(),['created','replayed']);
    const persisted=(await server.observer.query(`SELECT count(*)::int AS n FROM loom.organization_operations o
      JOIN loom.shared_activity e ON e.id=o.source_event_id JOIN loom.outbox_intents i ON i.source_event_id=e.id
      JOIN loom.organization_audit a ON a.operation_id=o.id WHERE o.idempotency_key=$1 AND e.revision_id IS NULL
      AND e.kind='organization.changed' AND i.kind='organization.project'`,[command.idempotency_key])).rows;
    assert.equal(persisted[0].n,1);
  });
  await t.test('move versus publication and close versus publication in both lock/commit orders',async()=>{
    for(const operation of ['move','close'] as const) for(const structuralFirst of [false,true]) {
      const area=(await create('Race '+operation)).current.resource_id;
      const created=await human.client.call('/api/v1/discussions',{idempotency_key:randomUUID(),area_id:area,title:'Race source',content:content('Source')});
      const openingId=created.body.resource_id,discussionId=(await human.client.call('/api/v1/resources/'+openingId)).body.discussion_id;
      const structural=await fresh(area,operation==='move'?'area.move':'area.close',operation==='move'?{parent_id:b}:{});
      const publication={idempotency_key:randomUUID(),discussion_id:discussionId,parent_id:openingId,content:content('Racing reply')};
      const gate={exclusive:structuralFirst,entered:barrier(),release:barrier(),attempted:barrier()};hold=gate;
      const first=structuralFirst?admin.call(changes,structural):human.client.call('/api/v1/replies',publication);await gate.entered.promise;
      const second=structuralFirst?human.client.call('/api/v1/replies',publication):admin.call(changes,structural);await gate.attempted.promise;gate.release.release();
      const results=await Promise.all([first,second]),published=results[structuralFirst?1:0],organized=results[structuralFirst?0:1];
      assert.equal(organized!.status,200);
      assert.equal(published!.status,operation==='close'&&structuralFirst?403:201);
      const events=(await server.observer.query('SELECT kind,area_scope_ids,position::text FROM loom.shared_activity WHERE resource_id=$1 OR resource_id=$2 ORDER BY position',[area,published!.body.resource_id??openingId])).rows;
      if(published!.status===201) {
        const event=events.find(r=>r.kind==='revision.published')!;
        assert.deepEqual(event.area_scope_ids,operation==='move'&&structuralFirst?[area,b]:[area]);
        const structuralEvent=events.find(r=>r.kind==='organization.changed'&&r.area_scope_ids.includes(area))!;
        // The creation event may precede both; inspect this command's exact event.
        const committed=(await server.observer.query('SELECT e.position::text FROM loom.shared_activity e JOIN loom.organization_operations o ON o.source_event_id=e.id WHERE o.idempotency_key=$1',[structural.idempotency_key])).rows[0];
        assert.equal(BigInt(event.position)>BigInt(committed.position),structuralFirst);assert.ok(structuralEvent);
      }
      const old=(await server.observer.query('SELECT area_scope_ids FROM loom.shared_activity WHERE resource_id=$1',[openingId])).rows[0];assert.deepEqual(old.area_scope_ids,[area]);
    }
  });
  await t.test('inherited closure blocks creation/replies/revisions but keeps reading and independent child closure',async()=>{
    await apply(await fresh(child,'area.close'));await apply(await fresh(b,'area.close'));
    assert.equal((await get(child)).publication_open,false);
    for(const [path,body] of [['/api/v1/discussions',{area_id:a,title:'Denied',content:content('Closed')}],['/api/v1/artifacts',{area_id:a,title:'Denied',content:content('Closed')}]])
      assert.equal((await human.client.call(path as string,{idempotency_key:randomUUID(),...body as object})).status,403);
    await apply(await fresh(discussion,'discussion.move',{parent_id:child}));await apply(await fresh(artifact,'artifact.move',{parent_id:child}));
    assert.equal((await human.client.call('/api/v1/replies',{idempotency_key:randomUUID(),discussion_id:discussion,parent_id:opening,content:content('Denied')})).status,403);
    for(const client of [human.client,admin])assert.equal((await client.call('/api/v1/revisions',{idempotency_key:randomUUID(),resource_id:artifact,expected_revision_id:artifactRevision,title:'Denied',content:content('Denied')})).status,403);
    assert.equal((await human.client.call('/api/v1/resources/'+artifact)).status,200);
    await apply(await fresh(b,'area.open'));assert.equal((await get(a)).publication_open,true);assert.equal((await get(child)).publication_open,false);
    await apply(await fresh(child,'area.open'));assert.equal((await get(child)).publication_open,true);
  });
  await t.test('bounded roots/destinations, depth, input/byte bounds, and explicit cursor recovery',async()=>{
    const page=await admin.call('/api/v1/organization/children?limit=1');assert.equal(page.body.items.length,1);assert.ok(page.body.next_cursor);
    const destinations=await admin.call('/api/v1/organization/destinations?limit=25&max_response_bytes=4096');assert.equal(destinations.status,200);assert.ok(destinations.bytes<=4096);assert.ok(destinations.body.next_cursor);
    const ordinary=await admin.call('/api/v1/areas?limit=1');
    await apply(await fresh(a,'area.edit',{title:'Science renamed',description:'Current scope'}));
    for(const url of ['/api/v1/organization/children?cursor='+encodeURIComponent(page.body.next_cursor),'/api/v1/areas?cursor='+encodeURIComponent(ordinary.body.next_cursor)]) {
      const response=await admin.call(url);assert.equal(response.body.error.code,'invalid_cursor');assert.equal(response.body.error.recovery.action,'replay_view');
    }
    assert.equal((await admin.call('/api/v1/organization/destinations?limit=26')).status,400);
    const audit=await admin.call('/api/v1/organization/audit?limit=25&max_response_bytes=4096');
    assert.equal(audit.status,200);assert.ok(audit.bytes<=4096);assert.ok(audit.body.next_cursor);assert.ok(audit.body.items.length<25);
    assert.equal((await admin.call(changes,{idempotency_key:randomUUID(),kind:'area.create',parent_id:null,title:'Too large',description:'界'.repeat(1000),expected_hierarchy_version:await epoch()})).status,400);
    let deep=(await create('Depth 1')).current.resource_id;
    for(let depth=2;depth<=12;depth++)deep=(await create('Depth '+depth,deep)).current.resource_id;
    assert.equal((await admin.call(changes,{idempotency_key:randomUUID(),kind:'area.create',parent_id:deep,title:'Too deep',description:'Limit',expected_hierarchy_version:await epoch()})).body.error.code,'organization_limit');
    assert.equal((await admin.call(changes,await fresh(a,'area.move',{parent_id:deep}))).body.error.code,'organization_limit');
  });
  await t.test('proposal route binding survives rename/move, rejects changed/closed destinations and retains affected reference',async()=>{
    const route=(await agent.client.call('/api/v1/areas/'+a+'/proposal-route')).body;assert.equal(route.state,'ready');assert.ok(route.contacts.length);
    const communityProposal=await agent.client.call('/api/v1/discussions',{idempotency_key:randomUUID(),area_id:route.destination.resource_id,title:'Community suggestion',content:content('Applies to the community'),proposal_context:{expected_settings_version:route.settings_version}});
    assert.equal(communityProposal.status,201,'community-wide suggestions bind routing without inventing an affected topic');
    assert.equal((await agent.client.call('/api/v1/resources/'+communityProposal.body.resource_id)).body.affected_area_id,undefined);
    const proposal={idempotency_key:randomUUID(),area_id:route.destination.resource_id,title:'Organization suggestion',content:content('An ordinary suggestion'),proposal_context:{affected_area_id:a,expected_settings_version:route.settings_version}};
    await apply(await fresh(feedback,'area.edit',{title:'Community feedback',description:'Proposal scope'}));await apply(await fresh(feedback,'area.move',{parent_id:c}));
    const designation=(await admin.call('/api/v1/community')).body;
    assert.equal(designation.proposal_area.resource_id,feedback);assert.equal(designation.settings_version,route.settings_version);
    const published=await agent.client.call('/api/v1/discussions',proposal);assert.equal(published.status,201);
    await apply(await fresh(a,'area.move',{parent_id:c}));
    assert.equal((await agent.client.call('/api/v1/resources/'+published.body.resource_id)).body.affected_area_id,a);
    await apply(await fresh(feedback,'area.close'));
    assert.equal((await agent.client.call('/api/v1/areas/'+a+'/proposal-route')).body.state,'unavailable');
    assert.equal((await agent.client.call('/api/v1/discussions',{...proposal,idempotency_key:randomUUID()})).status,403);
    const settings=(await admin.call('/api/v1/community')).body;
    assert.equal((await admin.call('/api/v1/community/settings',{idempotency_key:randomUUID(),expected_version:settings.settings_version,community_name:settings.community_name,overview_id:settings.overview.resource_id,proposal_area_id:c})).status,200);
    assert.equal((await agent.client.call('/api/v1/discussions',{...proposal,idempotency_key:randomUUID()})).body.error.code,'proposal_route_changed');
    await apply(await fresh(feedback,'area.open'));
  });
  await t.test('current authority and source suppression apply to recovery, metadata, destinations and Saved paths',async()=>{
    const command=await fresh(c,'area.edit',{title:'Retained destination',description:'Scope'});await apply(command,agentAdmin.client);
    await server.observer.query("UPDATE loom.participants SET role='participant' WHERE id=$1",[agentAdmin.id]);
    assert.equal((await agentAdmin.client.call('/api/v1/organization/status',{kind:command.kind,idempotency_key:command.idempotency_key})).status,403);
    assert.equal((await agentAdmin.client.call(changes,command)).status,403);
    await server.observer.query("UPDATE loom.participants SET role='administrator' WHERE id=$1",[agentAdmin.id]);
    await server.observer.query("UPDATE loom.resources SET state='suppressed' WHERE id=$1",[c]);
    for(const path of ['/api/v1/organization/resources/'+a,'/api/v1/areas/'+a+'/metadata-history','/api/v1/areas/'+a+'/proposal-route','/api/v1/resources/'+artifact])assert.equal((await human.client.call(path)).status,404);
    assert.equal((await agentAdmin.client.call('/api/v1/organization/status',{kind:command.kind,idempotency_key:command.idempotency_key})).status,404);
    assert.ok(!(await human.client.call('/api/v1/organization/destinations')).body.items.some((r:any)=>[a,c].includes(r.resource_id)));
    assert.equal((await human.client.call('/api/v1/me/saved-items')).body.items[0].source.state,'unavailable');
    await server.observer.query("UPDATE loom.resources SET state='active' WHERE id=$1",[c]);
  });
  await t.test('server restart and separate HTTPS client processes recover an earlier move without applying it again',async()=>{
    const command=await fresh(artifact,'artifact.move',{parent_id:b});
    const journal=server.directory+'/organization-intent.json',secret=server.directory+'/organization-credential';
    const file=await open(journal,'wx',0o600);try{await file.writeFile(JSON.stringify(command));await file.sync();}finally{await file.close();}
    const directory=await open(server.directory,'r');try{await directory.sync();}finally{await directory.close();}
    await writeFile(secret,agentAdmin.secret,{mode:0o600});
    loseKey=command.idempotency_key;assert.equal((await agentAdmin.client.call(changes,command)).status,503);
    await apply(await fresh(artifact,'artifact.move',{parent_id:c}),agentAdmin.client);
    const cursor=(await agentAdmin.client.call('/api/v1/organization/destinations?limit=1')).body.next_cursor;
    await server.app.close();
    const script=server.directory+'/retry.mjs';await writeFile(script,`import {readFileSync} from 'node:fs'; import {request} from 'node:https';
      const [origin,journal,secret,cert]=process.argv.slice(2),body=readFileSync(journal,'utf8');
      const req=request(new URL('/api/v1/organization/changes',origin),{ca:readFileSync(cert),method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+readFileSync(secret,'utf8')}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>{const r=JSON.parse(text);if(res.statusCode!==200)process.exitCode=1;else process.stdout.write(JSON.stringify({original:r.outcome.parent_id,current:r.current.parent_id,id:r.operation_id}));});});req.on('error',()=>{process.exitCode=1});req.end(body);`);
    // Start a separately compiled server process twice against the same isolated
    // database. Neither it nor each fresh client inherits the old service objects.
    for(let i=0;i<2;i++) {
      const child=spawn(process.execPath,['dist/server/main.js','--mode','api'],{stdio:['ignore','pipe','ignore'],env:{
        ...process.env,LOOM_PARTICIPATION_PROFILE:'synthetic',LOOM_ORIGIN:server.origin,LOOM_API_HOST:'127.0.0.1',LOOM_API_PORT:new URL(server.origin).port,
        LOOM_DATABASE_HOST:server.configuration.host,LOOM_POSTGRES_PORT:String(server.configuration.port),LOOM_DATABASE_NAME:server.configuration.database,
        LOOM_DATABASE_USER:server.configuration.user,LOOM_PG_APP_PASSWORD:server.configuration.password,
        LOOM_TLS_KEY_FILE:server.directory+'/key.pem',LOOM_TLS_CERT_FILE:server.directory+'/cert.pem',
      }});
      const exited=new Promise<number|null>(resolve=>child.once('exit',resolve));
      t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await exited;}});
      await new Promise<void>((resolve,reject)=>{
        const timer=setTimeout(()=>reject(new Error('Compiled organization server did not become ready.')),15000);
        let buffer='';child.stdout.on('data',chunk=>{buffer=(buffer+String(chunk)).slice(-8192);if(buffer.includes('"event":"application_started"')){clearTimeout(timer);resolve();}});
        child.once('error',()=>{clearTimeout(timer);reject(new Error('Compiled organization server could not start.'));});
        child.once('exit',()=>{clearTimeout(timer);reject(new Error('Compiled organization server exited before readiness.'));});
      });
      const result=await promisify(execFile)(process.execPath,[script,server.origin,journal,secret,server.directory+'/cert.pem']);
      const found=JSON.parse(result.stdout);assert.equal(found.original,b);assert.equal(found.current,c);
      assert.equal((await agentAdmin.client.call('/api/v1/organization/destinations?cursor='+encodeURIComponent(cursor))).body.error.code,'invalid_cursor');
      child.kill('SIGTERM');assert.equal(await exited,0);
    }
    const rows=(await server.observer.query('SELECT count(*)::int AS n FROM loom.organization_operations WHERE idempotency_key=$1',[command.idempotency_key])).rows;assert.equal(rows[0].n,1);
    const coverage=(await server.observer.query('SELECT (SELECT shared_position FROM loom.community_clocks) = count(*) AS complete FROM loom.shared_activity')).rows;assert.equal(coverage[0].complete,true);
  });
});

test('synthetic area, subtree and retained-decision caps refuse new work without losing exact recovery', {timeout:120000},async t=>{
  const server=await syntheticServer();t.after(server.close);
  const admin=httpClient(server.origin,await readFile(server.directory+'/cert.pem','utf8'));await admin.enroll(server.ticket);
  const command={idempotency_key:randomUUID(),kind:'area.create',parent_id:null,title:'Bounded root',description:'Synthetic capacity fixture',expected_hierarchy_version:0};
  const created=await admin.call(changes,command);assert.equal(created.status,200);const root=created.body.current.resource_id;
  const seedAreas=async(count:number)=>server.observer.query(`WITH r AS (
    INSERT INTO loom.resources(id,kind,owner_resource_id) SELECT gen_random_uuid(),'area',$1 FROM generate_series(1,$2::int) RETURNING id
  ) INSERT INTO loom.areas(id,title,description) SELECT id,'Bounded child','Synthetic fixture' FROM r`,[root,count]);
  await seedAreas(499);
  const excess=await admin.call(changes,{...command,idempotency_key:randomUUID(),expected_hierarchy_version:1});
  assert.equal(excess.body.error.code,'organization_limit');
  const move={idempotency_key:randomUUID(),kind:'area.move',resource_id:root,parent_id:null,expected_version:1,expected_hierarchy_version:1};
  assert.equal((await admin.call(changes,move)).status,200,'exactly 500 areas of subtree work fit');
  await seedAreas(1);
  const tooLarge=await admin.call(changes,{...move,idempotency_key:randomUUID(),expected_version:2,expected_hierarchy_version:2});
  assert.equal(tooLarge.body.error.code,'organization_limit','an oversized imported subtree stops explicitly');
  const decision=(await server.observer.query('SELECT * FROM loom.organization_operations WHERE idempotency_key=$1',[command.idempotency_key])).rows[0];
  const position=Number((await server.observer.query('SELECT shared_position FROM loom.community_clocks')).rows[0].shared_position);
  await server.observer.query(`WITH events AS (
    INSERT INTO loom.shared_activity(id,position,kind,resource_id,revision_id,publisher_id,area_scope_ids,before_area_scope_ids,after_area_scope_ids)
    SELECT gen_random_uuid(),$1::bigint+n,'organization.changed',$2,NULL,$3,ARRAY[$2::uuid],ARRAY[$2::uuid],ARRAY[$2::uuid]
    FROM generate_series(1,9998) AS n RETURNING id
  ) INSERT INTO loom.organization_operations(id,actor_id,operation_kind,idempotency_key,semantic_version,request_digest,resource_id,original_parent_id,result_version,hierarchy_version,local_open,source_event_id)
    SELECT gen_random_uuid(),$3,'area.open',gen_random_uuid(),'organization-v1',$4,$2,NULL,2,2,true,id FROM events`,[position,root,server.administratorId,decision.request_digest]);
  await server.observer.query('UPDATE loom.community_clocks SET shared_position=shared_position+9998');
  const before=(await server.observer.query('SELECT shared_position FROM loom.community_clocks')).rows;
  assert.equal((await admin.call(changes,{idempotency_key:randomUUID(),kind:'area.close',resource_id:root,expected_version:2,expected_hierarchy_version:2})).body.error.code,'organization_limit');
  const replay=await admin.call(changes,command);assert.equal(replay.status,200);assert.equal(replay.body.idempotency,'replayed');assert.equal(replay.body.current.version,2);
  assert.deepEqual((await server.observer.query('SELECT shared_position FROM loom.community_clocks')).rows,before);
  assert.equal((await server.observer.query('SELECT count(*)::int AS n FROM loom.organization_operations')).rows[0].n,10000);
});
