import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { fixture, plain, authored, reference, incoming } from '../helpers/references.js';
import type { DiscussionBacklinkPageView } from '../../src/contracts/references.js';
import { barrier, bounded, blockedBy } from '../helpers/search-races.js';
import { prepareText } from '../helpers/file-text.js';

test(
  'retained obsolete memberships do not consume current-source continuation pages',
  { timeout: 90000 },
  async (t) => {
    const f = await fixture(t),
      target = await discussion(f),
      text = `[target](/loom/discussion/${target.discussion_id})`;
    let source = await discussion(f, 'Retained history source', text);
    for (let i = 0; i < 64; i++) source = { ...source, ...(await revise(f, source, text)) };
    const other = await discussion(f, 'Second current source', text);
    const before = (
      await f.observer.query(
        'SELECT * FROM loom.revision_discussion_links WHERE discussion_id=$1 ORDER BY revision_id,destination',
        [target.discussion_id],
      )
    ).rows;
    let cursor: string | null = null,
      pages = 0,
      emptyPages = 0;
    const seen: string[] = [];
    do {
      const result = await page(f, target.discussion_id, {
        limit: '25',
        ...(cursor ? { cursor } : {}),
      });
      pages++;
      if (!result.items.length) emptyPages++;
      seen.push(...result.items.map((item) => item.source.resource_id));
      cursor = result.next_cursor;
    } while (cursor);
    t.diagnostic(
      JSON.stringify({
        retained_memberships: before.length,
        current_sources: seen.length,
        pages,
        empty_pages: emptyPages,
      }),
    );
    assert.deepEqual(seen.sort(), [source.resource_id, other.resource_id].sort());
    assert.deepEqual(
      (
        await f.observer.query(
          'SELECT * FROM loom.revision_discussion_links WHERE discussion_id=$1 ORDER BY revision_id,destination',
          [target.discussion_id],
        )
      ).rows,
      before,
    );
    assert.equal(before.length, 66);
    assert.equal(pages, 1);
    assert.equal(emptyPages, 0);
  },
);

test(
  'oversized inferred URLs cannot prevent ordinary prose publication',
  { timeout: 90000 },
  async (t) => {
    const f = await fixture(t),
      target = await discussion(f);
    const text = `[padded query](/loom/discussion/${target.discussion_id}?${'&'.repeat(1200)})`;
    const source = await discussion(f, 'Long URL prose', text);
    assert.equal(
      (await f.admin.call('/api/v1/resources/' + source.resource_id)).body.content.text,
      text,
    );
    assert.deepEqual((await page(f, target.discussion_id)).items, []);
  },
);

test(
  '100 escaped attachment paths cannot make an inferred source impossible to retrieve',
  { timeout: 90000 },
  async (t) => {
    const f = await fixture(t, { files: true }),
      target = await discussion(f),
      destinations: string[] = [];
    for (let batch = 0; destinations.length < 100; batch++) {
      const prepared = await prepareText(
        f.admin,
        { kind: 'reply', resource_id: target.resource_id },
        'bytes.txt',
        Buffer.from('Retained exact bytes'),
      );
      const files = Array.from({ length: 12 }, (_, index) => ({
        ...prepared,
        path: `f${String(index).padStart(3, '0')}` + '"'.repeat(508),
      }));
      const published = await f.admin.call('/api/v1/replies', {
        idempotency_key: randomUUID(),
        discussion_id: target.discussion_id,
        parent_id: target.resource_id,
        content: plain('Attachment batch ' + batch),
        attachment_set: { version: 'contribution-attachments-v1', files },
      });
      assert.equal(published.status, 201, JSON.stringify(published.body));
      const resource = (await f.admin.call('/api/v1/resources/' + published.body.resource_id)).body;
      const manifest = await f.admin.call(resource.attachment_set.manifest_url);
      assert.equal(manifest.status, 200);
      assert.equal(manifest.body.items.length, 12);
      for (const file of manifest.body.items)
        if (destinations.length < 100)
          destinations.push(
            `/loom/file/contribution/${published.body.resource_id}/${published.body.revision_id}/${file.file_id}`,
          );
    }
    const source = await discussion(
      f,
      'Escaped path source',
      destinations.map((url) => `[x](${url})`).join(' '),
    );
    const result = await page(f, target.discussion_id, { max_response_bytes: '131072' });
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0]!.source.resource_id, source.resource_id);
    assert.equal(result.items[0]!.destinations.length, 100);
    assert.ok(
      result.items[0]!.destinations.every((destination) => !('path' in destination.target)),
    );
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 131072);
    t.diagnostic(
      JSON.stringify({
        destinations: 100,
        response_utf8_bytes: Buffer.byteLength(JSON.stringify(result)),
      }),
    );
    assert.equal(
      (
        await f.observer.query(
          'SELECT count(*)::int n FROM loom.revision_discussion_links WHERE revision_id=$1 AND octet_length(target_path)=512',
          [source.revision_id],
        )
      ).rows[0].n,
      100,
    );
  },
);

