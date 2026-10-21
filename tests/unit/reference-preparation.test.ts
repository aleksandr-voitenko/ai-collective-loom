import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { QueryResultRow } from 'pg';
import type { ReferenceValue } from '../../src/contracts/participation.js';
import type { SqlTransaction } from '../../src/server/db/postgres.js';
import { PublicationError } from '../../src/server/modules/publication/errors.js';
import { prepareReferences, revisionReferences, type ReferenceRow } from '../../src/server/modules/participation/reference-context.js';

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const area = id(1), source = id(2), base = id(3);
const references: ReferenceValue[] = Array.from({ length: 16 }, (_, index) => ({
  reference_id: id(100 + index),
  target: { kind: 'artifact', resource_id: id(200 + index), ...(index % 2 ? { revision_id: id(400 + index) } : {}) },
  relationship: ([null, 'related_to', 'builds_on', 'contradicts'] as const)[index % 4]!,
  rationale: index % 2 ? `Exact rationale ${index} é` : null,
}));
const rows: ReferenceRow[] = references.map((ref, index) => ({
  source_field: 'main', source_id: source, revision_id: base, reference_id: ref.reference_id,
  target_kind: ref.target.kind, target_id: ref.target.resource_id,
  target_revision_id: ref.target.revision_id ?? null, relationship: ref.relationship, rationale: ref.rationale,
  origin_revision_id: id(600 + index), assertion_revision_id: id(700 + index),
}));
const expectedCarry = references.map((ref, index) => ({
  ...ref, origin_revision_id: id(600 + index), assertion_revision_id: id(700 + index),
}));
const unavailable = (error: unknown) => error instanceof PublicationError && error.code === 'unavailable';

function fixture(options: {
  fields: boolean;
  prior?: ReferenceRow[];
  allowTargets?: boolean;
  denied?: string;
  origins?: ReferenceRow[];
}) {
  let fields = options.fields;
  const calls: { text: string; parameters: readonly unknown[] }[] = [];
  const events: string[] = [];
  const stored = (values: ReferenceRow[]) => values.map(row => {
    if (fields) return row;
    const { source_field: _, ...legacy } = row;
    return legacy;
  });
  function answer(text: string, parameters: readonly unknown[]): unknown[] {
    if (text === "SELECT to_regclass('loom.revision_change_notes') IS NOT NULL AS present") {
      assert.deepEqual(parameters, []);
      events.push('schema');
      return [{ present: fields }];
    }
    if (text.startsWith('SELECT * FROM loom.revision_references')) {
      assert.equal(text, 'SELECT * FROM loom.revision_references WHERE revision_id=$1' +
        (fields ? ' AND source_field=$2' : '') + ' ORDER BY reference_id LIMIT 17');
      assert.deepEqual(parameters, fields ? [base, 'main'] : [base]);
      events.push('base');
      return stored(options.prior ?? []);
    }
    if (text.startsWith('SELECT rr.* FROM loom.revision_references')) {
      assert.equal(text.includes("AND rr.source_field='main'"), fields);
      assert.equal(parameters[0], source);
      events.push(`origin:${parameters[1]}`);
      return stored((options.origins ?? []).filter(row => row.reference_id === parameters[1]));
    }
    assert.equal(options.allowTargets, true, `Unexpected target access: ${text}`);
    if (text.startsWith('SELECT pg_advisory_xact_lock_shared')) return [];
    if (text.startsWith('WITH RECURSIVE owners AS')) {
      assert.equal(parameters[1], 33);
      return [{ id: area }, { id: parameters[0] }];
    }
    if (text.includes('FROM loom.resources WHERE id = $1 FOR SHARE')) {
      const index = references.findIndex(ref => ref.target.resource_id === parameters[0]);
      assert.ok(parameters[0] === area || index >= 0);
      return [{ id: parameters[0], kind: parameters[0] === area ? 'area' : 'artifact',
        owner_resource_id: parameters[0] === area ? null : area, original_author_id: null,
        state: parameters[0] === options.denied ? 'suppressed' : 'active', publication_open: false,
        current_revision_id: parameters[0] === area ? null : id(400 + index) }];
    }
    if (text === 'SELECT id FROM loom.artifacts WHERE id=$1') return [{ id: parameters[0] }];
    if (text.startsWith('SELECT id FROM loom.revisions WHERE resource_id = $1')) {
      const index = references.findIndex(ref => ref.target.resource_id === parameters[0]);
      assert.deepEqual(parameters, [references[index]!.target.resource_id, id(400 + index), 'available']);
      return [{ id: parameters[1] }];
    }
    if (text === 'SELECT content_format FROM loom.revisions WHERE id=$1') {
      const index = references.findIndex((_, index) => id(400 + index) === parameters[0]);
      assert.ok(index >= 0);
      events.push(`authorize:${references[index]!.reference_id}`);
      return [{ content_format: 'loom-markdown-v2' }];
    }
    throw new Error(`Unexpected query: ${text}`);
  }
  const tx: SqlTransaction = {
    async query<Row extends QueryResultRow>(text: string, parameters: readonly unknown[]) {
      calls.push({ text, parameters });
      const result = answer(text, parameters) as Row[];
      return { command: 'SELECT', rowCount: result.length, oid: 0, fields: [], rows: result };
    },
  };
  return { tx, calls, events, setFields(value: boolean) { fields = value; } };
}

