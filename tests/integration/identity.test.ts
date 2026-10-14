import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { test } from 'node:test';
import type pg from 'pg';
import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/server';
import type { SqlTransaction } from '../../src/server/db/postgres.js';
import { IdentityAdministration } from '../../src/server/modules/identity/administration.js';
import { IdentityAuthentication } from '../../src/server/modules/identity/authentication.js';
import { IdentityError } from '../../src/server/modules/identity/errors.js';
import { verifier } from '../../src/server/modules/identity/secrets.js';
import { PublicationOperation } from '../../src/server/modules/publication/publication.js';
import { PublicationError } from '../../src/server/modules/publication/errors.js';
import { isolatedPublicationPostgres } from '../helpers/publication-postgres.js';
import { identityHttp } from '../helpers/identity-http.js';
import { SoftwareAuthenticator } from '../helpers/software-authenticator.js';

const policy = { origin: 'https://loom.test', rpId: 'loom.test', sessionSeconds: 28800, challengeSeconds: 300, enrollmentSeconds: 3600,
  agentSeconds: 7776000, maxAgentCredentials: 2, maxPasskeys: 2, maxSessions: 3, startsPerMinute: 100 };
const base = '/prototype/identity';
const fail = (code: IdentityError['code']) => (error: unknown) => error instanceof IdentityError && error.code === code;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(accept => { resolve = accept; });
  return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>) {
  let timer!: NodeJS.Timeout;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Identity concurrency barrier timed out.')), 3000); })]); }
  finally { clearTimeout(timer); }
}
function pairBarrier() { return { key: '', kind: '', observations: [] as number[], reached: deferred(), release: deferred() }; }