test(
  'exact attachment and summary destinations retain their identities independently of the owning discussion',
  { timeout: 90000 },
  async (t) => {
    const f = await fixture(t, { files: true });
    const member = await prepareText(
      f.admin,
      { kind: 'opening', resource_id: f.area },
      'linked.txt',
      Buffer.from('Exact attachment'),
    );
    const opening = await f.admin.call('/api/v1/discussions', {
      idempotency_key: randomUUID(),
      area_id: f.area,
      title: 'Attachment destination',
      content: plain('Opening with attachment'),
      attachment_set: { version: 'contribution-attachments-v1', files: [member] },
    });
    assert.equal(opening.status, 201, JSON.stringify(opening.body));
    const target = (await f.admin.call('/api/v1/resources/' + opening.body.resource_id)).body;
    const file = (await f.admin.call(target.attachment_set.manifest_url)).body.items[0];
    const preparation = await f.admin.call('/api/v1/summary-preparations', {
      idempotency_key: randomUUID(),
      discussion_id: target.discussion_id,
      scope: 'full',
    });
    assert.equal(preparation.status, 200);
    const summary = await f.admin.call('/api/v1/summaries', {
      idempotency_key: randomUUID(),
      discussion_id: target.discussion_id,
      title: 'Exact summary',
      content: plain('Summary text'),
      coverage: { preparation_id: preparation.body.preparation_id },
    });
    assert.equal(summary.status, 201, JSON.stringify(summary.body));
    const destination = `/loom/file/contribution/${target.resource_id}/${target.revision_id}/${file.file_id}`;
    const source = await discussion(
      f,
      'Exact attachment source',
      `[attachment](${destination}) [summary](/loom/resource/${summary.body.resource_id}/${summary.body.revision_id})`,
    );
    const p = await page(f, target.discussion_id);
    assert.equal(p.items.length, 1);
    assert.equal(p.items[0]!.source.resource_id, source.resource_id);
    assert.deepEqual(p.items[0]!.destinations.find((x) => x.browser_url === destination)!.target, {
      kind: 'contribution',
      resource_id: target.resource_id,
      revision_id: target.revision_id,
      file_id: file.file_id,
    });
    assert.equal(
      (
        await f.observer.query(
          'SELECT target_path FROM loom.revision_discussion_links WHERE revision_id=$1 AND target_file_id=$2',
          [source.revision_id, file.file_id],
        )
      ).rows[0].target_path,
      file.path,
    );
    assert.ok(
      p.items[0]!.destinations.some(
        (x) => x.target.kind === 'summary' && x.target.revision_id === summary.body.revision_id,
      ),
    );
    assert.deepEqual(
      (
        await f.admin.call(
          incoming({
            kind: 'contribution',
            resource_id: target.resource_id,
            revision_id: target.revision_id,
            file_id: file.file_id,
            path: file.path,
          }),
        )
      ).body.items,
      [],
    );
    await state(f, summary.body.resource_id, 'suppressed');
    assert.equal((await page(f, target.discussion_id)).items[0]!.destinations.length, 1);
  },
);