for (const fields of [true, false]) {
  test(`16 unchanged references use one schema lookup and retain complete provenance (${fields ? 'current' : 'legacy'})`, async () => {
    const db = fixture({ fields, prior: rows });
    assert.deepEqual(await prepareReferences(db.tx, source, base, references), expectedCarry);
    assert.equal(db.events.filter(event => event === 'schema').length, 1);
    assert.equal(db.calls.length, 2);
    assert.deepEqual(db.events, ['schema', 'base']);
  });

  test(`new references authorize before lazy schema discovery and retain origin (${fields ? 'current' : 'legacy'})`, async () => {
    const db = fixture({ fields, allowTargets: true, origins: [rows[0]!] });
    assert.deepEqual(await prepareReferences(db.tx, source, null, references.slice(0, 2)), [
      { ...references[0]!, origin_revision_id: rows[0]!.origin_revision_id, assertion_revision_id: null },
      { ...references[1]!, origin_revision_id: null, assertion_revision_id: null },
    ]);
    assert.deepEqual(db.events, [`authorize:${id(100)}`, 'schema', `origin:${id(100)}`,
      `authorize:${id(101)}`, `origin:${id(101)}`]);
  });

  test(`empty preparations keep only their original base-read work (${fields ? 'current' : 'legacy'})`, async () => {
    const db = fixture({ fields });
    assert.deepEqual(await prepareReferences(db.tx, source, null, []), []);
    assert.deepEqual(await prepareReferences(db.tx, source, base, [], 'change_note'), []);
    assert.deepEqual(db.calls, []);
    assert.deepEqual(await prepareReferences(db.tx, source, base, []), []);
    assert.deepEqual(db.events, ['schema', 'base']);
  });
}

test('capability is resolved independently for consecutive preparations, including false', async () => {
  const db = fixture({ fields: false, prior: [rows[0]!] });
  for (const fields of [false, true, false]) {
    db.setFields(fields);
    assert.deepEqual(await prepareReferences(db.tx, source, base, [references[0]!]), [expectedCarry[0]!]);
  }
  assert.deepEqual(db.events, ['schema', 'base', 'schema', 'base', 'schema', 'base']);
});

test('changed immediate-base declarations reauthorize and reset only assertion provenance', async () => {
  const db = fixture({ fields: true, prior: [rows[0]!], allowTargets: true });
  const changed = { ...references[0]!, rationale: 'Changed declaration' };
  assert.deepEqual(await prepareReferences(db.tx, source, base, [changed]), [
    { ...changed, origin_revision_id: rows[0]!.origin_revision_id, assertion_revision_id: null },
  ]);
  assert.deepEqual(db.events, ['schema', 'base', `authorize:${id(100)}`]);
});

for (const field of ['main', 'change_note'] as const) {
  test(`denied ${field} target with no base fails before any schema lookup`, async () => {
    const db = fixture({ fields: true, allowTargets: true, denied: references[0]!.target.resource_id });
    await assert.rejects(prepareReferences(db.tx, source, null, [references[0]!], field), unavailable);
    assert.deepEqual(db.events, []);
    assert.ok(db.calls.length > 0, 'The real target guard must run.');
  });
}

test('changed denied base target still fails after the original base-read phase', async () => {
  const db = fixture({ fields: true, prior: [rows[0]!], allowTargets: true, denied: references[0]!.target.resource_id });
  await assert.rejects(prepareReferences(db.tx, source, base, [{ ...references[0]!, rationale: 'Changed' }]), unavailable);
  assert.deepEqual(db.events, ['schema', 'base']);
});

test('change-note preparation ignores main-base provenance and authorizes before its one lookup', async () => {
  const db = fixture({ fields: true, prior: rows, allowTargets: true });
  const input = references.slice(0, 2);
  assert.deepEqual(await prepareReferences(db.tx, source, base, input, 'change_note'),
    input.map(ref => ({ ...ref, origin_revision_id: null, assertion_revision_id: null })));
  assert.deepEqual(db.events, [`authorize:${id(100)}`, 'schema', `authorize:${id(101)}`]);
});

test('public revision reads keep independent discovery and normalize legacy main rows', async () => {
  const db = fixture({ fields: false, prior: rows });
  assert.deepEqual(await revisionReferences(db.tx, base), rows);
  assert.deepEqual(await revisionReferences(db.tx, base, 'change_note'), []);
  db.setFields(true);
  assert.deepEqual(await revisionReferences(db.tx, base), rows);
  assert.deepEqual(db.events, ['schema', 'base', 'schema', 'schema', 'base']);
});