test('controlled identity protocol with real PostgreSQL and signed software authenticators', { timeout: 120000 }, async t => {
  const fixture = await isolatedPublicationPostgres();
  t.after(fixture.close);
  const { database, observer } = fixture;
  let barrier: ReturnType<typeof pairBarrier> | undefined;
  let counters: { id: string; observed: string[]; reached: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | undefined;
  let bindingRace: { participant: string; ticket: string; observed: string[]; reached: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | undefined;
  let rollbackKind = '', loseReplyKind = '';
  const observed = {
    async transaction<T>(operation: (tx: SqlTransaction) => Promise<T>) {
      let committedKind = '';
      const result = await database.transaction(tx => operation({
        query: async <Row extends pg.QueryResultRow>(sql: string, values: readonly unknown[]) => {
          if (bindingRace && sql === 'SELECT id FROM loom.participants WHERE id = $1 FOR UPDATE' && values[0] === bindingRace.participant) {
            bindingRace.observed.push(String((await tx.query('SELECT state FROM loom.participant_credentials WHERE id = $1',[bindingRace.ticket])).rows[0]?.state));
            if (bindingRace.observed.length === 2) bindingRace.reached.resolve();
            await bindingRace.release.promise;
          }
          if (barrier && sql.startsWith('SELECT pg_advisory_xact_lock(hash')) {
            const [namespace, scope, kind, key] = JSON.parse(String(values[0])) as string[];
            if (namespace === 'loom.publication.attempt' && kind === barrier.kind && key === barrier.key) {
              const row = await tx.query<{ count: number }>('SELECT count(*)::integer AS count FROM loom.identity_outcomes WHERE attempt_scope = $1 AND operation_kind = $2 AND idempotency_key = $3', [scope,kind,key]);
              barrier.observations.push(row.rows[0]!.count);
              if (barrier.observations.length === 2) barrier.reached.resolve();
              await barrier.release.promise;
            }
          }
          const result = await tx.query<Row>(sql,values);
          if (counters && sql.includes('p.counter::text') && values[0] === counters.id) {
            counters.observed.push(String(result.rows[0]?.counter));
            if (counters.observed.length === 2) counters.reached.resolve();
            await counters.release.promise;
          }
          if (sql.startsWith('INSERT INTO loom.identity_outcomes')) committedKind = String(values[3]);
          if (sql.startsWith('INSERT INTO loom.administrative_audit') && String(values[5]) === rollbackKind) {
            rollbackKind = ''; throw new Error('synthetic transaction failure');
          }
          return result;
        },
      }));
      if (committedKind && committedKind === loseReplyKind) { loseReplyKind = ''; throw new Error('synthetic lost acknowledgement after COMMIT'); }
      return result;
    },
  };
  const bootstrapCapability = randomBytes(32).toString('base64url'), recoveryCapability = randomBytes(32).toString('base64url');
  const administration = new IdentityAdministration(observed,policy,{ bootstrap: verifier(bootstrapCapability), recovery: verifier(recoveryCapability) });
  const authentication = new IdentityAuthentication(observed,policy);
  let diagnostics = '';
  const app = await identityHttp({ database: { isReady: () => database.isReady(), close: async () => {} }, administration, authentication,
    diagnostics: new Writable({ write(chunk,_encoding,done) { diagnostics += String(chunk); done(); } }) });
  t.after(() => app.close());
  const post = (path: string, payload: unknown, headers: Record<string,string> = { origin: policy.origin }) => app.inject({ method: 'POST', url: base + path, payload: payload as Record<string,unknown>, headers });
  const get = (path: string, headers: Record<string,string>) => app.inject({ method: 'GET', url: base + path, headers });
  const cookieHeader = (response: { headers: Record<string, string | string[] | number | undefined> }) => {
    const header = response.headers['set-cookie']; assert.equal(typeof header,'string');
    assert.ok(/; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=/.test(String(header)));
    return String(header).split(';')[0]!;
  };
  async function enroll(ticket: string) {
    const key = new SoftwareAuthenticator(policy.origin);
    const start = await post('/register/start',{ ticket }); assert.equal(start.statusCode,200);
    const data = start.json() as { challenge_id: string; options: PublicKeyCredentialCreationOptionsJSON };
    const result = await post('/register/finish',{ challenge_id: data.challenge_id, response: key.registration(data.options) },{ origin: policy.origin, cookie: cookieHeader(start) });
    assert.equal(result.statusCode,200);
    return { key, ...result.json() as { participant_id: string; credential_id: string } };
  }
  async function login(key: SoftwareAuthenticator) {
    const start = await post('/signin/start',{}); assert.equal(start.statusCode,200);
    const data = start.json() as { challenge_id: string; options: PublicKeyCredentialRequestOptionsJSON };
    const result = await post('/signin/finish',{ challenge_id: data.challenge_id, response: key.assertion(data.options) },{ origin: policy.origin, cookie: cookieHeader(start) });
    assert.equal(result.statusCode,200);
    assert.ok(!('session' in result.json()));
    const sessionCookie = cookieHeader(result);
    const self = await get('/self',{ cookie: sessionCookie }); assert.equal(self.statusCode,200);
    const headers = { origin: policy.origin, cookie: sessionCookie, 'x-loom-csrf': String(self.json().csrf) };
    const secret = sessionCookie.slice(sessionCookie.indexOf('=') + 1);
    return { headers, secret, actor: await authentication.authenticate(secret,'session'), ...result.json() as { participant_id: string; credential_id: string } };
  }
  let firstAdministrator = '';
  await t.test('bootstrap capability is required; initially absent repeats converge and new attempts close permanently', async () => {
    const request = { idempotency_key: randomUUID(), nickname: 'FirstAdmin' };
    await assert.rejects(administration.bootstrap(randomBytes(32).toString('base64url'),request),fail('unauthenticated'));
    barrier = pairBarrier(); barrier.key = request.idempotency_key; barrier.kind = 'community.bootstrap';
    const repeats = [administration.bootstrap(bootstrapCapability,request),administration.bootstrap(bootstrapCapability,request)] as const;
    try { await bounded(barrier.reached.promise); assert.deepEqual(barrier.observations,[0,0]); }
    finally { barrier.release.resolve(); }
    const [a,b] = await Promise.all(repeats); barrier = undefined;
    assert.equal(a.participant_id,b.participant_id); assert.equal(a.operation_id,b.operation_id);
    assert.deepEqual([a.idempotency,b.idempotency].sort(),['created','replayed']);
    firstAdministrator = a.participant_id;
    await assert.rejects(administration.bootstrap(bootstrapCapability,{ ...request,nickname: 'Different' }),fail('idempotency_conflict'));
    await assert.rejects(administration.bootstrap(bootstrapCapability,{ idempotency_key: randomUUID(),nickname: 'OtherAdmin' }),fail('bootstrap_closed'));
    assert.equal((await observer.query('SELECT count(*)::integer AS n FROM loom.participants')).rows[0].n,1);
    assert.equal((await observer.query('SELECT count(*)::integer AS n FROM loom.participant_credentials')).rows[0].n,0);
    assert.equal((await post('/bootstrap',request)).statusCode,404);
  });
  assert.ok(firstAdministrator);
  const initialEnrollment = { idempotency_key: randomUUID(), participant_id: firstAdministrator, kind: 'enrollment', purpose: 'enroll', label: 'first passkey', replace_credential_id: null };
  const initialTicket = await administration.deploymentEnrollment(bootstrapCapability,'bootstrap',initialEnrollment);
  assert.ok(initialTicket.secret);
  const administratorPasskey = await enroll(initialTicket.secret);
  let administrator = await login(administratorPasskey.key);
  async function admit(nickname: string, kind = 'agent', role = 'participant') {
    const result = await post('/accounts',{ idempotency_key: randomUUID(),nickname,kind,role },administrator.headers);
    assert.equal(result.statusCode,200); return result.json() as { participant_id: string; operation_id: string };
  }
  function issuance(participantId: string, kind = 'agent', purpose: string | null = null, replace: string | null = null) {
    return { idempotency_key: randomUUID(),participant_id: participantId,kind,purpose,label: 'synthetic runtime',replace_credential_id: replace };
  }
  async function issue(request: ReturnType<typeof issuance>) {
    const result = await post('/credentials',request,administrator.headers);
    assert.equal(result.statusCode,200); return { response: result, ...result.json() as { participant_id: string; credential_id: string; secret?: string; operation_id: string } };
  }
  const human = await admit('OrdinaryHuman','human');
  const humanTicket = await issue(issuance(human.participant_id,'enrollment','enroll'));
  const humanPasskey = await enroll(humanTicket.secret!);
  const browser = await login(humanPasskey.key);
  const agent = await admit('OrdinaryAgent');
  const agentCredential = await issue(issuance(agent.participant_id));
  const bearer = { authorization: 'Bearer ' + agentCredential.secret! };

  await t.test('verified cookie and bearer identities share policy; ordinary participants cannot administer or read audit', async () => {
    assert.equal((await get('/self',browser.headers)).json().participant_id,human.participant_id);
    assert.equal((await get('/self',bearer)).json().participant_id,agent.participant_id);
    for (const headers of [browser.headers,bearer]) {
      for (const path of ['/accounts','/audit','/credentials?participant_id=' + firstAdministrator]) assert.equal((await get(path,headers)).statusCode,403);
      const response = await post('/accounts',{ idempotency_key: randomUUID(),nickname: 'DeniedAdmin',kind: 'human',role: 'administrator' },headers);
      assert.equal(response.statusCode,403); assert.equal(response.json().error.code,'forbidden');
    }
    assert.equal((await get('/self',{ 'x-loom-participant': firstAdministrator } as Record<string,string>)).statusCode,401);
    const audit = await get('/audit',administrator.headers); assert.equal(audit.statusCode,200);
    assert.ok(audit.json().some((row: { authority: string }) => row.authority === 'deployment_bootstrap'));
    const admitted = audit.json().find((row: { operation_id: string }) => row.operation_id === agent.operation_id);
    assert.equal(admitted.actor_id,firstAdministrator); assert.equal(admitted.actor_credential_id,administrator.credential_id);
    assert.equal((await observer.query('SELECT shared_position::text AS position FROM loom.community_clocks')).rows[0].position,'0');
  });
  await t.test('verified browser and bearer actors publish through the existing shared operation, with persisted provenance', async () => {
    const publisher = new PublicationOperation(database);
    for (const actor of [browser.actor,await authentication.authenticate(agentCredential.secret!,'agent')]) {
      const identity = await authentication.self(actor), resource = await fixture.resource(identity.participant_id);
      const request = { idempotency_key: randomUUID(),resource_id: resource.resourceId,expected_revision_id: null,content: { format: 'text/plain',text: 'synthetic authenticated publication' } };
      const result = await publisher.publish(actor,request);
      const stored = (await observer.query('SELECT publisher_id FROM loom.revisions WHERE id = $1',[result.revision_id])).rows[0];
      assert.equal(stored.publisher_id,identity.participant_id);
      const retry = await publisher.publish(actor,request); assert.equal(retry.revision_id,result.revision_id); assert.equal(retry.idempotency,'replayed');
    }
  });
  await t.test('cookie mutations require exact origin and session-bound CSRF; mixed channels are rejected', async () => {
    const body = { idempotency_key: randomUUID(),nickname: 'CSRFAccount',kind: 'human',role: 'participant' };
    for (const headers of [ { cookie: administrator.headers.cookie,origin: policy.origin },
      { ...administrator.headers,origin: 'https://evil.test' }, { ...administrator.headers,'x-loom-csrf': browser.headers['x-loom-csrf'] } ]) {
      const denied = await post('/accounts',body,headers); assert.equal(denied.statusCode,401); assert.equal(denied.json().error.code,'invalid_proof');
    }
    assert.equal((await get('/self',{ ...bearer,cookie: browser.headers.cookie })).statusCode,401);
    assert.equal((await post('/signin/start',{},{})).statusCode,401);
    for (const bad of [{ ...body,owner_id: firstAdministrator },{ ...body,role: true },{ ...body,nickname: 12 }]) assert.equal((await post('/accounts',bad,administrator.headers)).statusCode,400);
    const oversized = await post('/accounts',{ ...body,nickname: 'private-body'.repeat(7000) },administrator.headers);
    assert.equal(oversized.statusCode,413); assert.equal(oversized.json().error.code,'request_too_large'); assert.ok(!oversized.body.includes('private-body'));
    const bearerCeremony = await post('/signin/start',{}, { ...bearer,origin: 'https://evil.test' }); assert.equal(bearerCeremony.statusCode,401);
  });
  await t.test('two account requests observe absence and converge on one participant, reservation, outcome and audit', async () => {
    const request = { idempotency_key: randomUUID(),nickname: 'Convergent',kind: 'agent',role: 'participant' };
    barrier = pairBarrier(); barrier.kind = 'account.create'; barrier.key = request.idempotency_key;
    const responses = [post('/accounts',request,administrator.headers),post('/accounts',request,administrator.headers)] as const;
    try { await bounded(barrier.reached.promise); assert.deepEqual(barrier.observations,[0,0]); }
    finally { barrier.release.resolve(); }
    const [a,b] = await Promise.all(responses); barrier = undefined;
    assert.equal(a.statusCode,200); assert.equal(b.statusCode,200);
    const x = a.json(), y = b.json(); assert.equal(x.participant_id,y.participant_id); assert.equal(x.operation_id,y.operation_id);
    const rows = await observer.query(`SELECT ARRAY[
      (SELECT count(*) FROM loom.participants WHERE id = $1), (SELECT count(*) FROM loom.nickname_reservations WHERE participant_id = $1),
      (SELECT count(*) FROM loom.identity_outcomes WHERE id = $2), (SELECT count(*) FROM loom.administrative_audit WHERE operation_id = $2),
      (SELECT count(*) FROM loom.participant_credentials WHERE participant_id = $1)]::integer[] AS counts`,[x.participant_id,x.operation_id]);
    assert.deepEqual(rows.rows[0].counts,[1,1,1,1,0]);
    const conflict = await post('/accounts',{ ...request,role: 'administrator' },administrator.headers); assert.equal(conflict.statusCode,409); assert.equal(conflict.json().error.code,'idempotency_conflict');
  });
  await t.test('nickname races admit one participant; reserved old spellings never transfer identity', async () => {
    const results = await Promise.all(['RaceName','racename'].map(nickname => post('/accounts',{ idempotency_key: randomUUID(),nickname,kind: 'human',role: 'participant' },administrator.headers)));
    assert.deepEqual(results.map(result => result.statusCode).sort(),[200,409]);
    const winner = results.find(result => result.statusCode === 200)!.json().participant_id;
    const rename = await post('/rename',{ idempotency_key: randomUUID(),participant_id: winner,nickname: 'RenamedHuman' },administrator.headers); assert.equal(rename.statusCode,200);
    const attempt = await post('/accounts',{ idempotency_key: randomUUID(),nickname: 'RACENAME',kind: 'agent',role: 'participant' },administrator.headers);
    assert.equal(attempt.statusCode,409); assert.equal(attempt.json().error.code,'nickname_conflict');
    const restore = await post('/rename',{ idempotency_key: randomUUID(),participant_id: winner,nickname: 'RaceName' },administrator.headers); assert.equal(restore.statusCode,200);
    const reservations = await observer.query('SELECT normalized,participant_id FROM loom.nickname_reservations WHERE participant_id = $1 ORDER BY normalized',[winner]);
    assert.deepEqual(reservations.rows,[{ normalized: 'racename',participant_id: winner },{ normalized: 'renamedhuman',participant_id: winner }]);
  });
  await t.test('lost account acknowledgement reconciles by administrator identity without another participant', async () => {
    const request = { idempotency_key: randomUUID(),nickname: 'LostAccount',kind: 'agent',role: 'participant' };
    loseReplyKind = 'account.create';
    const lost = await post('/accounts',request,administrator.headers); assert.equal(lost.statusCode,503); assert.equal(lost.json().error.code,'service_unavailable');
    const recovered = await post('/reconcile',{ idempotency_key: request.idempotency_key,operation_kind: 'account.create' },administrator.headers); assert.equal(recovered.statusCode,200);
    const retry = await post('/accounts',request,administrator.headers); assert.equal(retry.statusCode,200); assert.deepEqual(retry.json(),recovered.json());
    assert.equal(retry.json().idempotency,'replayed');
    assert.equal((await observer.query('SELECT count(*)::integer AS n FROM loom.participants WHERE nickname = $1',['LostAccount'])).rows[0].n,1);
    assert.equal((await observer.query('SELECT count(*)::integer AS n FROM loom.participant_credentials WHERE participant_id = $1',[retry.json().participant_id])).rows[0].n,0);
  });
  await t.test('lost credential acknowledgement never replays a secret; explicit replacement retains participant identity', async () => {
    const account = await admit('LostCredential');
    const request = issuance(account.participant_id); loseReplyKind = 'credential.issue';
    const lost = await post('/credentials',request,administrator.headers); assert.equal(lost.statusCode,503);
    const replay = await issue(request); assert.ok(!('secret' in replay.response.json())); assert.equal(replay.response.json().idempotency,'replayed');
    const recovered = await post('/reconcile',{ idempotency_key: request.idempotency_key,operation_kind: 'credential.issue' },administrator.headers); assert.equal(recovered.statusCode,200);
    assert.deepEqual(recovered.json(),replay.response.json());
    const replacement = await issue(issuance(account.participant_id,'agent',null,replay.credential_id)); assert.ok(replacement.secret); assert.equal(replacement.participant_id,account.participant_id);
    const rows = await observer.query('SELECT id,state FROM loom.participant_credentials WHERE participant_id = $1 ORDER BY state',[account.participant_id]);
    assert.deepEqual(rows.rows,[{ id: replacement.credential_id,state: 'active' },{ id: replay.credential_id,state: 'revoked' }]);
    const freshRetry = await issue({ ...request,replace_credential_id: null }); assert.ok(!('secret' in freshRetry.response.json()));
    assert.equal((await post('/credentials',{ ...request,label: 'different runtime' },administrator.headers)).statusCode,409);
    const own = await get('/self',{ authorization: 'Bearer ' + replacement.secret }); assert.equal(own.statusCode,200); assert.equal(own.json().participant_id,account.participant_id);
  });
  await t.test('labelled concurrent credentials enforce the prototype cap and atomic replacement revokes the selected predecessor', async () => {
    const account = await admit('ConcurrentAgent');
    const a = await issue(issuance(account.participant_id));
    const b = await issue({ ...issuance(account.participant_id),label: 'second runtime' });
    const denied = await post('/credentials',issuance(account.participant_id),administrator.headers); assert.equal(denied.statusCode,409); assert.equal(denied.json().error.code,'credential_limit');
    const replacement = await issue(issuance(account.participant_id,'agent',null,a.credential_id));
    assert.equal((await get('/self',{ authorization: 'Bearer ' + a.secret })).statusCode,401);
    for (const credential of [b,replacement]) { const own = await get('/self',{ authorization: 'Bearer ' + credential.secret }); assert.equal(own.statusCode,200); assert.equal(own.json().participant_id,account.participant_id); }
  });
  await t.test('an uncertain enrollment ticket can be replaced on the same account and never replays its secret', async () => {
    const account = await admit('LostEnrollment','human');
    const request = issuance(account.participant_id,'enrollment','enroll');
    const first = await issue(request), replay = await issue(request); assert.ok(first.secret); assert.ok(!('secret' in replay.response.json()));
    const replacement = await issue(issuance(account.participant_id,'enrollment','enroll',first.credential_id));
    assert.equal((await post('/register/start',{ ticket: first.secret })).statusCode,401);
    const bound = await enroll(replacement.secret!); assert.equal(bound.participant_id,account.participant_id);
    assert.equal((await post('/register/start',{ ticket: replacement.secret })).statusCode,401);
  });
  await t.test('two verified registration ceremonies race on one ticket and bind only one passkey', async () => {
    const account = await admit('EnrollmentRace','human');
    const ticket = await issue(issuance(account.participant_id,'enrollment','enroll'));
    const starts = await Promise.all([post('/register/start',{ ticket: ticket.secret }),post('/register/start',{ ticket: ticket.secret })]);
    bindingRace = { participant: account.participant_id,ticket: ticket.credential_id,observed: [],reached: deferred(),release: deferred() };
    const requests = starts.map(start => {
      assert.equal(start.statusCode,200);
      const data = start.json() as { challenge_id: string; options: PublicKeyCredentialCreationOptionsJSON };
      return post('/register/finish',{ challenge_id: data.challenge_id,response: new SoftwareAuthenticator(policy.origin).registration(data.options) },{ origin: policy.origin,cookie: cookieHeader(start) });
    });
    try { await bounded(bindingRace.reached.promise); assert.deepEqual(bindingRace.observed,['active','active']); }
    finally { bindingRace.release.resolve(); }
    const results = await Promise.all(requests); bindingRace = undefined;
    assert.deepEqual(results.map(result => result.statusCode).sort(),[200,401]);
    assert.equal((await observer.query('SELECT count(*)::integer AS n FROM loom.passkeys WHERE enrollment_credential_id = $1',[ticket.credential_id])).rows[0].n,1);
    assert.equal((await observer.query('SELECT state FROM loom.participant_credentials WHERE id = $1',[ticket.credential_id])).rows[0].state,'revoked');
  });
  await t.test('WebAuthn enforces origin, RP, challenge, signature, user verification, user handle and single-use proofs', async () => {
    for (const changes of [{ origin: 'https://evil.test' },{ rpId: 'other.test' },{ challenge: 'wrong' },{ verified: false },{ invalidSignature: true },{ userHandle: randomBytes(36).toString('base64url') },{ crossOrigin: true }]) {
      const start = await post('/signin/start',{}); assert.equal(start.statusCode,200);
      const data = start.json() as { challenge_id: string; options: PublicKeyCredentialRequestOptionsJSON };
      const payload = { challenge_id: data.challenge_id,response: humanPasskey.key.assertion(data.options,changes) };
      const headers = { origin: policy.origin,cookie: cookieHeader(start) };
      const failure = await post('/signin/finish',payload,headers); assert.equal(failure.statusCode,401); assert.equal(failure.json().error.code,'invalid_proof');
      const replay = await post('/signin/finish',{ ...payload,response: humanPasskey.key.assertion(data.options) },headers); assert.equal(replay.statusCode,401); assert.equal(replay.json().error.code,'invalid_proof');
      assert.ok((await observer.query('SELECT consumed_at FROM loom.webauthn_challenges WHERE id = $1',[data.challenge_id])).rows[0].consumed_at);
    }
    const start = await post('/signin/start',{}); const data = start.json() as { challenge_id: string; options: PublicKeyCredentialRequestOptionsJSON };
    const payload = { challenge_id: data.challenge_id,response: humanPasskey.key.assertion(data.options) };
    assert.equal((await post('/signin/finish',payload,{ origin: policy.origin,cookie: '__Host-loom-challenge=wrong' })).statusCode,401);
    await observer.query("UPDATE loom.webauthn_challenges SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1",[data.challenge_id]);
    assert.equal((await post('/signin/finish',payload,{ origin: policy.origin,cookie: cookieHeader(start) })).statusCode,401);
    const invalidEnrollAccount = await admit('InvalidPasskey','human');
    const ticket = await issue(issuance(invalidEnrollAccount.participant_id,'enrollment','enroll'));
    for (const changes of [{ origin: 'https://evil.test' },{ rpId: 'other.test' },{ challenge: 'wrong' },{ verified: false },{ crossOrigin: true }]) {
      const begun = await post('/register/start',{ ticket: ticket.secret }); const info = begun.json() as { challenge_id: string; options: PublicKeyCredentialCreationOptionsJSON };
      const key = new SoftwareAuthenticator(policy.origin);
      const denied = await post('/register/finish',{ challenge_id: info.challenge_id,response: key.registration(info.options,changes) },{ origin: policy.origin,cookie: cookieHeader(begun) });
      assert.equal(denied.statusCode,401);
    }
    assert.equal((await observer.query('SELECT count(*)::integer AS n FROM loom.passkeys p JOIN loom.participant_credentials c ON c.id = p.credential_id WHERE c.participant_id = $1',[invalidEnrollAccount.participant_id])).rows[0].n,0);
  });
  await t.test('passkey and session caps, logout, expiry and counter races respect current database state', async () => {
    const account = await admit('SessionLimits','human');
    const firstTicket = await issue(issuance(account.participant_id,'enrollment','enroll'));
    const firstKey = await enroll(firstTicket.secret!);
    const secondTicket = await issue({ ...issuance(account.participant_id,'enrollment','enroll'),label: 'second passkey' });
    const secondKey = await enroll(secondTicket.secret!);
    const thirdTicket = await issue(issuance(account.participant_id,'enrollment','enroll'));
    const start = await post('/register/start',{ ticket: thirdTicket.secret }); const options = start.json() as { challenge_id: string; options: PublicKeyCredentialCreationOptionsJSON };
    const deniedKey = new SoftwareAuthenticator(policy.origin);
    const denied = await post('/register/finish',{ challenge_id: options.challenge_id,response: deniedKey.registration(options.options) },{ origin: policy.origin,cookie: cookieHeader(start) });
    assert.equal(denied.statusCode,409); assert.equal(denied.json().error.code,'credential_limit');
    const sessions = [await login(firstKey.key),await login(firstKey.key),await login(secondKey.key)];
    const begin = await post('/signin/start',{}), challenge = begin.json() as { challenge_id: string; options: PublicKeyCredentialRequestOptionsJSON };
    const capped = await post('/signin/finish',{ challenge_id: challenge.challenge_id,response: firstKey.key.assertion(challenge.options) },{ origin: policy.origin,cookie: cookieHeader(begin) });
    assert.equal(capped.statusCode,409); assert.equal(capped.json().error.code,'credential_limit');
    const logout = await post('/logout',{},sessions[0]!.headers); assert.equal(logout.statusCode,200); assert.match(String(logout.headers['set-cookie']),/Max-Age=0/);
    assert.equal((await get('/self',sessions[0]!.headers)).statusCode,401);
    await observer.query("UPDATE loom.participant_credentials SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1",[sessions[1]!.credential_id]);
    assert.equal((await get('/self',sessions[1]!.headers)).statusCode,401);
    const active = await login(firstKey.key); assert.equal((await get('/self',active.headers)).statusCode,200);
    await post('/logout',{},active.headers);
    // Two distinct one-use challenges carry the same authenticator counter.
    // Both signatures are valid; the counter must be rechecked under its SQL lock.
    const starts = await Promise.all([post('/signin/start',{}),post('/signin/start',{})]);
    counters = { id: secondKey.key.id,observed: [],reached: deferred(),release: deferred() };
    const requests = starts.map(begun => {
      const info = begun.json() as { challenge_id: string; options: PublicKeyCredentialRequestOptionsJSON };
      return post('/signin/finish',{ challenge_id: info.challenge_id,response: secondKey.key.assertion(info.options,{ counter: 100 }) },{ origin: policy.origin,cookie: cookieHeader(begun) });
    });
    try { await bounded(counters.reached.promise); assert.deepEqual(counters.observed,['1','1']); }
    finally { counters.release.resolve(); }
    const responses = await Promise.all(requests); counters = undefined;
    assert.deepEqual(responses.map(response => response.statusCode).sort(),[200,401]);
    assert.equal((await observer.query('SELECT counter::text FROM loom.passkeys WHERE credential_id = $1',[secondKey.credential_id])).rows[0].counter,'100');
  });
  await t.test('administrator-assisted human recovery retains the account and fences old passkeys and sessions', async () => {
    const account = await admit('HumanRecovery','human');
    const ticket = await issue(issuance(account.participant_id,'enrollment','enroll'));
    const enrolled = await enroll(ticket.secret!), oldSession = await login(enrolled.key);
    const recoveryRequest = issuance(account.participant_id,'enrollment','recover'), recovery = await issue(recoveryRequest);
    assert.ok(!('secret' in (await issue(recoveryRequest)).response.json()));
    assert.equal((await get('/self',oldSession.headers)).statusCode,200);
    const replacement = await enroll(recovery.secret!); assert.equal(replacement.participant_id,account.participant_id);
    assert.equal((await get('/self',oldSession.headers)).statusCode,401);
    const recovered = await login(replacement.key); assert.equal(recovered.participant_id,account.participant_id);
    const state = (await observer.query('SELECT id,state FROM loom.participant_credentials WHERE id = ANY($1::uuid[])',[[enrolled.credential_id,oldSession.credential_id]])).rows;
    assert.ok(state.every(row => row.state === 'revoked'));
    assert.equal((await observer.query('SELECT enrollment_credential_id FROM loom.passkeys WHERE credential_id = $1',[replacement.credential_id])).rows[0].enrollment_credential_id,recovery.credential_id);
  });
  await t.test('current suspension, expiry and revocation govern browser, bearer and already-authenticated publication actors', async () => {
    const agentActor = await authentication.authenticate(agentCredential.secret!,'agent');
    const humanResource = await fixture.resource(human.participant_id), agentResource = await fixture.resource(agent.participant_id);
    const publisher = new PublicationOperation(database);
    for (const [participantId,headers,actor,resource] of [
      [human.participant_id,browser.headers,browser.actor,humanResource], [agent.participant_id,bearer,agentActor,agentResource],
    ] as const) {
      const state = await post('/state',{ idempotency_key: randomUUID(),participant_id: participantId,state: 'suspended',role: 'participant' },administrator.headers); assert.equal(state.statusCode,200);
      assert.equal((await get('/self',headers)).statusCode,401);
      await assert.rejects(publisher.publish(actor,{ idempotency_key: randomUUID(),resource_id: resource.resourceId,expected_revision_id: null,content: { format: 'text/plain',text: 'synthetic protected body' } }),error => error instanceof PublicationError && error.code === 'unavailable');
      const reactivate = await post('/state',{ idempotency_key: randomUUID(),participant_id: participantId,state: 'active',role: 'participant' },administrator.headers); assert.equal(reactivate.statusCode,200);
      assert.equal((await get('/self',headers)).statusCode,200);
    }
    await observer.query("UPDATE loom.participant_credentials SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1",[agentCredential.credential_id]);
    assert.equal((await get('/self',bearer)).statusCode,401);
    await assert.rejects(publisher.publish(agentActor,{ idempotency_key: randomUUID(),resource_id: agentResource.resourceId,expected_revision_id: null,content: { format: 'text/plain',text: 'expired proof' } }),error => error instanceof PublicationError && error.code === 'unavailable');
    const revokeParent = await post('/revoke',{ idempotency_key: randomUUID(),participant_id: human.participant_id,credential_id: humanPasskey.credential_id },administrator.headers); assert.equal(revokeParent.statusCode,200);
    assert.equal((await observer.query('SELECT state FROM loom.participant_credentials WHERE id = $1',[browser.credential_id])).rows[0].state,'revoked');
    assert.equal((await get('/self',browser.headers)).statusCode,401);
    await assert.rejects(publisher.reconcile(browser.actor,randomUUID()),error => error instanceof PublicationError && error.code === 'unavailable');
  });
  await t.test('current role changes apply equally to agent administrators and human sessions; last-administrator guard holds', async () => {
    const account = await admit('AgentAdministrator','agent','administrator');
    const credential = await issue(issuance(account.participant_id)), headers = { authorization: 'Bearer ' + credential.secret! };
    assert.equal((await get('/audit',headers)).statusCode,200);
    const createRequest = { idempotency_key: randomUUID(),nickname: 'ByAgentAdmin',kind: 'agent',role: 'participant' };
    const created = await post('/accounts',createRequest,headers); assert.equal(created.statusCode,200);
    const state = await post('/state',{ idempotency_key: randomUUID(),participant_id: account.participant_id,state: 'active',role: 'participant' },administrator.headers); assert.equal(state.statusCode,200);
    assert.equal((await get('/audit',headers)).statusCode,403);
    assert.equal((await get('/self',headers)).json().role,'participant');
    assert.equal((await post('/reconcile',{ idempotency_key: createRequest.idempotency_key,operation_kind: 'account.create' },headers)).statusCode,403);
    const humanAdmin = await admit('HumanAdministrator','human','administrator');
    const ticket = await issue(issuance(humanAdmin.participant_id,'enrollment','enroll'));
    const key = await enroll(ticket.secret!), session = await login(key.key);
    assert.equal((await get('/audit',session.headers)).statusCode,200);
    const humanRequest = { idempotency_key: randomUUID(),nickname: 'ByHumanAdmin',kind: 'agent',role: 'participant' };
    assert.equal((await post('/accounts',humanRequest,session.headers)).statusCode,200);
    assert.equal((await post('/state',{ idempotency_key: randomUUID(),participant_id: humanAdmin.participant_id,state: 'active',role: 'participant' },administrator.headers)).statusCode,200);
    assert.equal((await get('/audit',session.headers)).statusCode,403);
    assert.equal((await get('/self',session.headers)).json().role,'participant');
    assert.equal((await post('/reconcile',{ idempotency_key: humanRequest.idempotency_key,operation_kind: 'account.create' },session.headers)).statusCode,403);
    await assert.rejects(administration.listAccounts(session.actor),fail('forbidden'));
    for (const desired of [{ state: 'suspended',role: 'administrator' },{ state: 'revoked',role: 'administrator' },{ state: 'active',role: 'participant' }]) {
      const denied = await post('/state',{ idempotency_key: randomUUID(),participant_id: firstAdministrator,...desired },administrator.headers); assert.equal(denied.statusCode,409); assert.equal(denied.json().error.code,'last_administrator');
    }
  });
  await t.test('failed admission and issuance roll back account, reservation, credential, outcome and audit together', async () => {
    const counts = async () => (await observer.query(`SELECT ARRAY[(SELECT count(*) FROM loom.participants),
      (SELECT count(*) FROM loom.nickname_reservations),(SELECT count(*) FROM loom.participant_credentials),
      (SELECT count(*) FROM loom.identity_outcomes),(SELECT count(*) FROM loom.administrative_audit)]::integer[] AS counts`)).rows[0].counts;
    const before = await counts(); rollbackKind = 'account.create';
    const request = { idempotency_key: randomUUID(),nickname: 'RollbackAccount',kind: 'agent',role: 'participant' };
    assert.equal((await post('/accounts',request,administrator.headers)).statusCode,503);
    assert.deepEqual(await counts(),before);
    const account = await admit('RollbackCredential'); const after = await counts(); rollbackKind = 'credential.issue';
    const credentialRequest = issuance(account.participant_id);
    assert.equal((await post('/credentials',credentialRequest,administrator.headers)).statusCode,503);
    assert.deepEqual(await counts(),after);
    const absent = await post('/reconcile',{ idempotency_key: credentialRequest.idempotency_key,operation_kind: 'credential.issue' },administrator.headers); assert.deepEqual(absent.json(),{ operation_state: 'not_recorded' });
    assert.ok((await issue(credentialRequest)).secret);
  });
  await t.test('operator recovery binds a new passkey to the same first identity and invalidates old sessions', async () => {
    const freshBootstrap = { ...initialEnrollment,idempotency_key: randomUUID(),replace_credential_id: initialTicket.credential_id! };
    await assert.rejects(administration.deploymentEnrollment(bootstrapCapability,'bootstrap',freshBootstrap),fail('bootstrap_closed'));
    const request = issuance(firstAdministrator,'enrollment','recover');
    await assert.rejects(administration.deploymentEnrollment(bootstrapCapability,'recovery',request),fail('unauthenticated'));
    const issued = await administration.deploymentEnrollment(recoveryCapability,'recovery',request); assert.ok(issued.secret);
    const retry = await administration.deploymentEnrollment(recoveryCapability,'recovery',request); assert.equal(retry.secret,undefined); assert.equal(retry.credential_id,issued.credential_id);
    assert.equal((await get('/self',administrator.headers)).statusCode,200,'Issuing a ticket alone must not revoke the current passkey.');
    const replacement = await enroll(issued.secret); assert.equal(replacement.participant_id,firstAdministrator);
    assert.equal((await get('/self',administrator.headers)).statusCode,401);
    administrator = await login(replacement.key); assert.equal(administrator.participant_id,firstAdministrator);
    assert.equal((await get('/audit',administrator.headers)).statusCode,200);
    const old = await observer.query('SELECT state FROM loom.participant_credentials WHERE id = ANY($1::uuid[])',[ [administratorPasskey.credential_id,initialTicket.credential_id] ]);
    assert.ok(old.rows.every(row => row.state === 'revoked'));
  });
  await t.test('recovery credentials for the same administrator resolve earlier account outcomes in the original scope', async () => {
    const outcome = (await observer.query("SELECT idempotency_key,participant_id,id FROM loom.identity_outcomes WHERE actor_id = $1 AND operation_kind = 'account.create' ORDER BY recorded_at LIMIT 1",[firstAdministrator])).rows[0];
    const recovered = await post('/reconcile',{ idempotency_key: outcome.idempotency_key,operation_kind: 'account.create' },administrator.headers);
    assert.equal(recovered.statusCode,200); assert.equal(recovered.json().participant_id,outcome.participant_id); assert.equal(recovered.json().operation_id,outcome.id);
  });
  await t.test('secrets are confined to fresh issuance or Set-Cookie; DB, outcomes, audit, lists, errors, caches and logs do not disclose them', async () => {
    const account = await admit('SecretProbe'), request = issuance(account.participant_id);
    const first = await issue(request); assert.ok(first.secret); assert.equal(first.response.headers['cache-control'],'no-store');
    const replay = await issue(request); assert.ok(!('secret' in replay.response.json()));
    const secrets = [first.secret,initialTicket.secret!,humanTicket.secret!,agentCredential.secret!,administrator.secret,browser.secret,bootstrapCapability,recoveryCapability];
    const views = await Promise.all([get('/accounts',administrator.headers),get('/audit',administrator.headers),get('/credentials?participant_id=' + account.participant_id,administrator.headers),get('/self',administrator.headers),get('/self',{ authorization: 'Bearer invalid.' + first.secret })]);
    for (const view of views) {
      assert.equal(view.headers['cache-control'],'no-store'); assert.equal(view.headers.vary,'Cookie, Authorization');
      for (const secret of secrets) assert.ok(!view.body.includes(secret));
    }
    const persisted = JSON.stringify((await observer.query(`SELECT 'credentials' AS kind,to_jsonb(c) AS data FROM loom.participant_credentials c
      UNION ALL SELECT 'outcomes',to_jsonb(o) FROM loom.identity_outcomes o
      UNION ALL SELECT 'audit',to_jsonb(a) FROM loom.administrative_audit a
      UNION ALL SELECT 'initialization',to_jsonb(i) FROM loom.identity_initialization i
      UNION ALL SELECT 'challenges',to_jsonb(w) FROM loom.webauthn_challenges w
      UNION ALL SELECT 'passkeys',to_jsonb(p) FROM loom.passkeys p`)).rows);
    for (const secret of secrets) { assert.ok(!persisted.includes(secret)); assert.ok(!diagnostics.includes(secret)); assert.ok(!replay.response.body.includes(secret)); }
    assert.ok(!/loom_(agent|session|enrollment)\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}/.test(persisted + diagnostics));
    assert.ok(diagnostics.includes('identity_request_failed'));
    assert.equal((await observer.query('SELECT verifier FROM loom.participant_credentials WHERE id = $1',[first.credential_id])).rows[0].verifier,verifier(first.secret));
    await assert.rejects(database.transaction(tx => tx.query('DELETE FROM loom.identity_outcomes WHERE id = $1',[first.operation_id])),error => Boolean(error && typeof error === 'object' && 'code' in error && error.code === '42501'));
  });
  await t.test('authentication starts are bounded by the explicit prototype throttle', async () => {
    const limited = new IdentityAuthentication(database,{ ...policy,startsPerMinute: 1 });
    await limited.startSignIn();
    await assert.rejects(limited.startSignIn(),fail('rate_limited'));
  });
});
