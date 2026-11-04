import assert from 'node:assert/strict';
import { test } from 'node:test';
import { passkey } from '../../src/web/participation-client.js';

const bytes = (...values: number[]) => Uint8Array.from(values).buffer;
for (const registering of [true, false])
  test(`WebAuthn ${registering ? 'registration' : 'sign-in'} preserves ceremony options and exact proof encoding`, async (t) => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    t.after(() => {
      if (original) Object.defineProperty(globalThis, 'navigator', original);
      else Reflect.deleteProperty(globalThis, 'navigator');
    });
    const requests: { path: string; body: unknown }[] = [];
    const options = {
      challenge: '-_8',
      timeout: 60000,
      rpId: 'loom.example',
      ...(registering
        ? {
            user: { id: 'AQI', name: 'reader', displayName: 'Reader' },
            excludeCredentials: [{ id: 'AwQ', type: 'public-key', transports: ['internal'] }],
          }
        : {
            allowCredentials: [{ id: 'AwQ', type: 'public-key', transports: ['internal'] }],
            userVerification: 'required',
          }),
    };
    t.mock.method(globalThis, 'fetch', async (path: string, init: RequestInit) => {
      requests.push({ path, body: JSON.parse(String(init.body)) });
      return Response.json(path.endsWith('/start') ? { challenge_id: 'challenge', options } : {});
    });
    let received: unknown;
    const credential = {
      id: 'credential',
      rawId: bytes(251, 255),
      getClientExtensionResults: () => ({ credProps: { rk: true } }),
      response: {
        clientDataJSON: bytes(1, 2),
        attestationObject: bytes(3, 4),
        getTransports: () => ['internal'],
        authenticatorData: bytes(5, 6),
        signature: bytes(7, 8),
        userHandle: bytes(9, 10),
      },
    };
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        credentials: {
          create: async (value: unknown) => {
            assert.ok(registering);
            received = value;
            return credential;
          },
          get: async (value: unknown) => {
            assert.ok(!registering);
            received = value;
            return credential;
          },
        },
      },
    });
    await passkey(registering ? 'ticket' : undefined);
    const base = '/api/v1/identity/' + (registering ? 'register' : 'signin');
    assert.deepEqual(received, {
      publicKey: {
        ...options,
        challenge: new Uint8Array([251, 255]),
        ...(registering
          ? {
              user: { id: new Uint8Array([1, 2]), name: 'reader', displayName: 'Reader' },
              excludeCredentials: [
                { id: new Uint8Array([3, 4]), type: 'public-key', transports: ['internal'] },
              ],
            }
          : {
              allowCredentials: [
                { id: new Uint8Array([3, 4]), type: 'public-key', transports: ['internal'] },
              ],
            }),
      },
    });
    assert.deepEqual(requests, [
      { path: base + '/start', body: registering ? { ticket: 'ticket' } : {} },
      {
        path: base + '/finish',
        body: {
          challenge_id: 'challenge',
          response: {
            id: 'credential',
            rawId: '-_8',
            type: 'public-key',
            clientExtensionResults: { credProps: { rk: true } },
            response: registering
              ? { clientDataJSON: 'AQI', attestationObject: 'AwQ', transports: ['internal'] }
              : {
                  clientDataJSON: 'AQI',
                  authenticatorData: 'BQY',
                  signature: 'Bwg',
                  userHandle: 'CQo',
                },
          },
        },
      },
    ]);
  });

test('an incomplete WebAuthn ceremony never sends a finish proof', async (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'navigator', original);
    else Reflect.deleteProperty(globalThis, 'navigator');
  });
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (path: string) => {
    calls.push(path);
    return Response.json({ challenge_id: 'challenge', options: { challenge: 'AQI' } });
  });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { credentials: { get: async () => null } },
  });
  await assert.rejects(passkey(), { message: 'The passkey ceremony was not completed.' });
  assert.deepEqual(calls, ['/api/v1/identity/signin/start']);
});
