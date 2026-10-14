import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import type pg from 'pg';
import { PostgresDatabase, type SqlTransaction } from '../../src/server/db/postgres.js';
import { actorFromVerifiedIdentity } from '../../src/server/modules/publication/actor.js';
import { PublicationError } from '../../src/server/modules/publication/errors.js';
import { operationKind, type PublicationInput } from '../../src/server/modules/publication/input.js';
import { PublicationOperation, type CommittedPublication } from '../../src/server/modules/publication/publication.js';
import { isolatedPublicationPostgres } from '../helpers/publication-postgres.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer!: NodeJS.Timeout;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Controlled concurrency barrier timed out.')), 2500); })]); }
  finally { clearTimeout(timer); }
}
type Hook = (sql: string, parameters: readonly unknown[], tx: SqlTransaction, pid: number) => Promise<void>;
function observe(database: PostgresDatabase, hooks: { before?: Hook; after?: Hook; committed?: () => void }) {
  return {
    async transaction<T>(operation: (transaction: SqlTransaction) => Promise<T>): Promise<T> {
      const result = await database.transaction(async tx => {
        let pid = 0;
        return operation({ query: async <Row extends pg.QueryResultRow>(sql: string, parameters: readonly unknown[]) => {
          await hooks.before?.(sql, parameters, tx, pid);
          const result = await tx.query<Row>(sql, parameters);
          if (sql.startsWith('SET TRANSACTION')) pid = (await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid', [])).rows[0]!.pid;
          await hooks.after?.(sql, parameters, tx, pid);
          return result;
        } });
      });
      hooks.committed?.();
      return result;
    },
  };
}
const isAttemptLock = (sql: string) => sql.startsWith('SELECT pg_advisory_xact_lock(hash');
const isTail = (sql: string) => sql.startsWith('UPDATE loom.community_clocks');
const isOutcome = (sql: string) => sql.startsWith('INSERT INTO loom.idempotency_records');
const inputFor = (resourceId: string, expected: string | null = null, text = 'private synthetic text'): PublicationInput => ({
  resource_id: resourceId, idempotency_key: randomUUID(), expected_revision_id: expected, content: { format: 'text/plain', text },
});
const references = (result: CommittedPublication) => ({ operation_id: result.operation_id, resource_id: result.resource_id, revision_id: result.revision_id });
const failure = (code: PublicationError['code']) => (error: unknown) => error instanceof PublicationError && error.code === code;
async function snapshot(database: PostgresDatabase, resourceId: string) {
  return database.transaction(async tx => ({
    head: (await tx.query<{ current_revision_id: string | null; original_author_id: string }>('SELECT current_revision_id, original_author_id FROM loom.resources WHERE id = $1', [resourceId])).rows[0],
    revisions: (await tx.query<{ id: string; revision_number: string; publisher_id: string; content_text: string; availability: string }>('SELECT id, revision_number::text, publisher_id, content_text, availability FROM loom.revisions r WHERE resource_id = $1 ORDER BY r.revision_number', [resourceId])).rows,
    events: (await tx.query<{ id: string; position: string; revision_id: string; publisher_id: string; area_scope_ids: string[] }>('SELECT id, position::text, revision_id, publisher_id, area_scope_ids FROM loom.shared_activity a WHERE resource_id = $1 ORDER BY a.position', [resourceId])).rows,
    intents: (await tx.query<{ id: string; source_event_id: string; kind: string }>('SELECT i.id, i.source_event_id, i.kind FROM loom.outbox_intents i JOIN loom.shared_activity e ON e.id = i.source_event_id WHERE e.resource_id = $1 ORDER BY e.position', [resourceId])).rows,
    outcomes: (await tx.query<{ id: string; participant_id: string; operation_kind: string; idempotency_key: string; resource_id: string; revision_id: string; source_event_id: string; request_digest: string }>('SELECT id, participant_id, operation_kind, idempotency_key, resource_id, revision_id, source_event_id, request_digest FROM loom.idempotency_records WHERE resource_id = $1 ORDER BY recorded_at, id', [resourceId])).rows,
  }));
}
async function coverage(observer: pg.Client) {
  const row = (await observer.query<{ position: string; events: string[] }>(`SELECT shared_position::text AS position,
    ARRAY(SELECT activity.position::text FROM loom.shared_activity activity WHERE activity.position <= clock.shared_position ORDER BY activity.position) AS events
    FROM loom.community_clocks clock WHERE id = 1`)).rows[0]!;
  assert.deepEqual(row.events, Array.from({ length: Number(row.position) }, (_, index) => String(index + 1)), 'Committed coverage has a gap.');
  return row;
}
async function blockedBy(observer: pg.Client, waiter: number, holder: number) {
  const deadline = Date.now() + 1000;
  while (!(await observer.query<{ blocked: boolean }>('SELECT $2::integer = ANY(pg_blocking_pids($1)) AS blocked', [waiter, holder])).rows[0]!.blocked) {
    if (Date.now() > deadline) throw new Error('Expected PostgreSQL lock conflict was not observed.');
    await delay(5);
  }
}

test('shared publication transactions against isolated PostgreSQL', { timeout: 120_000 }, async t => {
  const fixture = await isolatedPublicationPostgres();
  t.after(fixture.close);
  const { database, observer } = fixture;
  const operation = new PublicationOperation(database);
  const alice = await fixture.participant(), bob = await fixture.participant();

  await t.test('two initially absent attempts serialize, acknowledge after commit, and converge on one complete result', async () => {
    const resource = await fixture.resource(alice.participantId);
    const input = inputFor(resource.resourceId);
    const bothAbsent = deferred<void>(), allowAttempts = deferred<void>(), outcomeWritten = deferred<void>(), allowCommit = deferred<void>();
    const initial: { pid: number; count: string }[] = [];
    let commitObserved = false;
    const publisher = new PublicationOperation(observe(database, {
      before: async (sql, _parameters, tx, pid) => {
        if (!isAttemptLock(sql)) return;
        // Both real transactions observe absence before the operation's mutex.
        // An absent preflight observation is not used as permission to insert.
        const count = (await tx.query<{ count: string }>('SELECT count(*)::text FROM loom.idempotency_records WHERE participant_id = $1 AND operation_kind = $2 AND idempotency_key = $3', [alice.participantId, operationKind, input.idempotency_key])).rows[0]!.count;
        initial.push({ pid, count });
        if (initial.length === 2) bothAbsent.resolve();
        await allowAttempts.promise;
      },
      after: async (sql, _parameters, tx) => {
        if (!isOutcome(sql)) return;
        const counts = (await tx.query<{ counts: number[] }>(`SELECT ARRAY[
          (SELECT count(*) FROM loom.revisions WHERE resource_id = $1),
          (SELECT count(*) FROM loom.resources WHERE id = $1 AND current_revision_id IS NOT NULL),
          (SELECT count(*) FROM loom.shared_activity WHERE resource_id = $1),
          (SELECT count(*) FROM loom.outbox_intents), (SELECT count(*) FROM loom.idempotency_records)]::integer[] AS counts`, [resource.resourceId])).rows[0]!.counts;
        assert.deepEqual(counts, [1, 1, 1, 1, 1]);
        outcomeWritten.resolve();
        await allowCommit.promise;
      }, committed: () => { commitObserved = true; },
    }));
    let acknowledged = false;
    const requests = [publisher.publish(alice.actor, input), publisher.publish(alice.actor, input)].map(promise => promise.then(result => { assert.equal(commitObserved, true); acknowledged = true; return result; }));
    try {
      await bounded(bothAbsent.promise);
      assert.deepEqual(initial.map(row => row.count), ['0', '0']);
      assert.notEqual(initial[0]!.pid, initial[1]!.pid);
      allowAttempts.resolve();
      await bounded(outcomeWritten.promise);
      assert.equal(acknowledged, false);
      const outside = await snapshot(database, resource.resourceId);
      assert.equal(outside.head!.current_revision_id, null);
      for (const rows of [outside.revisions, outside.events, outside.intents, outside.outcomes]) assert.equal(rows.length, 0);
      assert.equal((await coverage(observer)).position, '0');
      allowCommit.resolve();
      const results = await Promise.all(requests);
      assert.deepEqual(references(results[0]!), references(results[1]!));
      assert.deepEqual(results.map(result => result.idempotency).sort(), ['created', 'replayed']);
      const stored = await snapshot(database, resource.resourceId);
      for (const rows of [stored.revisions, stored.events, stored.intents, stored.outcomes]) assert.equal(rows.length, 1);
      assert.equal(stored.head!.current_revision_id, results[0]!.revision_id);
      assert.equal(stored.revisions[0]!.id, results[0]!.revision_id);
      assert.equal(stored.events[0]!.revision_id, results[0]!.revision_id);
      assert.deepEqual(stored.events[0]!.area_scope_ids, [resource.areaId, resource.rootId]);
      assert.equal(stored.intents[0]!.source_event_id, stored.events[0]!.id);
      assert.equal(stored.outcomes[0]!.source_event_id, stored.events[0]!.id);
      assert.equal(stored.outcomes[0]!.id, results[0]!.operation_id);
      assert.equal(stored.outcomes[0]!.participant_id, alice.participantId);
      assert.equal(stored.outcomes[0]!.operation_kind, operationKind);
      assert.equal(stored.outcomes[0]!.idempotency_key, input.idempotency_key);
      assert.equal(stored.revisions[0]!.publisher_id, alice.participantId);
    } finally { allowAttempts.resolve(); allowCommit.resolve(); await Promise.allSettled(requests); }
  });

  await t.test('changed input conflicts; exact historical retry precedes stale checks; new stale writes fail', async () => {
    const resource = await fixture.resource(alice.participantId), input = inputFor(resource.resourceId);
    const first = await operation.publish(alice.actor, input);
    const nextInput = inputFor(resource.resourceId, first.revision_id, 'new immutable text');
    const second = await operation.publish(alice.actor, nextInput);
    const before = await snapshot(database, resource.resourceId);
    for (const change of [{ content: { format: 'text/plain', text: 'changed' } }, { expected_revision_id: second.revision_id }, { resource_id: randomUUID() }]) {
      await assert.rejects(operation.publish(alice.actor, { ...input, ...change }), failure('idempotency_conflict'));
    }
    const replay = await operation.publish(alice.actor, { content: input.content, expected_revision_id: null, idempotency_key: input.idempotency_key, resource_id: resource.resourceId.toUpperCase() });
    assert.equal(replay.idempotency, 'replayed');
    assert.deepEqual(references(replay), references(first));
    await assert.rejects(operation.publish(alice.actor, inputFor(resource.resourceId, first.revision_id)), error => error instanceof PublicationError && error.code === 'revision_conflict' && error.current_revision_id === second.revision_id);
    assert.deepEqual(await snapshot(database, resource.resourceId), before);
    assert.equal(before.head!.current_revision_id, second.revision_id);
    assert.deepEqual(before.revisions.map(row => [row.id, row.revision_number, row.content_text]), [[first.revision_id, '1', input.content.text], [second.revision_id, '2', nextInput.content.text]]);
    assert.equal(before.events.length, 2); assert.equal(before.intents.length, 2); assert.equal(before.outcomes.length, 2);
  });

  await t.test('different new attempts competing on the same base commit one revision and expose a safe stale conflict', async () => {
    const resource = await fixture.resource(alice.participantId);
    const base = await operation.publish(alice.actor, inputFor(resource.resourceId));
    const ready = deferred<void>(), release = deferred<void>();
    let arrivals = 0;
    const publisher = new PublicationOperation(observe(database, { before: async (sql, parameters) => {
      if (sql.includes('FROM loom.resources WHERE id = $1 FOR UPDATE') && parameters[0] === resource.resourceId) {
        if (++arrivals === 2) ready.resolve();
        await release.promise;
      }
    } }));
    const inputs = [inputFor(resource.resourceId, base.revision_id, 'contender A'), inputFor(resource.resourceId, base.revision_id, 'contender B')];
    const pending = Promise.allSettled(inputs.map(input => publisher.publish(alice.actor, input)));
    try {
      await bounded(ready.promise); release.resolve();
      const attempts = await pending;
      const winner = attempts.find(result => result.status === 'fulfilled');
      const loser = attempts.find(result => result.status === 'rejected');
      assert.ok(winner?.status === 'fulfilled' && loser?.status === 'rejected');
      assert.ok(failure('revision_conflict')(loser.reason));
      assert.equal((loser.reason as PublicationError).current_revision_id, winner.value.revision_id);
      const stored = await snapshot(database, resource.resourceId);
      assert.equal(stored.head!.current_revision_id, winner.value.revision_id);
      assert.equal(stored.revisions.length, 2); assert.equal(stored.events.length, 2); assert.equal(stored.intents.length, 2); assert.equal(stored.outcomes.length, 2);
    } finally { release.resolve(); await pending; }
  });

  await t.test('participant and operation namespaces are distinct; credential replacement retains the original attempt', async () => {
    const resource = await fixture.resource(alice.participantId), other = await fixture.resource(bob.participantId);
    const input = inputFor(resource.resourceId), first = await operation.publish(alice.actor, input);
    const second = await operation.publish(bob.actor, { ...input, resource_id: other.resourceId });
    assert.notEqual(first.operation_id, second.operation_id);
    const otherKey = randomUUID();
    await database.transaction(tx => tx.query(`INSERT INTO loom.idempotency_records(id, participant_id, operation_kind, idempotency_key, semantic_version, request_digest, resource_id, revision_id, source_event_id)
      SELECT $1, participant_id, $2, $3, semantic_version, request_digest, resource_id, revision_id, source_event_id FROM loom.idempotency_records WHERE id = $4`, [randomUUID(), 'private.fixture.other_operation', otherKey, first.operation_id]));
    const differentOperation = await operation.publish(alice.actor, { ...input, idempotency_key: otherKey, expected_revision_id: first.revision_id });
    assert.equal(differentOperation.idempotency, 'created');
    const credentialId = randomUUID();
    await database.transaction(async tx => {
      await tx.query('UPDATE loom.participant_credentials SET state = $2 WHERE id = $1', [alice.credentialId, 'revoked']);
      await tx.query('INSERT INTO loom.participant_credentials VALUES ($1, $2, $3)', [credentialId, alice.participantId, 'active']);
    });
    await assert.rejects(operation.publish(alice.actor, input), failure('unavailable'));
    const replacement = actorFromVerifiedIdentity({ participantId: alice.participantId, credentialId });
    assert.deepEqual(references(await operation.publish(replacement, input)), references(first));
    await database.transaction(tx => tx.query('UPDATE loom.participant_credentials SET state = $2 WHERE id = $1', [alice.credentialId, 'active']));
  });

  await t.test('each write-stage failure rolls back revision, pointer, source event, intent, outcome and clock', async () => {
    for (const stage of ['INSERT INTO loom.revisions', 'UPDATE loom.resources', 'UPDATE loom.community_clocks', 'INSERT INTO loom.shared_activity', 'INSERT INTO loom.outbox_intents', 'INSERT INTO loom.idempotency_records']) {
      const resource = await fixture.resource(alice.participantId), input = inputFor(resource.resourceId);
      const before = await snapshot(database, resource.resourceId), beforeCoverage = await coverage(observer);
      const failing = new PublicationOperation(observe(database, { after: async sql => { if (sql.startsWith(stage)) throw new Error('private synthetic failure'); } }));
      await assert.rejects(failing.publish(alice.actor, input), error => failure('service_unavailable')(error) && !(error as Error).message.includes('private synthetic failure'));
      assert.deepEqual(await snapshot(database, resource.resourceId), before);
      assert.deepEqual(await coverage(observer), beforeCoverage);
      assert.deepEqual(await operation.reconcile(alice.actor, input.idempotency_key), { operation_state: 'not_recorded' });
      const recovered = await operation.publish(alice.actor, input);
      assert.equal(recovered.idempotency, 'created');
      const committed = await snapshot(database, resource.resourceId);
      assert.equal(committed.revisions.length, 1); assert.equal(committed.events.length, 1); assert.equal(committed.intents.length, 1); assert.equal(committed.outcomes.length, 1);
    }
  });

  await t.test('a killed response process after commit reconciles through a new connection without duplicating effects', async () => {
    const resource = await fixture.resource(alice.participantId), input = inputFor(resource.resourceId);
    const child = fork(new URL('../fixtures/publication-client.mjs', import.meta.url), [], { execArgv: [], silent: true,
      env: { ...process.env, LOOM_DATABASE_HOST: fixture.configuration.host, LOOM_POSTGRES_PORT: String(fixture.configuration.port),
        LOOM_DATABASE_NAME: fixture.configuration.database, LOOM_DATABASE_USER: fixture.configuration.user, LOOM_PG_APP_PASSWORD: fixture.configuration.password } });
    const stage = deferred<{ stage: string }>();
    child.once('message', message => stage.resolve(message as { stage: string }));
    let diagnostics = ''; child.stderr!.on('data', bytes => { diagnostics += String(bytes); });
    const exited = new Promise<void>((resolve, reject) => { child.once('exit', () => resolve()); child.once('error', reject); });
    try {
      child.send({ participantId: alice.participantId, credentialId: alice.credentialId, input });
      assert.deepEqual(await bounded(stage.promise), { stage: 'committed_before_response' });
      const stored = await snapshot(database, resource.resourceId);
      assert.equal(stored.outcomes.length, 1);
      child.kill('SIGKILL'); await bounded(exited);
      assert.equal(child.signalCode, 'SIGKILL');
      const restarted = new PostgresDatabase(fixture.configuration);
      try {
        const newOperation = new PublicationOperation(restarted);
        const expected = { operation_id: stored.outcomes[0]!.id, resource_id: resource.resourceId, revision_id: stored.revisions[0]!.id };
        assert.deepEqual(references(await newOperation.publish(alice.actor, input)), expected);
        const resolved = await newOperation.reconcile(alice.actor, input.idempotency_key);
        assert.ok('publication_state' in resolved);
        assert.deepEqual(references(resolved), expected);
      } finally { await restarted.close(); }
      assert.deepEqual(await snapshot(database, resource.resourceId), stored);
      assert.ok(!diagnostics.includes(fixture.configuration.password));
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await bounded(exited); }
  });

  await t.test('current credentials, account, editor, resource and exact revision state protect retry disclosure', async () => {
    const resource = await fixture.resource(alice.participantId, 'summary'), input = inputFor(resource.resourceId), published = await operation.publish(alice.actor, input);
    const original = await snapshot(database, resource.resourceId);
    await database.transaction(async tx => {
      await tx.query('SELECT id FROM loom.resources WHERE id = $1 FOR UPDATE', [resource.resourceId]);
      await tx.query('DELETE FROM loom.resource_editors WHERE resource_id = $1 AND participant_id = $2', [resource.resourceId, alice.participantId]);
    });
    await assert.rejects(operation.publish(alice.actor, input), failure('forbidden'));
    const readOnly = await operation.reconcile(alice.actor, input.idempotency_key);
    assert.ok('publication_state' in readOnly); assert.deepEqual(references(readOnly), references(published));
    await database.transaction(tx => tx.query('INSERT INTO loom.resource_editors VALUES ($1, $2)', [resource.resourceId, alice.participantId]));
    for (const [table, column, id, hidden, visible] of [
      ['participants', 'state', alice.participantId, 'suspended', 'active'],
      ['participant_credentials', 'state', alice.credentialId, 'revoked', 'active'],
      ['resources', 'state', resource.discussionId, 'suppressed', 'active'],
      ['resources', 'state', resource.resourceId, 'removed', 'active'],
      ['revisions', 'availability', published.revision_id, 'suppressed', 'available'],
    ] as const) {
      await database.transaction(tx => tx.query('UPDATE loom.' + table + ' SET ' + column + ' = $2 WHERE id = $1', [id, hidden]));
      for (const retry of [() => operation.publish(alice.actor, input), () => operation.reconcile(alice.actor, input.idempotency_key)]) {
        await assert.rejects(retry(), error => failure('unavailable')(error) && (error as PublicationError).current_revision_id === undefined);
      }
      await database.transaction(tx => tx.query('UPDATE loom.' + table + ' SET ' + column + ' = $2 WHERE id = $1', [id, visible]));
    }
    await assert.rejects(operation.publish(alice.actor, inputFor(randomUUID())), failure('unavailable'));
    assert.deepEqual(await snapshot(database, resource.resourceId), original);
    assert.deepEqual(references(await operation.publish(alice.actor, input)), references(published));
  });

  await t.test('denied edits disclose no protected draft or suppressed current-revision existence', async () => {
    const resource = await fixture.resource(alice.participantId), input = inputFor(resource.resourceId);
    await assert.rejects(operation.publish(bob.actor, input), failure('unavailable'));
    const published = await operation.publish(alice.actor, input);
    const edit = inputFor(resource.resourceId, published.revision_id);
    await assert.rejects(operation.publish(bob.actor, edit), failure('forbidden'));
    await database.transaction(async tx => {
      await tx.query('SELECT id FROM loom.resources WHERE id = $1 FOR UPDATE', [resource.resourceId]);
      await tx.query('UPDATE loom.revisions SET availability = $2 WHERE id = $1', [published.revision_id, 'suppressed']);
    });
    await assert.rejects(operation.publish(bob.actor, edit), error => failure('unavailable')(error) && (error as PublicationError).current_revision_id === undefined);
    await assert.rejects(operation.publish(alice.actor, input), failure('unavailable'));
    assert.equal((await snapshot(database, resource.resourceId)).outcomes.length, 1);
  });

  await t.test('FOR SHARE actor guards conflict with ordinary non-key suspension updates', async () => {
    const participant = await fixture.participant(), resource = await fixture.resource(participant.participantId);
    const held = deferred<number>(), release = deferred<void>();
    const publisher = new PublicationOperation(observe(database, { before: async (sql, _parameters, _tx, pid) => { if (isTail(sql)) { held.resolve(pid); await release.promise; } } }));
    const publication = publisher.publish(participant.actor, inputFor(resource.resourceId));
    const owner = await bounded(held.promise);
    const suspensionStarted = deferred<number>();
    const suspension = database.transaction(async tx => {
      suspensionStarted.resolve((await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid', [])).rows[0]!.pid);
      await tx.query('UPDATE loom.participants SET state = $2 WHERE id = $1', [participant.participantId, 'suspended']);
    });
    try {
      await blockedBy(observer, await bounded(suspensionStarted.promise), owner);
      release.resolve(); await publication; await suspension;
      await assert.rejects(operation.reconcile(participant.actor, (await snapshot(database, resource.resourceId)).outcomes[0]!.idempotency_key), failure('unavailable'));
      assert.equal((await snapshot(database, resource.resourceId)).revisions.length, 1);
    } finally { release.resolve(); await Promise.allSettled([publication, suspension]); }
  });

  await t.test('an editor removal committed first is rechecked after the resource guard wait', async () => {
    const resource = await fixture.resource(bob.participantId);
    const first = await operation.publish(bob.actor, inputFor(resource.resourceId));
    const input = inputFor(resource.resourceId, first.revision_id);
    const before = await snapshot(database, resource.resourceId);
    const locked = deferred<number>(), release = deferred<void>();
    const removal = database.transaction(async tx => {
      const pid = (await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid', [])).rows[0]!.pid;
      await tx.query('SELECT id FROM loom.resources WHERE id = $1 FOR UPDATE', [resource.resourceId]);
      await tx.query('DELETE FROM loom.resource_editors WHERE resource_id = $1 AND participant_id = $2', [resource.resourceId, bob.participantId]);
      locked.resolve(pid); await release.promise;
    });
    const owner = await bounded(locked.promise), publicationStarted = deferred<number>();
    const publisher = new PublicationOperation(observe(database, { before: async (sql, parameters, _tx, pid) => { if (sql.includes('FROM loom.resources WHERE id = $1 FOR UPDATE') && parameters[0] === resource.resourceId) publicationStarted.resolve(pid); } }));
    const publication = publisher.publish(bob.actor, input).catch(error => error as unknown);
    try {
      await blockedBy(observer, await bounded(publicationStarted.promise), owner);
      release.resolve(); await removal;
      assert.ok(failure('forbidden')(await publication));
      const stored = await snapshot(database, resource.resourceId);
      assert.deepEqual(stored, before);
    } finally { release.resolve(); await Promise.allSettled([publication, removal]); }
  });

  await t.test('owning-container suppression conflicts with shared guards and is rechecked after it commits first', async () => {
    const resource = await fixture.resource(bob.participantId, 'contribution');
    const locked = deferred<number>(), release = deferred<void>();
    // Private lifecycle fixture only: no production moderation operation is added.
    const suppression = database.transaction(async tx => {
      const pid = (await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid', [])).rows[0]!.pid;
      await tx.query('UPDATE loom.resources SET state = $2 WHERE id = $1', [resource.discussionId, 'suppressed']);
      locked.resolve(pid); await release.promise;
    });
    const holder = await bounded(locked.promise), requested = deferred<number>();
    const publisher = new PublicationOperation(observe(database, { before: async (sql, parameters, _tx, pid) => {
      if (sql.includes('FROM loom.resources WHERE id = $1 FOR SHARE') && parameters[0] === resource.discussionId) requested.resolve(pid);
    } }));
    const publishing = publisher.publish(bob.actor, inputFor(resource.resourceId)).catch(error => error as unknown);
    try {
      await blockedBy(observer, await bounded(requested.promise), holder);
      release.resolve(); await suppression;
      assert.ok(failure('unavailable')(await publishing));
      const stored = await snapshot(database, resource.resourceId);
      assert.equal(stored.head!.current_revision_id, null);
      for (const rows of [stored.revisions, stored.events, stored.intents, stored.outcomes]) assert.equal(rows.length, 0);
    } finally { release.resolve(); await Promise.allSettled([publishing, suppression]); }
  });

  await t.test('authored revision bytes, original author and durable records cannot be overwritten by the application role', async () => {
    const resource = await fixture.resource(alice.participantId, 'contribution'), input = inputFor(resource.resourceId);
    const first = await operation.publish(alice.actor, input), admin = await fixture.participant('administrator');
    const second = await operation.publish(admin.actor, inputFor(resource.resourceId, first.revision_id, 'attributable correction'));
    for (const sql of ['UPDATE loom.revisions SET content_text = $2 WHERE id = $1', 'DELETE FROM loom.revisions WHERE id = $1']) {
      await assert.rejects(database.transaction(tx => tx.query(sql, sql.startsWith('UPDATE') ? [first.revision_id, 'overwrite'] : [first.revision_id])), /permission denied/);
    }
    for (const table of ['shared_activity', 'outbox_intents', 'idempotency_records']) await assert.rejects(database.transaction(tx => tx.query('DELETE FROM loom.' + table, [])), /permission denied/);
    const stored = await snapshot(database, resource.resourceId);
    assert.equal(stored.head!.original_author_id, alice.participantId);
    assert.deepEqual(stored.revisions.map(row => [row.id, row.publisher_id]), [[first.revision_id, alice.participantId], [second.revision_id, admin.participantId]]);
    assert.equal(stored.revisions[0]!.content_text, input.content.text);
  });

  await t.test('an older preparation receives a later position when another publication commits first', async () => {
    const a = await fixture.resource(alice.participantId), b = await fixture.resource(bob.participantId), before = await coverage(observer);
    const ready = deferred<void>(), release = deferred<void>();
    const held = new PublicationOperation(observe(database, { before: async sql => { if (isTail(sql)) { ready.resolve(); await release.promise; } } }));
    const older = held.publish(alice.actor, inputFor(a.resourceId));
    try {
      await bounded(ready.promise);
      await operation.publish(bob.actor, inputFor(b.resourceId));
      const boundary = await coverage(observer);
      assert.equal(boundary.position, String(BigInt(before.position) + 1n));
      assert.equal((await snapshot(database, a.resourceId)).events.length, 0);
      release.resolve(); await older;
      assert.equal((await snapshot(database, a.resourceId)).events[0]!.position, String(BigInt(boundary.position) + 1n));
      assert.equal((await snapshot(database, b.resourceId)).events[0]!.position, boundary.position);
      assert.deepEqual((await coverage(observer)).events.slice(0, boundary.events.length), boundary.events);
    } finally { release.resolve(); await Promise.allSettled([older]); }
  });

  await t.test('rollback and killed connections before/after the clock and before commit cannot create coverage gaps', async () => {
    for (const scenario of ['rollback_after_clock', 'kill_before_clock', 'kill_after_clock', 'kill_before_commit'] as const) {
      const a = await fixture.resource(alice.participantId), b = await fixture.resource(bob.participantId), before = await coverage(observer);
      const held = deferred<number>(), release = deferred<void>();
      const publisher = new PublicationOperation(observe(database, {
        before: async (sql, _parameters, _tx, pid) => { if (scenario === 'kill_before_clock' && isTail(sql)) { held.resolve(pid); await release.promise; } },
        after: async (sql, _parameters, _tx, pid) => {
          if ((scenario === 'kill_before_commit' ? isOutcome(sql) : scenario !== 'kill_before_clock' && isTail(sql))) {
            held.resolve(pid); await release.promise;
            if (scenario === 'rollback_after_clock') throw new Error('controlled rollback after allocation');
          }
        },
      }));
      const doomed = publisher.publish(alice.actor, inputFor(a.resourceId)).catch(error => error as unknown);
      const owner = await bounded(held.promise), waiting = deferred<number>();
      const follower = new PublicationOperation(observe(database, { before: async (sql, _parameters, _tx, pid) => { if (isTail(sql)) waiting.resolve(pid); } }));
      const subsequent = follower.publish(bob.actor, inputFor(b.resourceId));
      try {
        if (scenario === 'kill_before_clock') await subsequent;
        else { await blockedBy(observer, await bounded(waiting.promise), owner); assert.deepEqual(await coverage(observer), before); }
        if (scenario !== 'rollback_after_clock') assert.equal((await observer.query<{ killed: boolean }>('SELECT pg_terminate_backend($1) AS killed', [owner])).rows[0]!.killed, true);
        release.resolve();
        assert.ok(failure('service_unavailable')(await doomed));
        await subsequent;
        const current = await coverage(observer);
        assert.equal(current.position, String(BigInt(before.position) + 1n));
        const aborted = await snapshot(database, a.resourceId);
        assert.equal(aborted.head!.current_revision_id, null);
        for (const rows of [aborted.revisions, aborted.events, aborted.intents, aborted.outcomes]) assert.equal(rows.length, 0);
        assert.equal((await snapshot(database, b.resourceId)).events[0]!.position, current.position);
      } finally { release.resolve(); await Promise.allSettled([doomed, subsequent]); }
    }
  });

  await t.test('synthetic distinct-resource publications measure commit-tail wait and hold, without asserting production capacity', async () => {
    const samples: { wait: number; hold: number }[] = [];
    let begin = 0, acquired = 0;
    function instrument() {
      let requested = 0, granted = 0;
      return new PublicationOperation(observe(database, {
        before: async sql => { if (isTail(sql)) requested = performance.now(); },
        after: async sql => { if (isTail(sql)) granted = performance.now(); },
        committed: () => { samples.push({ wait: granted - requested, hold: performance.now() - granted }); },
      }));
    }
    const percentile = (values: number[], fraction: number) => Number([...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1]!.toFixed(3));
    for (const [concurrency, count] of [[1, 16], [8, 32]] as const) {
      const resources = await Promise.all(Array.from({ length: count }, () => fixture.resource(alice.participantId)));
      samples.length = 0; begin = performance.now();
      for (let offset = 0; offset < count; offset += concurrency) await Promise.all(resources.slice(offset, offset + concurrency).map(resource => instrument().publish(alice.actor, inputFor(resource.resourceId, null, 'x'.repeat(128)))));
      acquired = performance.now();
      assert.equal(samples.length, count);
      console.log(JSON.stringify({ measurement: 'synthetic_commit_tail', database: 'PostgreSQL 18.4 local Docker', host: process.platform + '/' + process.arch,
        input: { concurrency, publications: count, utf8_text_bytes: 128, distinct_resources: true, work_inside_tail: 'SQL inserts plus COMMIT only' },
        elapsed_ms: Number((acquired - begin).toFixed(3)), publications_per_second: Number((count * 1000 / (acquired - begin)).toFixed(2)),
        tail_wait_ms: { p50: percentile(samples.map(row => row.wait), .5), p95: percentile(samples.map(row => row.wait), .95), max: percentile(samples.map(row => row.wait), 1) },
        tail_hold_through_commit_ms: { p50: percentile(samples.map(row => row.hold), .5), p95: percentile(samples.map(row => row.hold), .95), max: percentile(samples.map(row => row.hold), 1) },
        limitation: 'Synthetic localhost inputs; not an approved operating envelope.' }));
      for (const resource of resources) {
        const stored = await snapshot(database, resource.resourceId);
        assert.equal(stored.revisions.length, 1); assert.equal(stored.events.length, 1); assert.equal(stored.intents.length, 1); assert.equal(stored.outcomes.length, 1);
      }
    }
    await coverage(observer);
  });
});
