import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { QueryResultRow } from 'pg';
import type { SqlTransaction } from '../../src/server/db/postgres.js';
import { actorFromVerifiedIdentity } from '../../src/server/modules/publication/actor.js';
import { ParticipationPublications } from '../../src/server/modules/participation/publications.js';
import { preparePublicationRequest } from '../../src/server/modules/participation/publication-preparation.js';
import { PublicationError } from '../../src/server/modules/publication/errors.js';
import { FileError } from '../../src/server/modules/participation/file-storage.js';

const participant = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const resource = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const revision = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const area = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const operation = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const actor = actorFromVerifiedIdentity({ participantId: participant, credentialId: participant });
const input = { idempotency_key: participant, resource_id: resource, expected_revision_id: revision,
  title: 'Retained title', content: { format: 'loom-markdown-v1', text: 'Retained body', mentions: [] } };
const prepared = preparePublicationRequest('revision.publish', input);
const saved = { id: operation, resource_id: resource, revision_id: revision,
  semantic_version: prepared.version, request_digest: prepared.digest };

function fixture(options: { saved?: typeof saved; open?: boolean; editor?: boolean; available?: boolean; active?: boolean; expiredUpload?: boolean }) {
  const events: string[] = [];
  const tx: SqlTransaction = {
    async query<Row extends QueryResultRow>(sql: string, parameters: readonly unknown[]) {
      let rows: object[] = [];
      if (sql.startsWith('SET ') || sql.includes('set_config') || sql.includes('pg_advisory')) {}
      else if (sql.includes('FROM loom.idempotency_records')) { events.push('outcome'); rows = options.saved ? [options.saved] : []; }
      else if (sql === 'SELECT id FROM loom.participants WHERE id=$1 FOR SHARE') events.push('participant-plan');
      else if (sql.includes('SELECT state, role, kind, nickname')) {
        events.push('actor'); rows = [{ state: options.active === false ? 'suspended' : 'active', role: 'participant', kind: 'agent', nickname: 'Author' }];
      } else if (sql.includes('FROM loom.participant_credentials')) {
        events.push('credential'); rows = [{ id: participant, participant_id: participant, state: 'active', kind: 'agent', unexpired: true, parent_credential_id: null }];
      } else if (sql.includes('WITH RECURSIVE owners')) { events.push('context'); rows = [{ id: resource }, { id: area }]; }
      else if (sql.includes('FROM loom.resources WHERE id = $1')) rows = [{ id: parameters[0], kind: parameters[0] === area ? 'area' : 'artifact', owner_resource_id: parameters[0] === area ? null : area,
        original_author_id: participant, state: 'active', publication_open: options.open !== false, current_revision_id: parameters[0] === area ? null : revision }];
      else if (sql.includes('FROM loom.revisions WHERE resource_id')) { events.push('revision'); rows = options.available === false ? [] : [{ id: revision }]; }
      else if (sql.includes('FROM loom.resource_editors')) { events.push('editor'); rows = options.editor === false ? [] : [{ id: participant }]; }
      else if (sql.includes("to_regclass('loom.participation_rate_policy')")) {
        events.push('allowance'); rows = [{ present: false }];
      } else if (options.expiredUpload && sql.includes("to_regclass('loom.file_publication_refusals')")) rows = [{ ready: true }];
      else if (options.expiredUpload && sql.startsWith('SELECT request_digest FROM loom.file_publication_refusals')) rows = [];
      else if (options.expiredUpload && sql.includes("to_regclass('loom.contribution_attachment_sets')")) rows = [{ present: false }];
      else if (options.expiredUpload && sql.includes('FROM loom.file_uploads')) rows = [{ prepared_valid: false, state: 'expired' }];
      else if (options.expiredUpload && sql.includes('count(*)::text AS count FROM loom.file_publication_refusals')) rows = [{ count: '0' }];
      else if (options.expiredUpload && sql.startsWith('INSERT INTO loom.file_publication_refusals')) { events.push('refusal'); }
      else assert.fail('Unexpected SQL after guarded replay/admission: ' + sql);
      return { command: 'SELECT', rowCount: rows.length, oid: 0, fields: [], rows: rows as Row[] };
    },
  };
  const publisher = new ParticipationPublications({ async transaction(callback) {
    events.push('begin');
    try { const value = await callback(tx); events.push('commit'); return value; }
    catch (error) { events.push('rollback'); throw error; }
  } });
  return { publisher, events };
}
const replayEvents = ['begin', 'outcome', 'participant-plan', 'actor', 'credential', 'context', 'revision', 'editor'];
test('exact replay reauthorizes the retained revision before returning its complete result without admission or new-write checks', async () => {
  const { publisher, events } = fixture({ saved });
  assert.deepEqual(await publisher.publish(actor, 'revision.publish', input), {
    publication_state: 'committed', idempotency: 'replayed', operation_id: operation, resource_id: resource, revision_id: revision,
  });
  assert.deepEqual(events, [...replayEvents, 'commit']);
});
for (const [name, options, code, expectedEvents] of [
  ['changed digest', { saved: { ...saved, request_digest: 'different' } }, 'idempotency_conflict', replayEvents],
  ['posting closure before digest conflict', { saved: { ...saved, request_digest: 'different' }, open: false }, 'forbidden', replayEvents],
  ['lost editing authority', { saved, editor: false }, 'forbidden', replayEvents],
  ['unavailable historical revision', { saved, available: false }, 'unavailable', replayEvents.slice(0, -1)],
  ['suspended actor', { saved, active: false }, 'unavailable', replayEvents.slice(0, 5)],
] as const) test(`replay preserves ${name} refusal and transaction rollback`, async () => {
  const { publisher, events } = fixture(options);
  await assert.rejects(publisher.publish(actor, 'revision.publish', input), (error: unknown) => error instanceof PublicationError && error.code === code);
  assert.deepEqual(events, [...expectedEvents, 'rollback']);
});
test('a new file-expiry refusal commits its durable record before becoming an error, without charging or entering the revision tail', async () => {
  const { publisher, events } = fixture({ expiredUpload: true });
  await assert.rejects(publisher.publish(actor, 'artifact.create', {
    idempotency_key: participant, area_id: area, title: 'File',
    content: { format: 'loom-markdown-v3', text: '', mentions: [], references: [] }, change_note: null, change_account: null,
    file_set: { version: 'artifact-files-v1', files: [{ path: 'file.txt', source: { upload_id: participant } }] },
  }), (error: unknown) => error instanceof FileError && error.code === 'file_expired' && error.definitive);
  assert.deepEqual(events, ['begin', 'outcome', 'participant-plan', 'actor', 'credential', 'allowance', 'refusal', 'commit']);
});
