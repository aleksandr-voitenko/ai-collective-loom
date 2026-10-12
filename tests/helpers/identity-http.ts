import { Type, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ActorContext } from '../../src/server/modules/publication/actor.js';
import { createApplication } from '../../src/server/http/app.js';
import { classifyError } from '../../src/server/http/errors.js';
import type { DatabaseHealth } from '../../src/server/db/postgres.js';
import { IdentityAdministration } from '../../src/server/modules/identity/administration.js';
import { IdentityAuthentication } from '../../src/server/modules/identity/authentication.js';
import { AccountInput, AuthenticationOptionsResponse, IssueInput, LifecycleInput, ReconcileInput, RegisterFinish, RegisterStart, RegistrationOptionsResponse, RenameInput, RevokeInput, SignInFinish, Uuid } from '../../src/server/modules/identity/contracts.js';
import { IdentityError } from '../../src/server/modules/identity/errors.js';
import { csrfValue, validCsrf } from '../../src/server/modules/identity/secrets.js';

const closed = { additionalProperties: false };
const Empty = Type.Object({}, closed);
const Result = Type.Object({ operation_state: Type.Literal('committed'), idempotency: Type.Union([Type.Literal('created'), Type.Literal('replayed')]),
  operation_id: Uuid, participant_id: Uuid, credential_id: Type.Optional(Uuid),
  credential_state: Type.Optional(Type.Union([Type.Literal('active'), Type.Literal('revoked'), Type.Literal('expired')])),
  recovery: Type.Optional(Type.Literal('revoke_and_replace')) }, closed);
const Issuance = Type.Object({ ...Result.properties, secret: Type.Optional(Type.String()) }, closed);
const ErrorOutput = Type.Object({ error: Type.Object({ code: Type.String(), message: Type.String(), request_id: Uuid }, closed) }, closed);
const errors = Object.fromEntries([400,401,403,404,409,413,415,429,500,503].map(code => [code, ErrorOutput]));
const base = '/prototype/identity';
function cookie(secret: string, name: 'session' | 'challenge', seconds: number) {
  return `__Host-loom-${name}=${secret}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${seconds}`;
}
function cookies(request: FastifyRequest) {
  const found: Record<string, string> = {};
  for (const part of (request.headers.cookie ?? '').split(';').filter(Boolean)) {
    const equal = part.indexOf('='), key = part.slice(0, equal).trim(), value = part.slice(equal + 1);
    if (equal < 1 || key in found) throw new IdentityError('unauthenticated');
    found[key] = value;
  }
  return found;
}

