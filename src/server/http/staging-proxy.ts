import type { FastifyRequest } from 'fastify';
import { stagingIdentityPolicy } from '../participation-profile.js';

export type StagingProxy = { origin: string; address: string };
export function validateStagingProxy(proxy: StagingProxy) {
  stagingIdentityPolicy(proxy.origin, 'vps-staging-1');
  if (
    !/^(10\.(?:\d{1,3}\.){2}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.|192\.168\.\d{1,3}\.)2$/.test(
      proxy.address,
    ) ||
    proxy.address.split('.').some((n) => Number(n) > 255)
  )
    throw new Error('Invalid designated staging proxy.');
}
/** The raw peer, fixed authority and single proxy envelope must all agree.
 * Fastify proxy inference stays disabled; container membership grants no authority.
 */
export function stagingRequestAllowed(request: FastifyRequest, proxy: StagingProxy) {
  const peer = request.raw.socket.remoteAddress?.replace(/^::ffff:/, '');
  const h = request.headers;
  return (
    peer === proxy.address &&
    h.host === new URL(proxy.origin).host &&
    h['x-forwarded-host'] === h.host &&
    h['x-forwarded-proto'] === 'https' &&
    typeof h['x-forwarded-for'] === 'string' &&
    /^[0-9a-fA-F:.]+$/.test(h['x-forwarded-for']) &&
    h.forwarded === undefined &&
    h['x-forwarded-port'] === undefined &&
    h['x-real-ip'] === undefined &&
    (h.origin === undefined || h.origin === proxy.origin)
  );
}
