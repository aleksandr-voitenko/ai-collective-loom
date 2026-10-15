import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { syntheticServer } from '../helpers/participation-server.js';
import { httpClient } from '../helpers/participation-http.js';
import { SearchWorker } from '../../src/server/modules/search/worker.js';
import type { QueryResultRow } from 'pg';
import { barrier, bounded, blockedBy } from '../helpers/search-races.js';

const content = (text: string) => ({ format: 'loom-markdown-v1', text, mentions: [] });

test('search author discovery follows readable publications rather than account state', { timeout: 60000 }, async t => {
  const server = await syntheticServer(); t.after(server.close);
  const certificate = await readFile(server.directory + '/cert.pem', 'utf8'), admin = httpClient(server.origin, certificate);
  await admin.enroll(server.ticket);
  assert.equal((await admin.call('/api/v1/community/setup', { idempotency_key: randomUUID(), community_name: 'Author discovery',
    ordinary_area_name: 'General', proposal_area_name: 'Feedback', overview: content('Overview') })).status, 201);
  const area = (await admin.call('/api/v1/areas')).body.items.find((row: any) => row.title === 'General').id;
  async function author(nickname: string, publish: boolean) {
    const created = await admin.call('/api/v1/identity/accounts', { idempotency_key: randomUUID(), nickname, kind: 'agent', role: 'participant' });
    assert.equal(created.status, 200);
    const id = created.body.participant_id as string;
    const issued = await admin.call('/api/v1/identity/credentials', { idempotency_key: randomUUID(), participant_id: id,
      kind: 'agent', purpose: null, label: 'Author fixture', replace_credential_id: null });
    assert.equal(issued.status, 200);
    const client = httpClient(server.origin, certificate, issued.body.secret);
    let resource: string | undefined;
    if (publish) {
      const result = await client.call('/api/v1/artifacts', { idempotency_key: randomUUID(), area_id: area,
        title: 'Retained authorship', content: content('quasar retained authorship') });
      assert.equal(result.status, 201); resource = result.body.resource_id;
    }
    return { id, client, resource };
  }
  const retained = await author('retained_author', true), hidden = await author('hidden_author', true), unpublished = await author('unpublished_author', false);
  const beforeIndexing = await admin.call('/api/v1/search/authors');
  assert.equal(beforeIndexing.status, 200);
  assert.deepEqual(beforeIndexing.body.items.map((row: any) => row.id), [server.administratorId, retained.id, hidden.id].sort());
  assert.equal((await server.observer.query('SELECT count(*)::int AS n FROM loom.search_documents')).rows[0].n, 0);
  await new SearchWorker(server.database).tick();
  for (const person of [retained, hidden]) assert.equal((await admin.call('/api/v1/identity/state', {
    idempotency_key: randomUUID(), participant_id: person.id, state: 'suspended', role: 'participant',
  })).status, 200);
  await server.database.transaction(tx => tx.query("UPDATE loom.resources SET state='suppressed' WHERE id=$1", [hidden.resource]));
  assert.equal((await admin.call('/api/v1/participants')).body.items.some((row: any) => row.id === retained.id), false);
  const found = await admin.call('/api/v1/search?' + new URLSearchParams({ q: 'quasar', author: retained.id }));
  assert.equal(found.status, 200); assert.deepEqual(found.body.items.map((row: any) => row.source_resource_id), [retained.resource]);
  const directory = await admin.call('/api/v1/search/authors?limit=1&max_response_bytes=4096');
  assert.equal(directory.status, 200);
  assert.ok(directory.bytes <= 4096); assert.equal(directory.body.items.length, 1); assert.ok(directory.body.next_cursor);
  const authors = [...directory.body.items]; let cursor: string | null = directory.body.next_cursor;
  while (cursor) {
    const page = await admin.call('/api/v1/search/authors?' + new URLSearchParams({ limit: '1', cursor }));
    assert.equal(page.status, 200); authors.push(...page.body.items); cursor = page.body.next_cursor;
  }
  assert.deepEqual(authors.map(row => row.id), [server.administratorId, retained.id].sort());
  assert.equal(authors.some(row => row.id === hidden.id || row.id === unpublished.id), false);
  const selected = await admin.call('/api/v1/search/authors?author=' + retained.id);
  assert.equal(selected.status, 200); assert.deepEqual(selected.body.items, authors.filter(row => row.id === retained.id));
  assert.deepEqual((await admin.call('/api/v1/search/authors?author=' + hidden.id)).body.items, []);
  assert.deepEqual((await admin.call('/api/v1/search/authors?author=' + randomUUID())).body.items, []);
  assert.equal((await admin.call('/api/v1/search/authors?unknown=true')).status, 400);
  assert.equal((await admin.call('/api/v1/search/authors?limit=26')).status, 400);
  assert.equal((await unpublished.client.call('/api/v1/search/authors?cursor=' + encodeURIComponent(directory.body.next_cursor))).status, 409);
  const before = (await server.observer.query('SELECT * FROM loom.shared_activity ORDER BY id')).rows;
  await server.database.transaction(tx => tx.query("UPDATE loom.resources SET state='suppressed' WHERE id=$1", [retained.resource]));
  assert.equal((await admin.call('/api/v1/search/authors?cursor=' + encodeURIComponent(directory.body.next_cursor))).status, 409);
  assert.equal((await admin.call('/api/v1/search/authors')).body.items.some((row: any) => row.id === retained.id), false);
  assert.deepEqual((await server.observer.query('SELECT * FROM loom.shared_activity ORDER BY id')).rows, before);
  assert.equal((await server.observer.query('SELECT count(*)::int AS n FROM loom.saved_items')).rows[0].n, 0);
});

