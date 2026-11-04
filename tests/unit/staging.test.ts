import test from 'node:test';
import assert from 'node:assert/strict';
import {
  stagingIdentityPolicy,
  requireWorkerProfile,
  syntheticIdentityPolicy,
} from '../../src/server/participation-profile.js';
import { FileStorage } from '../../src/server/modules/participation/file-storage.js';
import { createApplication } from '../../src/server/http/app.js';
import { validateStagingProxy } from '../../src/server/http/staging-proxy.js';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ParticipationServices } from '../../src/server/http/participation.js';

test('public staging HTML carries presentation metadata while existing deployment HTML stays byte-identical', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'loom-staging-html-'));
  const html = '<!doctype html><html><head><title>Loom</title></head><body>Browser</body></html>';
  await mkdir(join(directory, 'assets'));
  await writeFile(join(directory, 'index.html'), html);
  try {
    for (const mode of ['staging', 'local-pilot', 'synthetic-preview', undefined] as const) {
      const participation =
        mode === undefined
          ? undefined
          : ({
              installationMode: mode,
              database: {
                transaction: async () => {
                  throw new Error('HTML must not query SQL.');
                },
              },
              authentication: { policy: { origin: 'https://loom-staging.example.com' } },
              administration: {},
            } as unknown as ParticipationServices);
      const app = await createApplication({
        database: { isReady: async () => true, close: async () => {} },
        logger: false,
        browserRoot: directory,
        participation,
      });
      try {
        for (const url of ['/', '/status', '/loom', '/loom/saved']) {
          const response = await app.inject({ url });
          assert.equal(response.statusCode, 200);
          assert.match(response.headers['content-type']!, /^text\/html/);
          assert.equal(
            response.body,
            mode === 'staging'
              ? html.replace('</head>', '<meta name="loom-deployment" content="staging"></head>')
              : html,
          );
        }
      } finally {
        await app.close();
      }
    }
    await writeFile(join(directory, 'index.html'), '<html>Invalid browser build</html>');
    await assert.rejects(
      createApplication({
        database: { isReady: async () => true, close: async () => {} },
        logger: false,
        browserRoot: directory,
        participation: {
          installationMode: 'staging',
          authentication: { policy: { origin: 'https://loom-staging.example.com' } },
        } as unknown as ParticipationServices,
      }),
      /browser document lacks a head/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test('staging requires its own acknowledgement and exact RP HTTPS domain', () => {
  const p = stagingIdentityPolicy('https://loom-staging.example.com', 'vps-staging-1');
  assert.equal(p.rpId, 'loom-staging.example.com');
  assert.equal(p.maxPasskeys, 2);
  assert.equal(p.enrollmentSeconds, 4 * 60 * 60);
  assert.equal(syntheticIdentityPolicy('https://localhost:3443').enrollmentSeconds, 3600);
  for (const origin of [
    'http://loom-staging.example.com',
    'https://loom-staging.example.com/',
    'https://localhost',
    'https://test.localhost',
    'https://127.0.0.1',
    'https://u:p@loom-staging.example.com',
    'https://loom-staging.example.com/path',
    'https://loom-staging.example.com#x',
  ])
    assert.throws(() => stagingIdentityPolicy(origin, 'vps-staging-1'));
  assert.throws(() => stagingIdentityPolicy('https://loom-staging.example.com', 'local-pilot-1'));
});
test('staging storage admits only its exact private provider without broadening local endpoints', () => {
  const base = {
    accessKeyId: 'test',
    secretAccessKey: 'test',
    stagingBucket: 'test-stage',
    finalBucket: 'test-final',
  };
  const local = new FileStorage({ ...base, endpoint: 'http://127.0.0.1:8333' });
  local.client.destroy();
  const stage = new FileStorage({ ...base, endpoint: 'http://s3:8333', deployment: 'staging' });
  stage.client.destroy();
  for (const endpoint of [
    'http://s3:8333/',
    'http://s3:8333/path',
    'http://user@s3:8333',
    'https://s3:8333',
    'http://s3:80',
    'http://169.254.169.254',
    'http://10.0.0.1:8333',
    'http://example.com:8333',
    'http://127.0.0.1:8333',
  ])
    assert.throws(() => new FileStorage({ ...base, endpoint, deployment: 'staging' }));
  assert.throws(() => new FileStorage({ ...base, endpoint: 'http://s3:8333' }));
});
test('staging HTTP boundary requires designated raw proxy peer and rejects host origin and forwarded spoofing', async () => {
  const proxy = { origin: 'https://loom-staging.example.com', address: '172.30.42.2' };
  for (const address of ['127.0.0.1', '8.8.8.2', '172.300.42.2'])
    assert.throws(() => validateStagingProxy({ ...proxy, address }));
  const app = await createApplication({
    database: { isReady: async () => true, close: async () => {} },
    logger: false,
    stagingProxy: proxy,
  });
  const headers = {
    host: 'loom-staging.example.com',
    'x-forwarded-host': 'loom-staging.example.com',
    'x-forwarded-proto': 'https',
    'x-forwarded-for': '203.0.113.4',
  };
  try {
    assert.equal(
      (await app.inject({ url: '/health/ready', remoteAddress: proxy.address, headers }))
        .statusCode,
      200,
    );
    for (const h of [
      { host: 'evil.test' },
      { origin: 'https://evil.test' },
      { 'x-forwarded-proto': 'http' },
      { forwarded: 'host=loom-staging.example.com' },
      { 'x-forwarded-host': 'loom-staging.example.com,evil.test' },
      { 'x-forwarded-port': '443' },
      { 'x-real-ip': '127.0.0.1' },
      { 'x-forwarded-for': '127.0.0.1,203.0.113.4' },
    ])
      assert.equal(
        (
          await app.inject({
            url: '/health/ready',
            remoteAddress: proxy.address,
            headers: { ...headers, ...h },
          })
        ).statusCode,
        400,
      );
    assert.equal(
      (await app.inject({ url: '/health/ready', remoteAddress: '172.30.42.9', headers }))
        .statusCode,
      400,
    );
  } finally {
    await app.close();
  }
});

test('worker profile preserves synthetic execution and fails closed for incomplete staging opt-in', () => {
  requireWorkerProfile({ LOOM_PARTICIPATION_PROFILE: 'synthetic' });
  requireWorkerProfile({
    LOOM_PARTICIPATION_PROFILE: 'staging',
    LOOM_ORIGIN: 'https://loom-staging.example.com',
    LOOM_STAGING_ACKNOWLEDGE: 'vps-staging-1',
  });
  for (const env of [
    {},
    { LOOM_PARTICIPATION_PROFILE: 'production' },
    { LOOM_PARTICIPATION_PROFILE: 'staging' },
    { LOOM_PARTICIPATION_PROFILE: 'staging', LOOM_ORIGIN: 'https://loom-staging.example.com' },
  ])
    assert.throws(() => requireWorkerProfile(env));
});