/** Private transport fixture. main.ts cannot register these routes or operators. */
export async function identityHttp(options: { database: DatabaseHealth; administration: IdentityAdministration; authentication: IdentityAuthentication; diagnostics?: import('node:stream').Writable }) {
  const app: FastifyInstance = await createApplication({ database: options.database, logger: options.diagnostics ? { stream: options.diagnostics } : false });
  await app.register(async app => {
  const { authentication: auth, administration: admin } = options;
  app.setErrorHandler((error, request, reply) => {
    if (!(error instanceof IdentityError)) {
      const failure = classifyError(error,request.id);
      if (failure.status >= 500) request.log.error({ event: 'identity_request_failed', request_id: request.id, code: failure.body.error.code },failure.body.error.message);
      return reply.code(failure.status).send(failure.body);
    }
    const failure = error;
    if (failure.status >= 500) request.log.error({ event: 'identity_request_failed', request_id: request.id, code: failure.code }, failure.message);
    return reply.code(failure.status).send({ error: { code: failure.code, message: failure.message, request_id: request.id } });
  });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('vary', 'Cookie, Authorization');
    const ceremony = /^\/prototype\/identity\/(register|signin)\/(start|finish)(\?|$)/.test(request.url);
    if (ceremony && request.headers.authorization) throw new IdentityError('unauthenticated');
    if (request.url.startsWith(base) && request.method === 'POST' && (ceremony || !request.headers.authorization) && request.headers.origin !== auth.policy.origin) throw new IdentityError('invalid_proof');
  });
  async function actor(request: FastifyRequest) {
    const session = cookies(request)['__Host-loom-session'];
    const authorization = request.headers.authorization;
    if (session && authorization) throw new IdentityError('unauthenticated');
    if (authorization) {
      if (!authorization.startsWith('Bearer ') || request.headers.origin && request.headers.origin !== auth.policy.origin) throw new IdentityError('unauthenticated');
      return auth.authenticate(authorization.slice(7), 'agent');
    }
    if (!session) throw new IdentityError('unauthenticated');
    const resolved = await auth.authenticate(session, 'session');
    if (request.method === 'POST' && (request.headers.origin !== auth.policy.origin || !validCsrf(session, typeof request.headers['x-loom-csrf'] === 'string' ? request.headers['x-loom-csrf'] : undefined))) throw new IdentityError('invalid_proof');
    return resolved;
  }
  function command(path: string, schema: TSchema, action: (actor: ActorContext, body: unknown) => Promise<unknown>, response: TSchema = Result) {
    app.post(base + path, { bodyLimit: 65536, schema: { hide: true, body: schema, querystring: Empty, response: { ...errors, 200: response } } }, async request => action(await actor(request), request.body));
  }
  command('/accounts', AccountInput, (a,b) => admin.createAccount(a,b));
  command('/credentials', IssueInput, (a,b) => admin.issueCredential(a,b), Issuance);
  command('/state', LifecycleInput, (a,b) => admin.setAccountState(a,b));
  command('/rename', RenameInput, (a,b) => admin.renameAccount(a,b));
  command('/revoke', RevokeInput, (a,b) => admin.revokeCredential(a,b));
  command('/reconcile', ReconcileInput, (a,b) => admin.reconcile(a,b), Type.Union([Result, Type.Object({ operation_state: Type.Literal('not_recorded') }, closed)]));
  app.get(base + '/self', { schema: { hide: true, querystring: Empty, response: { ...errors, 200: Type.Object({ participant_id: Uuid, credential_id: Uuid, nickname: Type.String(), kind: Type.String(), role: Type.String(), csrf: Type.Optional(Type.String()) }, closed) } } }, async request => {
    const result = await auth.self(await actor(request));
    const session = cookies(request)['__Host-loom-session'];
    return { ...result, ...(session ? { csrf: csrfValue(session) } : {}) };
  });
  app.get(base + '/accounts', { schema: { hide: true, querystring: Empty, response: { ...errors, 200: Type.Array(Type.Object({ id: Uuid, nickname: Type.String(), kind: Type.String(), role: Type.String(), state: Type.String() }, closed)) } } }, async request => admin.listAccounts(await actor(request)));
  app.get(base + '/audit', { schema: { hide: true, querystring: Empty, response: { ...errors, 200: Type.Array(Type.Object({ id: Uuid, actor_id: Type.Union([Uuid,Type.Null()]), actor_credential_id: Type.Union([Uuid,Type.Null()]), authority: Type.String(), target_id: Uuid, action: Type.String(), operation_id: Uuid, recorded_at: Type.String() }, closed)) } } }, async request => admin.audit(await actor(request)));
  app.get(base + '/credentials', { schema: { hide: true, querystring: Type.Object({ participant_id: Uuid }, closed), response: { ...errors, 200: Type.Array(Type.Object({ id: Uuid, kind: Type.String(), label: Type.String(), state: Type.String(), expires_at: Type.Union([Type.String(),Type.Null()]), created_at: Type.String(), parent_credential_id: Type.Union([Uuid,Type.Null()]) }, closed)) } } }, async request => admin.listCredentials(await actor(request), (request.query as { participant_id: string }).participant_id));
  app.post(base + '/register/start', { schema: { hide: true, body: RegisterStart, querystring: Empty, response: { ...errors, 200: RegistrationOptionsResponse } } }, async (request, reply) => {
    const { binding, ...result } = await auth.startRegistration(request.body);
    if (!Value.Check(RegistrationOptionsResponse,result)) throw new IdentityError('service_unavailable');
    reply.header('set-cookie', cookie(binding, 'challenge', auth.policy.challengeSeconds));
    return result;
  });
  app.post(base + '/register/finish', { bodyLimit: 65536, schema: { hide: true, body: RegisterFinish, querystring: Empty, response: { ...errors, 200: Type.Object({ participant_id: Uuid, credential_id: Uuid, enrollment_state: Type.Literal('bound') }, closed) } } }, async request => auth.finishRegistration(request.body, cookies(request)['__Host-loom-challenge'] ?? ''));
  app.post(base + '/signin/start', { schema: { hide: true, body: Empty, querystring: Empty, response: { ...errors, 200: AuthenticationOptionsResponse } } }, async (_request, reply) => {
    const { binding, ...result } = await auth.startSignIn();
    if (!Value.Check(AuthenticationOptionsResponse,result)) throw new IdentityError('service_unavailable');
    reply.header('set-cookie', cookie(binding, 'challenge', auth.policy.challengeSeconds));
    return result;
  });
  app.post(base + '/signin/finish', { bodyLimit: 65536, schema: { hide: true, body: SignInFinish, querystring: Empty, response: { ...errors, 200: Type.Object({ participant_id: Uuid, credential_id: Uuid }, closed) } } }, async (request, reply) => {
    const { session, ...result } = await auth.finishSignIn(request.body, cookies(request)['__Host-loom-challenge'] ?? '');
    reply.header('set-cookie', cookie(session, 'session', auth.policy.sessionSeconds));
    return result;
  });
  app.post(base + '/logout', { schema: { hide: true, body: Empty, querystring: Empty, response: { ...errors, 200: Type.Object({ session_state: Type.Literal('revoked') }, closed) } } }, async (request,reply) => {
    const result = await auth.logout(await actor(request));
    reply.header('set-cookie',cookie('', 'session', 0));
    return result;
  });
  });
  await app.ready();
  return app;
}