type Fixture = Awaited<ReturnType<typeof fixture>>;
const mentioned = (id: string, options: Record<string, string> = {}) =>
  `/api/v1/discussions/${id}/mentioned-in?` + new URLSearchParams(options);
async function discussion(
  f: Fixture,
  title = 'Target discussion',
  text = 'Opening',
  client = f.admin,
) {
  const result = await client.call('/api/v1/discussions', {
    idempotency_key: randomUUID(),
    area_id: f.area,
    title,
    content: plain(text),
  });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  const body = (await client.call('/api/v1/resources/' + result.body.resource_id)).body;
  return { ...result.body, discussion_id: body.discussion_id } as {
    resource_id: string;
    revision_id: string;
    discussion_id: string;
  };
}
async function reply(
  f: Fixture,
  parent: { discussion_id: string; resource_id: string },
  text: string,
  client = f.admin,
) {
  const result = await client.call('/api/v1/replies', {
    idempotency_key: randomUUID(),
    discussion_id: parent.discussion_id,
    parent_id: parent.resource_id,
    content: plain(text),
  });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return { ...result.body, discussion_id: parent.discussion_id } as typeof parent & {
    revision_id: string;
  };
}
async function revise(
  f: Fixture,
  source: { resource_id: string; revision_id: string },
  text: string,
  client = f.admin,
) {
  const input = {
    idempotency_key: randomUUID(),
    resource_id: source.resource_id,
    expected_revision_id: source.revision_id,
    title: (await client.call('/api/v1/resources/' + source.resource_id)).body.title,
    content: plain(text),
  };
  const result = await client.call('/api/v1/revisions', input);
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return { input, ...result.body } as typeof source & { input: typeof input };
}
async function page(f: Fixture, target: string, options: Record<string, string> = {}) {
  const result = await f.admin.call(mentioned(target, options));
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body as DiscussionBacklinkPageView;
}
async function state(f: Fixture, id: string, value: string) {
  await f.database.transaction((tx) =>
    tx.query('UPDATE loom.resources SET state=$2 WHERE id=$1', [id, value]),
  );
}

test(
  'published opening/comment API links aggregate by source while exact targets and authored semantic references remain separate',
  { timeout: 90000 },
  async (t) => {
    const f = await fixture(t),
      target = await discussion(f),
      targetReply = await reply(f, target, 'Target comment'),
      person = await f.participant('backlink_agent');
    const text = `[discussion](/loom/discussion/${target.discussion_id}) [again](${f.origin}/loom/discussion/${target.discussion_id}) [comment](/loom/discussion/${target.discussion_id}?focus=${targetReply.resource_id}) [exact](/loom/resource/${targetReply.resource_id}/${targetReply.revision_id})`;
    const source = await discussion(f, 'Referring work', text, person.client),
      comment = await reply(f, source, text, person.client);
    const p = await page(f, target.discussion_id);
    assert.deepEqual(
      p.items.map((x) => x.source.resource_id).sort(),
      [source.resource_id, comment.resource_id].sort(),
    );
    for (const item of p.items) {
      assert.equal(item.source.author.id, person.id);
      assert.equal(item.source.publisher.id, person.id);
      assert.equal(item.discussion_title, 'Referring work');
      assert.ok(item.source.created_at);
      assert.equal(
        item.source_browser_url,
        `/loom/resource/${item.source.resource_id}/${item.source.revision_id}`,
      );
      assert.equal(item.destinations.length, 3);
      assert.ok(
        item.destinations.some(
          (x) =>
            x.target.revision_id === targetReply.revision_id &&
            x.target.resource_id === targetReply.resource_id,
        ),
      );
      assert.ok(
        item.destinations.some((x) => x.browser_url.endsWith('?focus=' + targetReply.resource_id)),
      );
    }
    assert.deepEqual(
      (await f.admin.call(incoming({ kind: 'discussion', resource_id: target.discussion_id }))).body
        .items,
      [],
    );
    const authoredSource = await f.admin.call('/api/v1/replies', {
      idempotency_key: randomUUID(),
      discussion_id: source.discussion_id,
      parent_id: source.resource_id,
      content: authored(text, [
        reference(
          {
            kind: 'contribution',
            resource_id: targetReply.resource_id,
            revision_id: targetReply.revision_id,
          },
          'builds_on',
          'Authored reason',
        ),
      ]),
    });
    assert.equal(authoredSource.status, 201);
    assert.equal((await page(f, target.discussion_id)).items.length, 3);
    assert.deepEqual(
      (await f.admin.call(incoming({ kind: 'discussion', resource_id: target.discussion_id }))).body
        .items,
      [],
    );
    const exact = (
      await f.admin.call(
        incoming({
          kind: 'contribution',
          resource_id: targetReply.resource_id,
          revision_id: targetReply.revision_id,
        }),
      )
    ).body.items;
    assert.equal(exact.length, 1);
    assert.equal(exact[0].declaration.relationship, 'builds_on');
    // Neither reads nor inferred links produce target events or owner-private state.
    assert.equal(
      (
        await f.observer.query(
          'SELECT count(*)::int n FROM loom.shared_activity WHERE resource_id=ANY($1::uuid[])',
          [[target.resource_id, targetReply.resource_id, target.discussion_id]],
        )
      ).rows[0].n,
      2,
    );
    for (const table of [
      'saved_items',
      'reading_states',
      'following_targets',
      'notification_signals',
    ]) {
      assert.equal(
        (await f.observer.query(`SELECT count(*)::int n FROM loom.${table}`)).rows[0].n,
        0,
        table,
      );
    }
  },
);

