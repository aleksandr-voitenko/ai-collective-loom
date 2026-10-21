import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

export type OpaqueKind = 'agent' | 'session' | 'enrollment';
export function verifier(value: string) {
  return createHash('sha256').update(value).digest('hex');
}
export function matches(value: string, digest: string) {
  return (
    /^[0-9a-f]{64}$/.test(digest) &&
    timingSafeEqual(Buffer.from(verifier(value), 'hex'), Buffer.from(digest, 'hex'))
  );
}
export function opaqueToken(kind: OpaqueKind) {
  const id = randomUUID();
  const secret = `loom_${kind}.${id}.${randomBytes(32).toString('base64url')}`;
  return { id, secret, verifier: verifier(secret) };
}
export function tokenId(secret: string, kind: OpaqueKind): string | undefined {
  const match = new RegExp(
    '^loom_' +
      kind +
      '\\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\\.([A-Za-z0-9_-]{43})$',
  ).exec(secret);
  return match && Buffer.from(match[2]!, 'base64url').toString('base64url') === match[2]
    ? match[1]
    : undefined;
}
export function browserBinding() {
  return randomBytes(32).toString('base64url');
}
export function deploymentCapability(value: string) {
  return (
    /^[A-Za-z0-9_-]{43}$/.test(value) &&
    Buffer.from(value, 'base64url').toString('base64url') === value
  );
}
export function csrfValue(session: string) {
  return createHmac('sha256', session).update('loom.session.csrf.v1').digest('base64url');
}
export function validCsrf(session: string, csrf: string | undefined) {
  const expected = csrfValue(session);
  return (
    typeof csrf === 'string' &&
    /^[A-Za-z0-9_-]{43}$/.test(csrf) &&
    timingSafeEqual(Buffer.from(csrf), Buffer.from(expected))
  );
}