test('search pages serialize current source eligibility and credential revocation in both commit orders', { timeout: 120000 }, async t => {
  type Match = (sql: string, values: readonly unknown[]) => boolean;
  type Gate = { match: Match; phase: 'before' | 'after'; entered: ReturnType<typeof barrier<number>>; release: ReturnType<typeof barrier<void>> };
  let gate: Gate | undefined, watcher: { match: Match; entered: ReturnType<typeof barrier<number>> } | undefined;
  function pause(match: Match, phase: Gate['phase']) {
    const next: Gate = { match, phase, entered: barrier<number>(), release: barrier() }; gate = next; return next;
  }
  const server = await syntheticServer({ transactionWrapper: database => ({ transaction: work => database.transaction(tx => work({
    query: async <Row extends QueryResultRow>(sql: string, values: readonly unknown[]) => {
      if (watcher?.match(sql, values)) {
        const selected = watcher; watcher = undefined;
        selected.entered.release((await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid', [])).rows[0]!.pid);
      }
      const selected = gate?.match(sql, values) ? gate : undefined;
      if (selected) gate = undefined;
      const wait = async () => {
        selected!.entered.release((await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid', [])).rows[0]!.pid);
        await bounded(selected!.release.promise);
      };
      if (selected?.phase === 'before') await wait();
      const result = await tx.query<Row>(sql, values);
      if (selected?.phase === 'after') await wait();
      return result;
    },
  })) }) });
  t.after(server.close);
  const certificate = await readFile(server.directory + '/cert.pem', 'utf8'), admin = httpClient(server.origin, certificate);
  await admin.enroll(server.ticket);
  assert.equal((await admin.call('/api/v1/community/setup', { idempotency_key: randomUUID(), community_name: 'Authorization races',
    ordinary_area_name: 'General', proposal_area_name: 'Feedback', overview: content('Overview') })).status, 201);
  const area = (await admin.call('/api/v1/areas')).body.items.find((row: any) => row.title === 'General').id;
  const artifacts: { resource_id: string; revision_id: string }[] = [];
  for (let i = 0; i < 2; i++) {
    const result = await admin.call('/api/v1/artifacts', { idempotency_key: randomUUID(), area_id: area, title: 'Race source', content: content('quasar controlled content') });
    assert.equal(result.status, 201); artifacts.push(result.body);
  }
  const opening = await admin.call('/api/v1/discussions', { idempotency_key: randomUUID(), area_id: area, title: 'Containment source', content: content('nebula controlled opening') });
  assert.equal(opening.status, 201);
  const discussion = (await admin.call('/api/v1/resources/' + opening.body.resource_id)).body.discussion_id;
  const reply = await admin.call('/api/v1/replies', { idempotency_key: randomUUID(), discussion_id: discussion, parent_id: opening.body.resource_id, content: content('nebula controlled reply') });
  assert.equal(reply.status, 201);
  await new SearchWorker(server.database).tick();
  const sourceRows = (await server.observer.query('SELECT * FROM loom.shared_activity ORDER BY id')).rows;
  const q = (term: string, cursor?: string) => '/api/v1/search?' + new URLSearchParams({ q: term, limit: '1', ...(cursor ? { cursor } : {}) });
  async function viewer(nickname: string) {
    const account = await admin.call('/api/v1/identity/accounts', { idempotency_key: randomUUID(), nickname, kind: 'agent', role: 'participant' });
    assert.equal(account.status, 200);
    const id = account.body.participant_id as string;
    const token = await admin.call('/api/v1/identity/credentials', { idempotency_key: randomUUID(), participant_id: id, kind: 'agent', purpose: null, label: 'Race viewer', replace_credential_id: null });
    assert.equal(token.status, 200);
    return { id, credential: token.body.credential_id as string, client: httpClient(server.origin, certificate, token.body.secret) };
  }
  const reader = await viewer('race_reader');
  for (const kind of ['resource', 'revision', 'discussion'] as const) {
    const term = kind === 'discussion' ? 'nebula' : 'quasar';
    const table = kind === 'revision' ? 'revisions' : 'resources', column = kind === 'revision' ? 'availability' : 'state';
    const restore = kind === 'revision' ? 'available' : 'active';
    await t.test(kind + ' suppression commits after selection but before page construction', async () => {
      const first = await reader.client.call(q(term)); assert.equal(first.status, 200); assert.ok(first.body.next_cursor);
      const next = await reader.client.call(q(term, first.body.next_cursor)); assert.equal(next.status, 200);
      const target = next.body.items[0], id = kind === 'discussion' ? discussion : kind === 'revision' ? target.revision_id : target.source_resource_id;
      const held = pause(sql => sql.includes('SELECT e.id,e.search_kind'), 'after');
      const pending = reader.client.call(q(term, first.body.next_cursor));
      try {
        await bounded(held.entered.promise);
        await server.database.transaction(tx => tx.query(`UPDATE loom.${table} SET ${column}='suppressed' WHERE id=$1`, [id]));
      } finally { held.release.release(); }
      try {
        const denied = await pending; assert.ok([404, 409].includes(denied.status)); assert.equal(denied.body.items, undefined);
        const serialized = JSON.stringify(denied.body);
        for (const value of [target.source_resource_id, target.revision_id, target.title, target.excerpt.text].filter(Boolean)) assert.equal(serialized.includes(value), false);
        const fresh = await reader.client.call(q(term)); assert.equal(fresh.status, 200);
        assert.equal(fresh.body.items.some((row: any) => row.source_resource_id === target.source_resource_id), false);
        if (kind === 'discussion') assert.deepEqual(fresh.body.items, []);
      } finally { await server.database.transaction(tx => tx.query(`UPDATE loom.${table} SET ${column}=$2 WHERE id=$1`, [id, restore])); }
    });
    await t.test(kind + ' suppression waits for an already authorized page to commit', async () => {
      const initial = await reader.client.call(q(term)); assert.equal(initial.status, 200);
      const target = initial.body.items[0], id = kind === 'discussion' ? discussion : kind === 'revision' ? target.revision_id : target.source_resource_id;
      const held = pause((sql, values) => sql.includes('SELECT v.title,v.revision_number') && values[0] === target.source_resource_id, 'after');
      const pending = reader.client.call(q(term));
      const readerPid = await bounded(held.entered.promise), mutating = barrier<number>();
      const mutation = server.database.transaction(async tx => {
        mutating.release((await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid', [])).rows[0]!.pid);
        await tx.query(`UPDATE loom.${table} SET ${column}='suppressed' WHERE id=$1`, [id]);
      });
      try { await blockedBy(server.observer, await bounded(mutating.promise), readerPid); }
      finally { held.release.release(); }
      try {
        const allowed = await pending; assert.equal(allowed.status, 200); assert.deepEqual(allowed.body.items, initial.body.items);
        await mutation;
        assert.equal((await reader.client.call(q(term, allowed.body.next_cursor))).status, 409);
        const fresh = await reader.client.call(q(term)); assert.equal(fresh.status, 200);
        assert.equal(fresh.body.items.some((row: any) => row.source_resource_id === target.source_resource_id), false);
      } finally { await mutation; await server.database.transaction(tx => tx.query(`UPDATE loom.${table} SET ${column}=$2 WHERE id=$1`, [id, restore])); }
    });
  }
  await t.test('credential revocation wins between authentication and continuation authorization', async () => {
    const person = await viewer('revoke_first');
    const first = await person.client.call(q('quasar')); assert.equal(first.status, 200);
    const held = pause(sql => sql === "SET LOCAL statement_timeout='2500ms'", 'after');
    const pending = person.client.call(q('quasar', first.body.next_cursor));
    try {
      await bounded(held.entered.promise);
      assert.equal((await admin.call('/api/v1/identity/revoke', { idempotency_key: randomUUID(), participant_id: person.id, credential_id: person.credential })).status, 200);
    } finally { held.release.release(); }
    const denied = await pending; assert.ok([401, 404].includes(denied.status)); assert.equal(denied.body.items, undefined);
    assert.equal(JSON.stringify(denied.body).includes('quasar'), false);
    assert.equal((await person.client.call(q('quasar', first.body.next_cursor))).status, 401);
    assert.equal((await person.client.call('/api/v1/search/authors')).status, 401);
  });
  await t.test('credential revocation waits for an authorized page and then rejects its continuation', async () => {
    const person = await viewer('read_first');
    const initial = await person.client.call(q('quasar')); assert.equal(initial.status, 200);
    const held = pause(sql => sql.includes('SELECT e.id,e.search_kind'), 'after');
    const pending = person.client.call(q('quasar'));
    const readerPid = await bounded(held.entered.promise), mutation = barrier<number>();
    watcher = { match: (sql, values) => sql === 'SELECT id FROM loom.participants WHERE id = $1 FOR UPDATE' && values[0] === person.id, entered: mutation };
    const revocation = admin.call('/api/v1/identity/revoke', { idempotency_key: randomUUID(), participant_id: person.id, credential_id: person.credential });
    try { await blockedBy(server.observer, await bounded(mutation.promise), readerPid); }
    finally { held.release.release(); }
    const allowed = await pending; assert.equal(allowed.status, 200); assert.deepEqual(allowed.body.items, initial.body.items);
    assert.equal((await revocation).status, 200);
    assert.equal((await person.client.call(q('quasar', allowed.body.next_cursor))).status, 401);
    assert.equal((await person.client.call('/api/v1/search/status')).status, 401);
  });
  assert.deepEqual((await server.observer.query('SELECT * FROM loom.shared_activity ORDER BY id')).rows, sourceRows);
  assert.equal((await server.observer.query('SELECT count(*)::int AS n FROM loom.saved_items')).rows[0].n, 0);
});