test(
  'current revision removal/re-addition, old retries, invalid targets, self-links and same-discussion peers',
  { timeout: 90000 },
  async (t) => {
    const f = await fixture(t),
      target = await discussion(f),
      link = `[target](/loom/discussion/${target.discussion_id})`,
      source = await discussion(f, 'Revision source', link);
    const removed = await revise(f, source, 'Link removed');
    assert.deepEqual((await page(f, target.discussion_id)).items, []);
    const restored = await revise(f, removed, link);
    assert.equal(
      (await page(f, target.discussion_id)).items[0]!.source.revision_id,
      restored.revision_id,
    );
    assert.equal(
      (await f.admin.call('/api/v1/revisions', removed.input)).body.revision_id,
      removed.revision_id,
    );
    assert.equal(
      (await page(f, target.discussion_id)).items[0]!.source.revision_id,
      restored.revision_id,
    );
    assert.equal(
      (
        await f.observer.query(
          'SELECT count(*)::int n FROM loom.revision_discussion_links WHERE source_id=$1',
          [source.resource_id],
        )
      ).rows[0].n,
      2,
    );
    const peer = await reply(f, source, 'Peer');
    await revise(
      f,
      restored,
      `[self](/loom/resource/${source.resource_id}) [own container](/loom/discussion/${source.discussion_id}) [peer](/loom/resource/${peer.resource_id}/${peer.revision_id})`,
    );
    const own = await page(f, source.discussion_id);
    assert.equal(own.items.length, 1);
    assert.equal(own.items[0]!.destinations.length, 1);
    assert.equal(own.items[0]!.destinations[0]!.target.resource_id, peer.resource_id);
    await state(f, target.discussion_id, 'suppressed');
    const safe = await reply(
      f,
      peer,
      `[hidden](/loom/discussion/${target.discussion_id}) [missing](/loom/discussion/${randomUUID()}) [wrong revision](/loom/resource/${peer.resource_id}/${target.revision_id}) [wrong focus](/loom/discussion/${source.discussion_id}?focus=${target.resource_id})`,
    );
    assert.equal((await f.admin.call(mentioned(target.discussion_id))).status, 404);
    await state(f, target.discussion_id, 'active');
    assert.deepEqual(
      (await page(f, target.discussion_id)).items.map((x) => x.source.resource_id),
      [safe.resource_id],
    );
    assert.equal(
      (
        await f.observer.query(
          'SELECT count(*)::int n FROM loom.revision_discussion_links WHERE revision_id=$1',
          [safe.revision_id],
        )
      ).rows[0].n,
      1,
    );
  },
);

