import test from 'node:test';
import assert from 'node:assert/strict';
import { composeSpec, caddyfile, subnet, labels } from '../../scripts/lib/staging-compose.mjs';
import { readInstance as pilotInstance } from '../../scripts/lib/pilot-files.mjs';
import { readInstance } from '../../scripts/lib/staging-files.mjs';
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
test('staging Compose publishes only the designated TLS proxy and references external retained volumes', () => {
  const d = {
      id: 'loom-staging-' + randomUUID(),
      owner: 'a'.repeat(64),
      kind: 'retained',
      path: '/private/staging',
      origin: 'https://loom-staging.example.com',
      release: {
        image: 'sha256:immutable',
        images: { postgres: 'pg@sha256:p', seaweed: 's3@sha256:s', caddy: 'caddy@sha256:c' },
      },
    },
    c = { subnet: '172.30.42.0/24', quarantine: false };
  const spec = composeSpec(d, c);
  assert.deepEqual(
    Object.entries(spec.services)
      .filter(([, v]) => v.ports)
      .map(([k]) => k),
    ['proxy'],
  );
  assert.deepEqual(
    spec.services.proxy.ports.map((p) => p.target),
    [443, 80],
  );
  assert.ok(Object.values(spec.volumes).every((v) => v.external));
  assert.ok(Object.values(spec.networks).every((v) => v.external));
  assert.deepEqual(spec.services.api.networks, { network: { ipv4_address: '172.30.42.3' } });
  assert.deepEqual(spec.services.proxy.networks, {
    network: { ipv4_address: '172.30.42.2' },
    edge: {},
  });
  assert.ok(!JSON.stringify(spec).includes('docker.sock'));
  assert.equal(labels(d)['org.loom.local-pilot'], undefined);
  const proxy = caddyfile(d, c);
  assert.match(proxy, /https:\/\/loom-staging.example.com/);
  assert.match(proxy, /strict_sni_host on/);
  assert.match(proxy, /admin off/);
  for (const h of [
    'Forwarded',
    'X-Forwarded-For',
    'X-Forwarded-Host',
    'X-Forwarded-Proto',
    'X-Forwarded-Port',
    'X-Real-IP',
  ])
    assert.ok(proxy.includes('header ' + h + ' *'));
  assert.ok(!proxy.includes('tls /custody'));
  const dual = composeSpec(d, { ...c, ipv6: true });
  assert.deepEqual(
    dual.services.proxy.ports.map((p) => [p.host_ip, p.published, p.target]),
    [
      ['0.0.0.0', '443', 443],
      ['0.0.0.0', '80', 80],
      ['::', '443', 443],
      ['::', '80', 80],
    ],
  );
  assert.ok(
    Object.entries(dual.services).every(
      ([service, config]) => service === 'proxy' || !config.ports,
    ),
  );
  const quarantine = composeSpec(
    { ...d, origin: 'https://loom-staging.test:3445' },
    { ...c, quarantine: true, ipv6: true },
  );
  assert.deepEqual(
    quarantine.services.proxy.ports.map((p) => p.host_ip),
    ['127.0.0.1'],
  );

  for (const value of [
    '8.8.8.0/24',
    '127.0.0.0/24',
    '172.99.0.0/24',
    '10.999.0.0/24',
    '172.30.0.0/16',
  ])
    assert.throws(() => subnet(value));
});
test('staging and pilot selectors refuse one another even with otherwise valid owner custody', (t) => {
  const path = mkdtempSync(join(realpathSync(tmpdir()), 'loom-staging-selector-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  const d = {
    format: 'loom-vps-staging-1',
    state: 'initializing',
    id: 'loom-staging-' + randomUUID(),
    owner: 'a'.repeat(64),
    path,
    uid: process.getuid(),
    policy: 'vps-staging-1',
    kind: 'acceptance',
    testOwner: randomUUID(),
  };
  writeFileSync(join(path, 'instance.json'), JSON.stringify(d), { mode: 0o600 });
  assert.equal(readInstance(path).id, d.id);
  assert.throws(() => pilotInstance(path));
  writeFileSync(
    join(path, 'instance.json'),
    JSON.stringify({
      ...d,
      format: 'loom-local-pilot-1',
      id: 'loom-pilot-' + randomUUID(),
      policy: 'local-pilot-1',
    }),
  );
  assert.throws(() => readInstance(path));
});
