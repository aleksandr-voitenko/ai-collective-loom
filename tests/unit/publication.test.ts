import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { actorFromVerifiedIdentity, identityOf, type ActorContext } from '../../src/server/modules/publication/actor.js';
import { preparePublication } from '../../src/server/modules/publication/input.js';
import { PublicationError } from '../../src/server/modules/publication/errors.js';

test('semantic canonicalization includes all accepted substantive fields and preserves authored text', () => {
  const resource = randomUUID(), key = randomUUID(), revision = randomUUID();
  const value = { resource_id: resource, idempotency_key: key, expected_revision_id: revision, content: { format: 'text/plain', text: ' exact\r\nUnicode é ' } };
  const prepared = preparePublication(value);
  assert.deepEqual(prepared.input, value);
  assert.equal(prepared.digest, preparePublication({ content: value.content, expected_revision_id: revision.toUpperCase(), idempotency_key: randomUUID(), resource_id: resource.toUpperCase() }).digest);
  for (const change of [{ resource_id: randomUUID() }, { expected_revision_id: randomUUID() }, { content: { format: 'text/plain', text: value.content.text.trim() } }, { content: { format: 'text/plain', text: ' exact\r\nUnicode e\u0301 ' } }]) {
    assert.notEqual(prepared.digest, preparePublication({ ...value, ...change }).digest);
  }
  value.content.text = 'later caller mutation';
  assert.equal(prepared.input.content.text, ' exact\r\nUnicode é ');
  assert.ok(Object.isFrozen(prepared.input.content));
});
test('unsupported fields, missing preconditions and non-round-trippable text are rejected before SQL', () => {
  const value = { resource_id: randomUUID(), idempotency_key: randomUUID(), expected_revision_id: null, content: { format: 'text/plain', text: 'fixture' } };
  const { expected_revision_id: _expected, ...missing } = value;
  for (const invalid of [missing, { ...value, audience: 'private' }, { ...value, operation_kind: 'admin.publish' },
    { ...value, expected_revision_id: 7 }, { ...value, content: { format: 'text/plain', text: 7 } },
    { ...value, content: { format: 'text/plain', text: 'fixture', mentions: [] } },
    { ...value, content: { format: 'text/markdown', text: 'fixture' } },
    ...['', '\0', '\ud800'].map(text => ({ ...value, content: { format: 'text/plain', text } }))]) {
    assert.throws(() => preparePublication(invalid), error => error instanceof PublicationError && error.code === 'invalid_input');
  }
});
test('trusted actor contexts are opaque and cannot be supplied as identity-shaped JSON', () => {
  const identity = { participantId: randomUUID(), credentialId: randomUUID() };
  const actor = actorFromVerifiedIdentity(identity);
  assert.deepEqual(identityOf(actor), identity);
  assert.deepEqual(JSON.parse(JSON.stringify(actor)), {});
  for (const forged of [{}, identity, { participantId: identity.participantId, administrator: true }]) {
    assert.throws(() => identityOf(forged as ActorContext), error => error instanceof PublicationError && error.code === 'invalid_actor');
  }
});