test(
  'source/target revisions, suppression, topic moves and independently visible nested replies are reauthorized on every page',
  { timeout: 90000 },
  async (t) => {
    const f = await fixture(t),
      target = await discussion(f),
      targetReply = await reply(f, target, 'Target reply'),
      link = `[target](/loom/resource/${targetReply.resource_id}/${targetReply.revision_id})`;
    const source = await discussion(f, 'Source title', link),
      parent = await reply(f, source, link),
      nested = await reply(f, parent, link);
    await state(f, parent.resource_id, 'suppressed');
    assert.deepEqual(
      (await page(f, target.discussion_id)).items.map((x) => x.source.resource_id).sort(),
      [source.resource_id, nested.resource_id].sort(),
    );
    await f.database.transaction((tx) =>
      tx.query("UPDATE loom.revisions SET availability='suppressed' WHERE id=$1", [
        source.revision_id,
      ]),
    );
    const eligible = (await page(f, target.discussion_id)).items;
    assert.deepEqual(
      eligible.map((x) => x.source.resource_id),
      [nested.resource_id],
    );
    assert.equal(eligible[0]!.discussion_title, null);
    await state(f, targetReply.resource_id, 'suppressed');
    assert.deepEqual((await page(f, target.discussion_id)).items, []);
    await state(f, targetReply.resource_id, 'active');
    await state(f, targetReply.resource_id, 'removed');
    assert.deepEqual((await page(f, target.discussion_id)).items, []);
    await state(f, targetReply.resource_id, 'active');
    await state(f, source.discussion_id, 'suppressed');
    assert.deepEqual((await page(f, target.discussion_id)).items, []);
    await state(f, source.discussion_id, 'active');
    await f.database.transaction((tx) =>
      tx.query("UPDATE loom.revisions SET availability='available' WHERE id=$1", [
        source.revision_id,
      ]),
    );
    await f.move(source.discussion_id, f.other, 'discussion.move');
    await f.database.transaction((tx) =>
      tx.query("UPDATE loom.revisions SET availability='suppressed' WHERE id=$1", [
        source.revision_id,
      ]),
    );
    await state(f, f.other, 'suppressed');
    assert.deepEqual((await page(f, target.discussion_id)).items, []);
    await state(f, f.other, 'active');
    assert.equal((await page(f, target.discussion_id)).items.length, 1);
    await state(f, f.area, 'suppressed');
    assert.equal((await f.admin.call(mentioned(target.discussion_id))).status, 404);
  },
);

