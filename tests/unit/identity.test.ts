import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { AccountInput, IssueInput, input, requestDigest } from '../../src/server/modules/identity/contracts.js';
import { IdentityError } from '../../src/server/modules/identity/errors.js';
import { csrfValue, matches, opaqueToken, tokenId, validCsrf, verifier } from '../../src/server/modules/identity/secrets.js';
import { verifyPolicy, type IdentityPolicy } from '../../src/server/modules/identity/policy.js';

test('identity contracts reject unsupported fields and meaningful coercion', () => {
  const account = { idempotency_key: randomUUID(), nickname: 'Human_01', kind: 'human', role: 'participant' };
  assert.deepEqual(input(AccountInput, { ...account, idempotency_key: account.idempotency_key.toUpperCase() }), account);
  for (const value of [{ ...account, administrator: true }, { ...account, nickname: ' human ' }, { ...account, nickname: 'hümán' },
    { ...account, role: true }, { ...account, kind: ['human'] }, { ...account, nickname: 123 }, { ...account, nickname: 'ab' }]) {
    assert.throws(() => input(AccountInput,value), error => error instanceof IdentityError && error.code === 'invalid_request');
  }
  const issue = { idempotency_key: randomUUID(), participant_id: randomUUID(), kind: 'agent', purpose: null, label: 'runtime one', replace_credential_id: null };
  assert.deepEqual(input(IssueInput,issue), issue);
  assert.throws(() => input(IssueInput,{ ...issue, secret: 'caller secret' }), IdentityError);
  assert.notEqual(requestDigest('account.create',['Human','human','participant']), requestDigest('account.create',['Human','human','administrator']));
});
test('opaque credentials use 256-bit secrets, verifier-only comparison and separated channels', () => {
  for (const kind of ['agent','session','enrollment'] as const) {
    const token = opaqueToken(kind);
    assert.equal(Buffer.from(token.secret.split('.')[2]!, 'base64url').length,32);
    assert.equal(tokenId(token.secret,kind),token.id);
    assert.ok(matches(token.secret,token.verifier));
    assert.equal(matches(token.secret + 'x',token.verifier),false);
    assert.equal(matches(token.secret,'not a digest'),false);
    assert.equal(tokenId(token.secret,'agent' === kind ? 'session' : 'agent'),undefined);
    assert.equal(tokenId(token.secret + '=',kind),undefined);
    assert.ok(!token.verifier.includes(token.secret));
  }
  assert.notEqual(verifier(randomBytes(32).toString('base64url')),verifier(randomBytes(32).toString('base64url')));
});
test('CSRF proof is session-bound and rejects malformed Unicode without throwing', () => {
  const a = opaqueToken('session').secret, b = opaqueToken('session').secret;
  assert.ok(validCsrf(a,csrfValue(a)));
  for (const invalid of [csrfValue(b),undefined,'é'.repeat(43),'']) assert.equal(validCsrf(a,invalid),false);
});
test('identity policy must be explicit, bounded and use the exact HTTPS RP origin', () => {
  const policy = { origin: 'https://loom.test', rpId: 'loom.test', sessionSeconds: 28800, challengeSeconds: 300, enrollmentSeconds: 3600,
    agentSeconds: 7776000, maxAgentCredentials: 2, maxPasskeys: 2, maxSessions: 3, startsPerMinute: 100 };
  verifyPolicy(policy);
  for (const change of [{ origin: 'http://loom.test' }, { origin: 'https://loom.test/' }, { rpId: 'other.test' }, { maxSessions: 0 }, { startsPerMinute: 1.5 }, { sessionSeconds: 2147483648 }]) assert.throws(() => verifyPolicy({ ...policy,...change }));
  const { maxSessions: _sessions, ...missing } = policy;
  for (const invalid of [missing,{ ...policy, unknownOption: 1 },{ ...policy,origin: 'private-config-value' }]) {
    assert.throws(() => verifyPolicy(invalid as IdentityPolicy),error => error instanceof Error && error.message === 'An explicit valid HTTPS identity prototype policy is required.');
  }
});

test('invalid installation cookie namespaces fail closed before route registration', async () => {
  const { registerIdentityRoutes } = await import('../../src/server/http/identity.js');
  for (const cookieNamespace of ['', 'a; Domain=localhost', 'A', 'a'.repeat(65)])
    await assert.rejects(registerIdentityRoutes(undefined as never, {
      cookieNamespace, database: undefined as never,
      authentication: undefined as never, administration: undefined as never,
    }), /Invalid identity cookie namespace/);
});
