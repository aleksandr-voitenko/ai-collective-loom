import assert from 'node:assert/strict';
import { test } from 'node:test';
import { actorFromVerifiedIdentity } from '../../src/server/modules/publication/actor.js';
import { PublicationError } from '../../src/server/modules/publication/errors.js';
import {
  ParticipationPublications,
  type PublicationKind,
  type PublicationRequest,
} from '../../src/server/modules/participation/publications.js';

const id = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
const content = { format: 'loom-markdown-v1' as const, text: ' Exact\r\nUnicode é ', mentions: [] };
const base = { idempotency_key: id };
const authored = { ...base, title: 'Title', content };
const requests: PublicationRequest[] = [
  { kind: 'discussion.create', input: { ...authored, area_id: id } },
  { kind: 'reply.create', input: { ...base, content, discussion_id: id, parent_id: id } },
  { kind: 'artifact.create', input: { ...authored, area_id: id } },
  {
    kind: 'revision.publish',
    input: { ...authored, title: null, resource_id: id, expected_revision_id: id },
  },
  {
    kind: 'community.setup',
    input: {
      ...base,
      overview: content,
      community_name: 'Community',
      ordinary_area_name: 'Work',
      proposal_area_name: 'Proposals',
    },
  },
  {
    kind: 'summary.create',
    input: { ...authored, discussion_id: id, coverage: { preparation_id: id } },
  },
  {
    kind: 'summary.revise',
    input: {
      ...authored,
      resource_id: id,
      expected_revision_id: id,
      coverage: { carry_forward_revision_id: id },
    },
  },
];
const actor = actorFromVerifiedIdentity({ participantId: id, credentialId: id });
const failure = (code: string) => (error: unknown) =>
  error instanceof PublicationError && error.code === code;

for (const request of requests) {
  test(
    request.kind + ' validates unknown bodies before SQL and preserves caller input',
    async () => {
      let transactions = 0;
      const publisher = new ParticipationPublications({
        transaction: async () => {
          transactions++;
          // A controlled stop after preparation, before executing any SQL.
          throw new PublicationError('retryable');
        },
      });
      const original = structuredClone(request.input);
      const { idempotency_key: _key, ...missingKey } = request.input;
      const { content: _content, overview: _overview, ...missingBody } = request.input;
      for (const invalid of [
        null,
        {},
        missingKey,
        missingBody,
        { ...request.input, kind: request.kind },
      ]) {
        await assert.rejects(
          publisher.publish(actor, request.kind, invalid),
          failure('invalid_input'),
        );
        assert.equal(transactions, 0);
      }
      await assert.rejects(
        publisher.publish(actor, request.kind, request.input),
        failure('retryable'),
      );
      assert.equal(transactions, 1);
      assert.deepEqual(request.input, original);
    },
  );
}

test('untyped callers still cannot introduce an unsupported publication operation', async () => {
  const publisher = new ParticipationPublications({
    transaction: async () => {
      assert.fail('Unsupported operations must not enter SQL');
    },
  });
  await assert.rejects(
    publisher.publish(actor, 'artifact.creat' as PublicationKind, requests[2]!.input),
    failure('invalid_input'),
  );
});
