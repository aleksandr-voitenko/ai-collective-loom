import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { isolatedPublicationPostgres } from '../helpers/publication-postgres.js';
import { SoftwareAuthenticator } from '../helpers/software-authenticator.js';
import { createApplication } from '../../src/server/http/app.js';
import { IdentityAdministration } from '../../src/server/modules/identity/administration.js';
import { IdentityAuthentication } from '../../src/server/modules/identity/authentication.js';
import { syntheticIdentityPolicy } from '../../src/server/participation-profile.js';
import { verifier } from '../../src/server/modules/identity/secrets.js';

test(
  'installation cookie namespaces isolate browser custody without changing stored identity, origin or CSRF checks',
  { timeout: 120000 },
  async (t) => {
    const f = await isolatedPublicationPostgres();
    t.after(f.close);
    const policy = syntheticIdentityPolicy('https://localhost:3444'),
      bootstrap = randomBytes(32).toString('base64url');
    const administration = new IdentityAdministration(f.database, policy, {
      bootstrap: verifier(bootstrap),
      recovery: verifier(randomBytes(32).toString('base64url')),
    });
    const authentication = new IdentityAuthentication(f.database, policy);
    const account = await administration.bootstrap(bootstrap, {
      idempotency_key: randomUUID(),
      nickname: 'cookie_owner',
    });
    const ticket = await administration.deploymentEnrollment(bootstrap, 'bootstrap', {
      idempotency_key: randomUUID(),
      participant_id: account.participant_id,
      kind: 'enrollment',
      purpose: 'enroll',
      label: 'Cookie isolation test',
      replace_credential_id: null,
    });
    async function application(cookieNamespace: string) {
      const app = await createApplication({
        database: { isReady: () => f.database.isReady(), close: async () => {} },
        logger: false,
        participation: {
          database: f.database,
          administration,
          authentication,
          cookieNamespace,
        },
      });
      t.after(() => app.close());
      return app;
    }
    const app = await application('installation-one'),
      other = await application('installation-two');
    const route = '/api/v1/identity',
      headers = { origin: policy.origin },
      key = new SoftwareAuthenticator(policy.origin);
    const cookie = (response: any) => {
      const value = String(response.headers['set-cookie']);
      assert.ok(/; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=/.test(value));
      return value.split(';')[0]!;
    };
    const start = await app.inject({
      method: 'POST',
      url: route + '/register/start',
      payload: { ticket: ticket.secret },
      headers,
    });
    assert.equal(start.statusCode, 200);
    assert.ok(cookie(start).startsWith('__Host-loom-installation-one-challenge='));
    const registration = await app.inject({
      method: 'POST',
      url: route + '/register/finish',
      payload: {
        challenge_id: start.json().challenge_id,
        response: key.registration(start.json().options),
      },
      headers: { ...headers, cookie: cookie(start) },
    });
    assert.equal(registration.statusCode, 200);
    const challenge = await app.inject({
      method: 'POST',
      url: route + '/signin/start',
      payload: {},
      headers,
    });
    const signed = await app.inject({
      method: 'POST',
      url: route + '/signin/finish',
      payload: {
        challenge_id: challenge.json().challenge_id,
        response: key.assertion(challenge.json().options),
      },
      headers: { ...headers, cookie: cookie(challenge) },
    });
    assert.equal(signed.statusCode, 200);
    const session = cookie(signed);
    assert.ok(session.startsWith('__Host-loom-installation-one-session='));
    const self = await app.inject({ url: route + '/self', headers: { cookie: session } });
    assert.equal(self.statusCode, 200);
    assert.equal(self.json().participant_id, account.participant_id);
    assert.equal(
      (await other.inject({ url: route + '/self', headers: { cookie: session } })).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          url: route + '/self',
          headers: { cookie: session.replace('installation-one-', '') },
        })
      ).statusCode,
      401,
    );
    const restarted = await application('installation-one');
    assert.equal(
      (await restarted.inject({ url: route + '/self', headers: { cookie: session } })).json()
        .participant_id,
      account.participant_id,
    );
    for (const proof of [
      { origin: policy.origin },
      { origin: 'https://localhost:3445', 'x-loom-csrf': self.json().csrf },
    ])
      assert.equal(
        (
          await restarted.inject({
            method: 'POST',
            url: route + '/logout',
            payload: {},
            headers: { cookie: session, ...proof },
          })
        ).statusCode,
        401,
      );
    const logged = await restarted.inject({
      method: 'POST',
      url: route + '/logout',
      payload: {},
      headers: { ...headers, cookie: session, 'x-loom-csrf': self.json().csrf },
    });
    assert.equal(logged.statusCode, 200);
    assert.ok(cookie(logged).startsWith('__Host-loom-installation-one-session='));
    assert.ok(/Max-Age=0/.test(String(logged.headers['set-cookie'])));
    assert.equal(
      (await app.inject({ url: route + '/self', headers: { cookie: session } })).statusCode,
      401,
    );
  },
);
