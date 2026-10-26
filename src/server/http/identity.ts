import type { Transactions } from '../db/postgres.js';
import { admitRequest } from '../modules/rates/accounting.js';
import { participationRateRoute } from './rate-policy.js';
import { ParticipationError } from '../../contracts/participation.js';
import { Type, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ActorContext } from '../modules/publication/actor.js';
import { IdentityAdministration } from '../modules/identity/administration.js';
import { IdentityAuthentication } from '../modules/identity/authentication.js';
import {
  AccountInput,
  AuthenticationOptionsResponse,
  IssueInput,
  LifecycleInput,
  ReconcileInput,
  RegisterFinish,
  RegisterStart,
  RegistrationOptionsResponse,
  RenameInput,
  RevokeInput,
  SignInFinish,
  Uuid,
} from '../modules/identity/contracts.js';
import { IdentityError } from '../modules/identity/errors.js';
import { csrfValue, validCsrf } from '../modules/identity/secrets.js';
import * as Browsing from '../../contracts/administration.js';

const closed = { additionalProperties: false };
const Empty = Type.Object({}, closed);
const Result = Type.Object(
  {
    operation_state: Type.Literal('committed'),
    idempotency: Type.Union([Type.Literal('created'), Type.Literal('replayed')]),
    operation_id: Uuid,
    participant_id: Uuid,
    credential_id: Type.Optional(Uuid),
    credential_state: Type.Optional(
      Type.Union([Type.Literal('active'), Type.Literal('revoked'), Type.Literal('expired')]),
    ),
    recovery: Type.Optional(Type.Literal('revoke_and_replace')),
  },
  closed,
);
const Issuance = Type.Object(
  { ...Result.properties, secret: Type.Optional(Type.String()) },
  closed,
);
const ErrorOutput = ParticipationError;
const errors = Object.fromEntries(
  [400, 401, 403, 404, 409, 413, 415, 429, 500, 503].map((code) => [code, ErrorOutput]),
);
const base = '/api/v1/identity';
function cookie(secret: string, name: 'session' | 'challenge', seconds: number) {
  return `__Host-loom-${name}=${secret}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${seconds}`;
}
function cookies(request: FastifyRequest) {
  const found: Record<string, string> = {};
  for (const part of (request.headers.cookie ?? '').split(';').filter(Boolean)) {
    const equal = part.indexOf('='),
      key = part.slice(0, equal).trim(),
      value = part.slice(equal + 1);
    if (equal < 1 || key in found) throw new IdentityError('unauthenticated');
    found[key] = value;
  }
  return found;
}