test(
  'rollback and acknowledgement loss commit membership with the source once; stale retries cannot resurrect links',
  { timeout: 90000 },
  async (t) => {
    let fault = '',
      lose = false;
    const f = await fixture(t, {
      transactionWrapper: (database) => ({
        transaction: async (work) => {
          let publication = false;
          const result = await database.transaction((tx) =>
            work({
              query: async <Row extends QueryResultRow>(
                sql: string,
                values: readonly unknown[],
              ) => {
                const result = await tx.query<Row>(sql, values);
                if (sql.startsWith('INSERT INTO loom.idempotency_records')) publication = true;
                if (fault && sql.startsWith(fault)) throw new Error('Backlink rollback fixture');
                return result;
              },
            }),
          );
          if (lose && publication) {
            lose = false;
            throw new Error('Backlink acknowledgement loss fixture');
          }
          return result;
        },
      }),
    });
    const target = await discussion(f),
      source = await discussion(f, 'Retry source');
    const input = {
      idempotency_key: randomUUID(),
      resource_id: source.resource_id,
      expected_revision_id: source.revision_id,
      title: 'Retry source',
      content: plain(`[target](/loom/discussion/${target.discussion_id})`),
    };
    for (const point of [
      'INSERT INTO loom.revision_discussion_links',
      'UPDATE loom.resources SET current_revision_id',
      'INSERT INTO loom.shared_activity',
      'INSERT INTO loom.idempotency_records',
    ]) {
      fault = point;
      assert.equal((await f.admin.call('/api/v1/revisions', input)).status, 503);
      assert.deepEqual((await page(f, target.discussion_id)).items, []);
      assert.equal(
        (await f.observer.query('SELECT count(*)::int n FROM loom.revision_discussion_links'))
          .rows[0].n,
        0,
      );
    }
    fault = '';
    lose = true;
    assert.equal((await f.admin.call('/api/v1/revisions', input)).status, 503);
    const committed = (await page(f, target.discussion_id)).items[0]!.source;
    const results = await Promise.all([
      f.admin.call('/api/v1/revisions', input),
      f.admin.call('/api/v1/revisions', input),
    ]);
    for (const result of results) {
      assert.equal(result.status, 201);
      assert.equal(result.body.revision_id, committed.revision_id);
    }
    await revise(f, committed, 'Removed after uncertain commit');
    assert.equal((await f.admin.call('/api/v1/revisions', input)).status, 201);
    assert.deepEqual((await page(f, target.discussion_id)).items, []);
    assert.equal(
      (await f.observer.query('SELECT count(*)::int n FROM loom.revision_discussion_links')).rows[0]
        .n,
      1,
    );
  },
);

