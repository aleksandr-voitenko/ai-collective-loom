import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { isolatedPublicationPostgres } from '../helpers/publication-postgres.js';
import { barrier, bounded, blockedBy } from '../helpers/search-races.js';
import { SearchWorker } from '../../src/server/modules/search/worker.js';
import { ParticipationPublications } from '../../src/server/modules/participation/publications.js';
import { TextSearch } from '../../src/server/modules/search/search.js';
import type { Transactions } from '../../src/server/modules/publication/publication.js';
import type { QueryResultRow } from 'pg';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { NativeSearchWorker } from '../../scripts/lib/native-search-worker.js';

const content = (text: string) => ({ format: 'loom-markdown-v1', text, mentions: [] });

test('claim updates cannot revive ownership after expiry while waiting for a job lock', { timeout: 30000 }, async t => {
  const f = await isolatedPublicationPostgres(); t.after(f.close);
  const admin = await f.participant('administrator');
  await new ParticipationPublications(f.database).publish(admin.actor, 'community.setup', {
    idempotency_key: randomUUID(), community_name: 'Lease race', ordinary_area_name: 'General',
    proposal_area_name: 'Feedback', overview: content('Retained lease source'),
  });
  const worker = new SearchWorker(f.database); await worker.discover();
  const claim = (await worker.claim(1))[0]!;
  for (const action of ['renew', 'fail'] as const) await t.test(action, async () => {
    const entered = barrier<number>();
    const waiting: Transactions = { transaction: work => f.database.transaction(async tx => {
      entered.release((await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid', [])).rows[0]!.pid);
      return work(tx);
    }) };
    await f.observer.query("UPDATE loom.search_jobs SET lease_until=clock_timestamp()+interval '1 second' WHERE id=$1", [claim.id]);
    const before = (await f.observer.query('SELECT * FROM loom.search_jobs WHERE id=$1', [claim.id])).rows;
    await f.observer.query('BEGIN');
    await f.observer.query('SELECT id FROM loom.search_jobs WHERE id=$1 FOR UPDATE', [claim.id]);
    const holder = (await f.observer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const pending = new SearchWorker(waiting)[action](claim);
    try {
      await blockedBy(f.observer, await bounded(entered.promise), holder);
      assert.equal((await f.observer.query('SELECT lease_until>clock_timestamp() AS live FROM loom.search_jobs WHERE id=$1', [claim.id])).rows[0].live, true);
      // Wait for this stored lease's deadline, not an arbitrary race sleep.
      await f.observer.query('SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM lease_until-clock_timestamp()))) FROM loom.search_jobs WHERE id=$1', [claim.id]);
      assert.equal((await f.observer.query('SELECT lease_until<=clock_timestamp() AS expired FROM loom.search_jobs WHERE id=$1', [claim.id])).rows[0].expired, true);
    } finally { await f.observer.query('COMMIT'); }
    assert.equal(await pending, false);
    assert.deepEqual((await f.observer.query('SELECT * FROM loom.search_jobs WHERE id=$1', [claim.id])).rows, before);
  });
});

test('populated 0007 upgrade preserves jobs and recovers previously skipped intents', { timeout: 60000 }, async t => {
  const f = await isolatedPublicationPostgres({ throughMigration: 7 }); t.after(f.close);
  const admin = await f.participant('administrator'), publications = new ParticipationPublications(f.database);
  const source = await publications.publish(admin.actor, 'community.setup', { idempotency_key: randomUUID(), community_name: 'Search upgrade',
    ordinary_area_name: 'General', proposal_area_name: 'Feedback', overview: content('Retained indexed overview') });
  const area = (await f.observer.query("SELECT id FROM loom.areas WHERE title='General'")).rows[0].id;
  const originalEvent = (await f.observer.query('SELECT id FROM loom.shared_activity WHERE revision_id=$1', [source.revision_id])).rows[0].id;
  const job = randomUUID(), failed = randomUUID(), event = randomUUID(), skippedIntent = randomUUID(), failedIntent = randomUUID();
  await f.database.transaction(async tx => {
    await tx.query("INSERT INTO loom.search_jobs(id,generation,resource_id,revision_id,kind,state,outcome,attempts,claim_generation) VALUES ($1,1,$2,$3,'revision','succeeded','indexed',1,1)", [job, source.resource_id, source.revision_id]);
    await tx.query(`INSERT INTO loom.search_documents(resource_id,revision_id,revision_number,generation,job_id,title,body,document)
      SELECT resource_id,id,revision_number,1,$2,COALESCE(title,''),content_text,to_tsvector('simple',content_text) FROM loom.revisions WHERE id=$1`, [source.revision_id, job]);
    await tx.query("INSERT INTO loom.outbox_intents(id,source_event_id,kind) VALUES ($1,$2,'organization.project')", [skippedIntent, originalEvent]);
    const position = (await tx.query<{ position: string }>('UPDATE loom.community_clocks SET shared_position=shared_position+1 WHERE id=1 RETURNING shared_position::text AS position', [])).rows[0]!.position;
    await tx.query("INSERT INTO loom.shared_activity(id,position,kind,resource_id,revision_id,publisher_id,area_scope_ids,before_area_scope_ids,after_area_scope_ids) VALUES ($1,$2,'organization.changed',$3,NULL,$4,$5,$5,$5)", [event, position, area, admin.participantId, [area]]);
    await tx.query("INSERT INTO loom.outbox_intents(id,source_event_id,kind) VALUES ($1,$2,'publication.project')", [failedIntent, event]);
    await tx.query("INSERT INTO loom.search_jobs(id,generation,resource_id,source_event_id,kind,state,attempts,claim_generation,failure) VALUES ($1,1,$2,$3,'unsupported','failed',3,3,'unsupported_event')", [failed, area, event]);
    await tx.query('UPDATE loom.search_state SET scan_complete=true,event_after=$1 WHERE id=1', [position]);
  });
  const snapshot = async () => {
    const rows: Record<string, unknown> = {};
    for (const table of ['revisions', 'shared_activity', 'outbox_intents', 'saved_items', 'search_documents']) rows[table] = (await f.observer.query(`SELECT * FROM loom.${table} ORDER BY 1`)).rows;
    rows.jobs = (await f.observer.query('SELECT id,generation,resource_id,revision_id,source_event_id,kind,state,outcome,attempts,claim_generation,failure FROM loom.search_jobs ORDER BY id')).rows;
    return rows;
  };
  const before = await snapshot();
  // Migration 0011 adds explicit empty note projections and main-field provenance; every old column remains compared.
  for(const row of before.search_documents as Record<string,unknown>[])Object.assign(row,{note_text:'',note_document:''});
 await f.migrate(); await f.migrate(); assert.deepEqual(await snapshot(), before);
  assert.deepEqual((await f.observer.query('SELECT event_after::text,event_after_intent FROM loom.search_state')).rows, [{ event_after: '0', event_after_intent: null }]);
  assert.equal((await f.observer.query('SELECT source_intent_id FROM loom.search_jobs WHERE id=$1', [failed])).rows[0].source_intent_id, failedIntent);
  const worker = new SearchWorker(f.database); await worker.discover(); await worker.discover();
  assert.equal((await f.observer.query('SELECT count(*)::int AS n FROM loom.search_jobs')).rows[0].n, 3);
  assert.deepEqual((await f.observer.query('SELECT source_intent_id,state FROM loom.search_jobs WHERE id<>ALL($1::uuid[])', [[job, failed]])).rows, [{ source_intent_id: skippedIntent, state: 'pending' }]);
  assert.deepEqual((await f.observer.query('SELECT * FROM loom.search_documents')).rows, before.search_documents);
  assert.equal((await f.observer.query('SELECT state FROM loom.search_jobs WHERE id=$1', [failed])).rows[0].state, 'failed');
});

test('simultaneous bounded claims have distinct owners and no duplicate jobs', { timeout: 30000 }, async t => {
  const f = await isolatedPublicationPostgres(); t.after(f.close);
  const admin = await f.participant('administrator'), publications = new ParticipationPublications(f.database);
  await publications.publish(admin.actor, 'community.setup', { idempotency_key: randomUUID(), community_name: 'Concurrent claims',
    ordinary_area_name: 'General', proposal_area_name: 'Feedback', overview: content('Overview') });
  const area = (await f.observer.query("SELECT id FROM loom.areas WHERE title='General'")).rows[0].id;
  for (let i = 0; i < 49; i++) await publications.publish(admin.actor, 'artifact.create', { idempotency_key: randomUUID(), area_id: area, title: 'Claim source', content: content('Claim body') });
  await new SearchWorker(f.database).discover();
  const both = barrier(), resume = barrier(); let entered = 0;
  const synchronized: Transactions = { transaction: work => f.database.transaction(tx => work({ query: async <Row extends QueryResultRow>(sql: string, values: readonly unknown[]) => {
    if (sql.startsWith('WITH due AS')) { if (++entered === 2) both.release(); await bounded(resume.promise); }
    return tx.query<Row>(sql, values);
  } })) };
  const a = new SearchWorker(synchronized), b = new SearchWorker(synchronized), pending = Promise.all([a.claim(), b.claim()]);
  try { await bounded(both.promise); } finally { resume.release(); }
  const [first, second] = await pending;
  assert.equal(first.length, 25); assert.equal(second.length, 25);
  assert.equal(new Set([...first, ...second].map(row => row.id)).size, 50);
  assert.ok(first.every(row => row.owner === a.owner && row.claim_generation === 1));
  assert.ok(second.every(row => row.owner === b.owner && row.claim_generation === 1));
  assert.notEqual(a.owner, b.owner);
  assert.equal((await f.observer.query("SELECT count(*)::int AS n FROM loom.search_jobs WHERE state='running' AND lease_until>clock_timestamp() AND attempts=1")).rows[0].n, 50);
});

test('native process loss during unfinished rebuild resumes both discovery cursors', { timeout: 120000 }, async t => {
  const f = await isolatedPublicationPostgres(); t.after(f.close);
  const admin = await f.participant('administrator'), publications = new ParticipationPublications(f.database);
  await publications.publish(admin.actor, 'community.setup', { idempotency_key: randomUUID(), community_name: 'Interrupted rebuild',
    ordinary_area_name: 'General', proposal_area_name: 'Feedback', overview: content('Overview') });
  const area = (await f.observer.query("SELECT id FROM loom.areas WHERE title='General'")).rows[0].id;
  for (let i = 0; i < 120; i++) await publications.publish(admin.actor, 'artifact.create', { idempotency_key: randomUUID(), area_id: area, title: 'Rebuild source', content: content('Retained rebuild body') });
  const worker = new SearchWorker(f.database), search = new TextSearch(f.database), native = new NativeSearchWorker(f.configuration);
  t.after(() => native.stop());
  for (let i = 0; i < 6; i++) await worker.tick();
  assert.equal((await search.status(admin.actor)).coverage, 'current_supported_text');
  async function child(phase: string) {
    const c = f.configuration, process = spawn(globalThis.process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../fixtures/search-discovery.ts', import.meta.url)), phase], {
      env: { ...globalThis.process.env, LOOM_DATABASE_HOST: c.host, LOOM_POSTGRES_PORT: String(c.port), LOOM_DATABASE_NAME: c.database, LOOM_DATABASE_USER: c.user, LOOM_PG_APP_PASSWORD: c.password },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const closed = once(process, 'close'), reached = barrier();
    process.on('message', value => { if (value && typeof value === 'object' && 'stage' in value && value.stage === phase) reached.release(); });
    const kill = async () => { if (process.exitCode === null && process.signalCode === null) process.kill('SIGKILL'); await bounded(closed); };
    t.after(kill); await bounded(reached.promise); return { kill };
  }
  const progress = async () => (await f.observer.query('SELECT generation,source_after,scan_complete,event_after::text,event_after_intent FROM loom.search_state')).rows[0];
  let generation = 1;
  for (const phase of ['before_commit', 'after_commit']) await t.test(phase, async () => {
    const retained = async () => {
      const rows: Record<string, unknown> = {};
      for (const table of ['revisions', 'shared_activity', 'outbox_intents', 'saved_items']) rows[table] = (await f.observer.query(`SELECT * FROM loom.${table} ORDER BY 1`)).rows;
      return rows;
    };
    const beforeSources = await retained();
    await search.rebuild(admin.actor, generation++); await worker.discover();
    const first = await progress(); assert.equal(first.scan_complete, false);
    const beforeJobs = (await f.observer.query('SELECT * FROM loom.search_jobs WHERE generation=$1 ORDER BY id', [generation])).rows;
    const held = await child(phase), interrupted = await progress();
    assert.equal(interrupted.scan_complete, false);
    if (phase === 'before_commit') assert.deepEqual(interrupted, first);
    else { assert.notEqual(interrupted.source_after, first.source_after); assert.ok(BigInt(interrupted.event_after) > BigInt(first.event_after)); }
    await held.kill();
    // Waiting on the state guard proves the killed transaction has released it.
    await f.database.transaction(tx => tx.query('SELECT id FROM loom.search_state WHERE id=1 FOR UPDATE', []));
    assert.deepEqual(await progress(), interrupted);
    if (phase === 'before_commit') assert.deepEqual((await f.observer.query('SELECT * FROM loom.search_jobs WHERE generation=$1 ORDER BY id', [generation])).rows, beforeJobs);
    assert.deepEqual(await retained(), beforeSources);
    const old = (await f.observer.query("SELECT id,current_revision_id FROM loom.resources WHERE kind='artifact' AND owner_resource_id=$1 AND id<=$2 ORDER BY id LIMIT 1", [area, interrupted.source_after])).rows[0];
    assert.ok(old);
    const edit = await publications.publish(admin.actor, 'revision.publish', { idempotency_key: randomUUID(), resource_id: old.id, expected_revision_id: old.current_revision_id, title: 'Changed behind scan', content: content('quasar recovered edit') });
    const added = await publications.publish(admin.actor, 'artifact.create', { idempotency_key: randomUUID(), area_id: area, title: 'Concurrent source', content: content('nebula recovered addition') });
    await native.start();
    try { await native.observeUntil(async () => (await search.status(admin.actor)).indexing === 'ready'); }
    finally { await native.stop(); }
    assert.equal((await f.observer.query('SELECT revision_id FROM loom.search_documents WHERE resource_id=$1', [old.id])).rows[0].revision_id, edit.revision_id);
    assert.equal((await f.observer.query('SELECT revision_id FROM loom.search_documents WHERE resource_id=$1', [added.resource_id])).rows[0].revision_id, added.revision_id);
    assert.equal((await f.observer.query(`SELECT count(*)::int AS n FROM loom.resources r JOIN loom.artifacts a ON a.id=r.id
      LEFT JOIN loom.search_documents d ON d.resource_id=r.id AND d.revision_id=r.current_revision_id AND d.generation=$1 WHERE d.resource_id IS NULL`, [generation])).rows[0].n, 0);
    assert.equal((await f.observer.query("SELECT count(*)::int AS n FROM loom.search_jobs WHERE generation=$1 AND state<>'succeeded'", [generation])).rows[0].n, 0);
    const complete = await progress(); await search.rebuild(admin.actor, generation - 1); assert.deepEqual(await progress(), complete);
    const afterSources = await retained();
    for (const table of ['revisions', 'shared_activity', 'outbox_intents', 'saved_items']) {
      const previous = beforeSources[table] as { id: string }[];
      assert.deepEqual((afterSources[table] as { id: string }[]).filter(row => previous.some(saved => saved.id === row.id)), previous);
    }
  });
});

test('unsupported intents survive revision collisions and a split event-discovery page', { timeout: 60000 }, async t => {
  const f = await isolatedPublicationPostgres(); t.after(f.close);
  const admin = await f.participant('administrator'), publications = new ParticipationPublications(f.database);
  await publications.publish(admin.actor, 'community.setup', { idempotency_key: randomUUID(), community_name: 'Intent recovery',
    ordinary_area_name: 'General', proposal_area_name: 'Feedback', overview: content('Retained overview') });
  const area = (await f.observer.query("SELECT id FROM loom.areas WHERE title='General'")).rows[0].id;
  for (let i = 0; i < 49; i++) await publications.publish(admin.actor, 'artifact.create', {
    idempotency_key: randomUUID(), area_id: area, title: 'Intent source', content: content('Retained searchable text'),
  });
  const last = (await f.observer.query('SELECT id,revision_id FROM loom.shared_activity ORDER BY position DESC LIMIT 1')).rows[0];
  // Sort this unsupported intent before the valid one at the 50-row boundary.
  const unsupported = '00000000-0000-0000-0000-000000000000';
  await f.database.transaction(tx => tx.query("INSERT INTO loom.outbox_intents(id,source_event_id,kind) VALUES ($1,$2,'organization.project')", [unsupported, last.id]));
  const worker = new SearchWorker(f.database), search = new TextSearch(f.database);
  await worker.discover();
  assert.equal((await f.observer.query("SELECT count(*)::int AS n FROM loom.search_jobs WHERE kind='unsupported' AND revision_id=$1", [last.revision_id])).rows[0].n, 1);
  assert.equal((await search.health(admin.actor)).event_discovery_caught_up, false);
  await worker.discover(); await worker.discover();
  assert.equal((await search.health(admin.actor)).event_discovery_caught_up, true);
  assert.equal((await f.observer.query('SELECT count(*)::int AS n FROM loom.search_jobs')).rows[0].n, 51);
  const event = randomUUID(), wrong = randomUUID(), known = randomUUID();
  await f.database.transaction(async tx => {
    const position = (await tx.query<{ position: string }>('UPDATE loom.community_clocks SET shared_position=shared_position+1 WHERE id=1 RETURNING shared_position::text AS position', [])).rows[0]!.position;
    await tx.query("INSERT INTO loom.shared_activity(id,position,kind,resource_id,revision_id,publisher_id,area_scope_ids,before_area_scope_ids,after_area_scope_ids) VALUES ($1,$2,'organization.changed',$3,NULL,$4,$5,$5,$5)", [event, position, area, admin.participantId, [area]]);
    await tx.query("INSERT INTO loom.outbox_intents(id,source_event_id,kind) VALUES ($1,$3,'publication.project'),($2,$3,'organization.project')", [wrong, known, event]);
  });
  await worker.discover(); await worker.discover();
  for (let round = 0; round < 6; round++) {
    for (const claim of await worker.claim()) await worker.process(claim);
    await f.observer.query("UPDATE loom.search_jobs SET due_at=clock_timestamp() WHERE state='pending' AND failure='unsupported_event'");
  }
  const failures = (await f.observer.query("SELECT source_intent_id,kind,state,attempts,failure FROM loom.search_jobs WHERE kind='unsupported' ORDER BY source_intent_id")).rows;
  assert.deepEqual(failures, [unsupported, wrong].sort().map(source_intent_id => ({ source_intent_id, kind: 'unsupported', state: 'failed', attempts: 3, failure: 'unsupported_event' })));
  assert.equal((await f.observer.query('SELECT count(*)::int AS n FROM loom.search_documents')).rows[0].n, 50);
  assert.equal((await f.observer.query("SELECT count(*)::int AS n FROM loom.search_jobs WHERE kind='organization' AND outcome='not_applicable'")).rows[0].n, 1);
  assert.deepEqual((await search.failures(admin.actor)).items.map(row => row.id).sort(), (await f.observer.query("SELECT id FROM loom.search_jobs WHERE state='failed' ORDER BY id")).rows.map(row => row.id));
});