/** Installed only in the explicitly enabled synthetic participation profile. */
export async function registerIdentityRoutes(
  app: FastifyInstance,
  options: {
    database: Transactions;
    administration: IdentityAdministration;
    authentication: IdentityAuthentication;
  },
) {
  const { authentication: auth, administration: admin } = options;
  app.addHook('onRequest', async (request, reply) => {
    reply.header('vary', 'Cookie, Authorization');
    const ceremony = /^\/api\/v1\/identity\/(register|signin)\/(start|finish)(\?|$)/.test(
      request.url,
    );
    if (ceremony && request.headers.authorization) throw new IdentityError('unauthenticated');
    if (
      request.url.startsWith(base) &&
      ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) &&
      (ceremony || !request.headers.authorization) &&
      request.headers.origin !== auth.policy.origin
    )
      throw new IdentityError('invalid_proof');
  });
  async function resolveActor(request: FastifyRequest) {
    const session = cookies(request)['__Host-loom-session'];
    const authorization = request.headers.authorization;
    if (session && authorization) throw new IdentityError('unauthenticated');
    if (authorization) {
      if (
        !authorization.startsWith('Bearer ') ||
        (request.headers.origin && request.headers.origin !== auth.policy.origin)
      )
        throw new IdentityError('unauthenticated');
      return auth.authenticate(authorization.slice(7), 'agent');
    }
    if (!session) throw new IdentityError('unauthenticated');
    const resolved = await auth.authenticate(session, 'session');
    if (
      ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) &&
      (request.headers.origin !== auth.policy.origin ||
        !validCsrf(
          session,
          typeof request.headers['x-loom-csrf'] === 'string'
            ? request.headers['x-loom-csrf']
            : undefined,
        ))
    )
      throw new IdentityError('invalid_proof');
    return resolved;
  }
  const admissions = new WeakMap<FastifyRequest, Promise<void>>();
  async function actor(request: FastifyRequest) {
    const resolved = await resolveActor(request);
    const category = participationRateRoute(request.method, request.routeOptions.url);
    if (!category || category === 'excluded') throw new IdentityError('service_unavailable');
    // Transfers authenticate before accepting bytes and again in their handler.
    // Keep both current-authority checks, but admit the HTTP request only once.
    let admission = admissions.get(request);
    if (!admission) {
      admission = admitRequest(
        options.database,
        resolved,
        category === 'publication' ? 'ordinary_requests' : category,
      );
      admissions.set(request, admission);
    }
    await admission;
    return resolved;
  }
  function command(
    path: string,
    schema: TSchema,
    action: (actor: ActorContext, body: unknown) => Promise<unknown>,
    response: TSchema = Result,
  ) {
    app.post(
      base + path,
      {
        bodyLimit: 65536,
        schema: {
          body: schema,
          querystring: Empty,
          response: { ...errors, 200: response },
        },
      },
      async (request) => action(await actor(request), request.body),
    );
  }
  command('/accounts', AccountInput, (a, b) => admin.createAccount(a, b));
  command('/credentials', IssueInput, (a, b) => admin.issueCredential(a, b), Issuance);
  command('/state', LifecycleInput, (a, b) => admin.setAccountState(a, b));
  command('/rename', RenameInput, (a, b) => admin.renameAccount(a, b));
  command('/revoke', RevokeInput, (a, b) => admin.revokeCredential(a, b));
  command(
    '/reconcile',
    ReconcileInput,
    (a, b) => admin.reconcile(a, b),
    Type.Union([Result, Type.Object({ operation_state: Type.Literal('not_recorded') }, closed)]),
  );
  // POST keeps continuations out of URL logs; these operations are read-only.
  for (const [path, schema, response, action] of [
    [
      '/accounts/query',
      Browsing.AdministrationPageInput,
      Browsing.AccountPage,
      (a: ActorContext, b: unknown) => admin.browsing.accounts(a, b),
    ],
    [
      '/credentials/query',
      Browsing.CredentialPageInput,
      Browsing.CredentialPage,
      (a: ActorContext, b: unknown) => admin.browsing.credentials(a, b),
    ],
    [
      '/audit/query',
      Browsing.AdministrationPageInput,
      Browsing.IdentityAuditPage,
      (a: ActorContext, b: unknown) => admin.browsing.audit(a, b),
    ],
    [
      '/accounts/lookup',
      Browsing.AccountLookupInput,
      Browsing.AdministrativeAccount,
      (a: ActorContext, b: unknown) => admin.browsing.lookup(a, b),
    ],
  ] as const) {
    app.post(
      base + path,
      {
        bodyLimit: 4096,
        schema: {
          operationId: 'administration_' + path.slice(1).replace('/', '_'),
          body: schema,
          querystring: Empty,
          response: { ...errors, 200: response },
        },
      },
      async (request) => action(await actor(request), request.body),
    );
  }
  app.get(
    base + '/self',
    {
      schema: {
        querystring: Empty,
        response: {
          ...errors,
          200: Type.Object(
            {
              participant_id: Uuid,
              credential_id: Uuid,
              nickname: Type.String(),
              kind: Type.String(),
              role: Type.String(),
              csrf: Type.Optional(Type.String()),
            },
            closed,
          ),
        },
      },
    },
    async (request) => {
      const result = await auth.self(await actor(request));
      const session = cookies(request)['__Host-loom-session'];
      return { ...result, ...(session ? { csrf: csrfValue(session) } : {}) };
    },
  );
  app.get(
    base + '/accounts',
    {
      schema: {
        description:
          'Legacy first-100-row array without continuation. Use POST /identity/accounts/query for complete bounded retrieval.',
        querystring: Empty,
        response: {
          ...errors,
          200: Type.Array(
            Type.Object(
              {
                id: Uuid,
                nickname: Type.String(),
                kind: Type.String(),
                role: Type.String(),
                state: Type.String(),
              },
              closed,
            ),
          ),
        },
      },
    },
    async (request) => admin.listAccounts(await actor(request)),
  );
  app.get(
    base + '/audit',
    {
      schema: {
        description:
          'Legacy first-100-row array without continuation. Use POST /identity/audit/query for complete bounded retrieval.',
        querystring: Empty,
        response: {
          ...errors,
          200: Type.Array(
            Type.Object(
              {
                id: Uuid,
                actor_id: Type.Union([Uuid, Type.Null()]),
                actor_credential_id: Type.Union([Uuid, Type.Null()]),
                authority: Type.String(),
                target_id: Uuid,
                action: Type.String(),
                operation_id: Uuid,
                recorded_at: Type.String(),
              },
              closed,
            ),
          ),
        },
      },
    },
    async (request) => admin.audit(await actor(request)),
  );
  app.get(
    base + '/credentials',
    {
      schema: {
        description:
          'Legacy first-100-row array without continuation. Use POST /identity/credentials/query for complete bounded retrieval.',
        querystring: Type.Object({ participant_id: Uuid }, closed),
        response: {
          ...errors,
          200: Type.Array(
            Type.Object(
              {
                id: Uuid,
                kind: Type.String(),
                label: Type.String(),
                state: Type.String(),
                expires_at: Type.Union([Type.String(), Type.Null()]),
                created_at: Type.String(),
                parent_credential_id: Type.Union([Uuid, Type.Null()]),
              },
              closed,
            ),
          ),
        },
      },
    },
    async (request) =>
      admin.listCredentials(
        await actor(request),
        (request.query as { participant_id: string }).participant_id,
      ),
  );
  app.post(
    base + '/register/start',
    {
      schema: {
        body: RegisterStart,
        querystring: Empty,
        response: { ...errors, 200: RegistrationOptionsResponse },
      },
    },
    async (request, reply) => {
      const { binding, ...result } = await auth.startRegistration(request.body);
      if (!Value.Check(RegistrationOptionsResponse, result))
        throw new IdentityError('service_unavailable');
      reply.header('set-cookie', cookie(binding, 'challenge', auth.policy.challengeSeconds));
      return result;
    },
  );
  app.post(
    base + '/register/finish',
    {
      bodyLimit: 65536,
      schema: {
        body: RegisterFinish,
        querystring: Empty,
        response: {
          ...errors,
          200: Type.Object(
            {
              participant_id: Uuid,
              credential_id: Uuid,
              enrollment_state: Type.Literal('bound'),
            },
            closed,
          ),
        },
      },
    },
    async (request) =>
      auth.finishRegistration(request.body, cookies(request)['__Host-loom-challenge'] ?? ''),
  );
  app.post(
    base + '/signin/start',
    {
      schema: {
        body: Empty,
        querystring: Empty,
        response: { ...errors, 200: AuthenticationOptionsResponse },
      },
    },
    async (_request, reply) => {
      const { binding, ...result } = await auth.startSignIn();
      if (!Value.Check(AuthenticationOptionsResponse, result))
        throw new IdentityError('service_unavailable');
      reply.header('set-cookie', cookie(binding, 'challenge', auth.policy.challengeSeconds));
      return result;
    },
  );
  app.post(
    base + '/signin/finish',
    {
      bodyLimit: 65536,
      schema: {
        body: SignInFinish,
        querystring: Empty,
        response: {
          ...errors,
          200: Type.Object({ participant_id: Uuid, credential_id: Uuid }, closed),
        },
      },
    },
    async (request, reply) => {
      const { session, ...result } = await auth.finishSignIn(
        request.body,
        cookies(request)['__Host-loom-challenge'] ?? '',
      );
      reply.header('set-cookie', cookie(session, 'session', auth.policy.sessionSeconds));
      return result;
    },
  );
  app.post(
    base + '/logout',
    {
      schema: {
        body: Empty,
        querystring: Empty,
        response: {
          ...errors,
          200: Type.Object({ session_state: Type.Literal('revoked') }, closed),
        },
      },
    },
    async (request, reply) => {
      const result = await auth.logout(await actor(request));
      reply.header('set-cookie', cookie('', 'session', 0));
      return result;
    },
  );
  return actor;
}