test(
  'bounded hidden-source pages, complete eligible sets, byte budgets and cursor invalidation',
  { timeout: 90000 },
  async (t) => {
    const f = await fixture(t),
      target = await discussion(f),
      sources = [];
    for (let i = 0; i < 29; i++)
      sources.push(
        await discussion(
          f,
          'Paged source ' + i,
          `[target](/loom/discussion/${target.discussion_id})`,
        ),
      );
    const sorted = [...sources].sort((a, b) => a.revision_id.localeCompare(b.revision_id));
    for (const source of sorted.slice(0, 25)) await state(f, source.discussion_id, 'suppressed');
    const empty = await page(f, target.discussion_id, { max_response_bytes: '4096' });
    assert.deepEqual(empty.items, []);
    assert.equal(empty.complete, false);
    assert.equal(empty.work_budget_reached, true);
    assert.ok(empty.next_cursor);
    assert.ok(Buffer.byteLength(JSON.stringify(empty)) <= 4096);
    for (const hidden of sorted.slice(0, 25))
      assert.ok(!JSON.stringify(empty).includes(hidden.resource_id));
    const next = await page(f, target.discussion_id, { cursor: empty.next_cursor!, limit: '25' });
    assert.deepEqual(
      next.items.map((x) => x.source.resource_id),
      sorted.slice(25).map((x) => x.resource_id),
    );
    assert.equal(next.complete, true);
    const originalNow = Date.now;
    const clock = t.mock.method(Date, 'now', () => originalNow() + 301000);
    try {
      assert.equal(
        (await f.admin.call(mentioned(target.discussion_id, { cursor: empty.next_cursor! })))
          .status,
        409,
      );
    } finally {
      clock.mock.restore();
    }
    const person = await f.participant('backlink_cursor');
    assert.equal(
      (await person.client.call(mentioned(target.discussion_id, { cursor: empty.next_cursor! })))
        .status,
      409,
    );
    assert.equal(
      (await f.admin.call(mentioned(sources[0]!.discussion_id, { cursor: empty.next_cursor! })))
        .status,
      409,
    );
    await state(f, sorted[0]!.discussion_id, 'active');
    assert.equal(
      (await f.admin.call(mentioned(target.discussion_id, { cursor: empty.next_cursor! }))).status,
      409,
    );
    let cursor: string | null = null;
    const seen: string[] = [];
    do {
      const p = await page(f, target.discussion_id, {
        limit: '1',
        max_response_bytes: '4096',
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...p.items.map((x) => x.source.resource_id));
      cursor = p.next_cursor;
    } while (cursor);
    assert.deepEqual(
      seen.sort(),
      [sorted[0]!, ...sorted.slice(25)].map((x) => x.resource_id).sort(),
    );
    const fresh = await page(f, target.discussion_id, { limit: '1' });
    assert.ok(fresh.next_cursor);
    await f.restart();
    assert.equal(
      (await f.admin.call(mentioned(target.discussion_id, { cursor: fresh.next_cursor! }))).status,
      409,
    );
  },
);

test(
  'a full destination set stays bounded and an oversized first entry refuses without skipping its source',
  { timeout: 90000 },
  async (t) => {
    const f = await fixture(t),
      target = await discussion(f);
    const targets = [];
    for (let i = 0; i < 100; i++) targets.push(await reply(f, target, 'Destination ' + i));
    const source = await discussion(
      f,
      'Large link set',
      targets.map((x) => `[item](/loom/resource/${x.resource_id}/${x.revision_id})`).join(' '),
    );
    const small = await f.admin.call(
      mentioned(target.discussion_id, { max_response_bytes: '4096' }),
    );
    assert.equal(small.status, 400);
    assert.equal(small.body.error.code, 'response_budget_too_small');
    assert.ok(small.body.error.minimum_response_bytes > 4096);
    const full = await page(f, target.discussion_id, { max_response_bytes: '131072' });
    assert.equal(full.items.length, 1);
    assert.equal(full.items[0]!.source.resource_id, source.resource_id);
    assert.equal(full.items[0]!.destinations.length, 100);
    assert.ok(Buffer.byteLength(JSON.stringify(full)) <= 131072);
  },
);

test(
  'prospective additive upgrade preserves every old table, digest and retained retry without backfill',
  { timeout: 90000 },
  async (t) => {
    const f = await fixture(t, { throughMigration: 29 }),
      target = await discussion(f),
      source = await discussion(
        f,
        'Historical source',
        `[target](/loom/discussion/${target.discussion_id})`,
      );
    const legacyInput = {
      idempotency_key: randomUUID(),
      area_id: f.area,
      title: 'Legacy local mention',
      content: {
        ...plain(`[label [[mention:m]]](/loom/discussion/${target.discussion_id})`),
        mentions: [
          {
            token: 'm',
            participant_id: (await f.admin.call('/api/v1/identity/self')).body.participant_id,
          },
        ],
      },
    };
    const legacy = await f.admin.call('/api/v1/discussions', legacyInput);
    assert.equal(legacy.status, 201, JSON.stringify(legacy.body));
    const tables = (
      await f.observer.query(
        "SELECT tablename FROM pg_tables WHERE schemaname='loom' ORDER BY tablename",
      )
    ).rows.map((row) => row.tablename as string);
    const snapshot = async () => {
      const result: Record<string, unknown> = {};
      for (const table of tables)
        result[table] = (
          await f.observer.query(
            `SELECT row_to_json(t) AS row FROM loom.${table} t ORDER BY row_to_json(t)::text`,
          )
        ).rows;
      return result;
    };
    const before = await snapshot();
    await f.migrate();
    await f.migrate();
    assert.deepEqual(await snapshot(), before);
    assert.deepEqual((await page(f, target.discussion_id)).items, []);
    const replay = await f.admin.call('/api/v1/discussions', legacyInput);
    assert.deepEqual(replay.body, { ...legacy.body, idempotency: 'replayed' });
    const newer = await revise(f, source, `[target](/loom/discussion/${target.discussion_id})`);
    assert.equal(
      (await page(f, target.discussion_id)).items[0]!.source.revision_id,
      newer.revision_id,
    );
  },
);

test(
  'source and target suppression races return one guarded snapshot or explicit restart in both orders',
  { timeout: 120000 },
  async (t) => {
    let gate:
      | {
          id: string;
          before: boolean;
          claimed: boolean;
          entered: ReturnType<typeof barrier<number>>;
          release: ReturnType<typeof barrier<void>>;
        }
      | undefined;
    const f = await fixture(t, {
      transactionWrapper: (database) => ({
        transaction: (work) =>
          database.transaction((tx) =>
            work({
              query: async <Row extends QueryResultRow>(
                sql: string,
                values: readonly unknown[],
              ) => {
                const g = gate;
                const matches =
                  g &&
                  !g.claimed &&
                  sql === 'SELECT id FROM loom.resources WHERE id=$1 FOR SHARE' &&
                  values[0] === g.id;
                if (matches) {
                  g.claimed = true;
                  const pid = (
                    await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid', [])
                  ).rows[0]!.pid;
                  if (g.before) {
                    g.entered.release(pid);
                    await bounded(g.release.promise);
                  }
                  const result = await tx.query<Row>(sql, values);
                  if (!g.before) {
                    g.entered.release(pid);
                    await bounded(g.release.promise);
                  }
                  return result;
                }
                return tx.query<Row>(sql, values);
              },
            }),
          ),
      }),
    });
    const target = await discussion(f),
      source = await discussion(
        f,
        'Race source',
        `[target](/loom/discussion/${target.discussion_id})`,
      );
    for (const id of [source.resource_id, target.discussion_id])
      for (const before of [true, false]) {
        const g = { id, before, claimed: false, entered: barrier<number>(), release: barrier() };
        gate = g;
        const read = f.admin.call(mentioned(target.discussion_id));
        const reader = await bounded(g.entered.promise);
        try {
          if (before) {
            await state(f, id, 'suppressed');
            g.release.release();
            assert.equal((await read).status, 409);
          } else {
            const writerReady = barrier<number>();
            const write = f.database.transaction(async (tx) => {
              writerReady.release(
                (await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid', [])).rows[0]!
                  .pid,
              );
              await tx.query("UPDATE loom.resources SET state='suppressed' WHERE id=$1", [id]);
            });
            await blockedBy(f.observer, await bounded(writerReady.promise), reader);
            g.release.release();
            const result = await read;
            assert.equal(result.status, 200);
            assert.equal(result.body.items.length, 1);
            await write;
          }
        } finally {
          g.release.release();
          gate = undefined;
        }
        if (id === source.resource_id)
          assert.deepEqual((await page(f, target.discussion_id)).items, []);
        else assert.equal((await f.admin.call(mentioned(target.discussion_id))).status, 404);
        await state(f, id, 'active');
      }
  },
);

test(
  'opposite v1 cross-linking revisions avoid source SHARE-to-UPDATE upgrades',
  { timeout: 90000 },
  async (t) => {
    const entered = barrier(),
      release = barrier();
    let active = false,
      count = 0;
    const f = await fixture(t, {
      transactionWrapper: (database) => ({
        transaction: (work) =>
          database.transaction((tx) =>
            work({
              query: async <Row extends QueryResultRow>(
                sql: string,
                values: readonly unknown[],
              ) => {
                if (
                  active &&
                  sql === 'SELECT opening_id FROM loom.discussions WHERE id=ANY($1::uuid[])'
                ) {
                  if (++count === 2) entered.release();
                  await bounded(release.promise);
                }
                return tx.query<Row>(sql, values);
              },
            }),
          ),
      }),
    });
    const alice = await f.participant('link_alice'),
      bob = await f.participant('link_bob');
    const a = await discussion(f, 'Cross A', 'Opening', alice.client),
      b = await discussion(f, 'Cross B', 'Opening', bob.client);
    active = true;
    const pending = Promise.all([
      revise(f, a, `[B](/loom/resource/${b.resource_id})`, alice.client),
      revise(f, b, `[A](/loom/resource/${a.resource_id})`, bob.client),
    ]);
    try {
      await bounded(entered.promise);
    } finally {
      release.release();
    }
    const [ar, br] = await pending;
    active = false;
    assert.equal((await page(f, b.discussion_id)).items[0]!.source.revision_id, ar.revision_id);
    assert.equal((await page(f, a.discussion_id)).items[0]!.source.revision_id, br.revision_id);
  },
);
