import { spawnSync } from 'node:child_process';
import { randomUUID, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  policy,
  hash,
  fail,
  run,
  docker,
  privatePath,
  readJson,
  json,
  replace,
  readInstance,
  lock,
  recoverLock,
  writePrivate,
  quarantineCertificate,
} from './staging-files.mjs';
import {
  services,
  containers,
  volumes,
  networks,
  name,
  labels,
  labelArgs,
  subnet,
  composeSpec,
  caddyfile,
  caddyImage,
} from './staging-compose.mjs';
import {
  engine as localEngine,
  resourceExists,
  matchesReleaseFiles,
  snapshotRelease as freeze,
  until,
  availablePort,
} from './pilot.mjs';
import { readMigrations, migrationSql } from './migrations.mjs';
import { request as https } from 'node:https';
export {
  services,
  containers,
  volumes,
  networks,
  name,
  resourceExists,
  matchesReleaseFiles,
  until,
  availablePort,
};
export const scope = 'Invitation-only non-sensitive VPS staging; no production or sensitive data.';
export function engine() {
  const e = localEngine();
  run('docker', ['compose', 'version']);
  return e;
}
export function doctor() {
  return {
    ...engine(),
    scope,
    policy,
    node: process.version,
    compose: docker(['compose', 'version', '--short']),
  };
}
export function snapshotRelease(path) {
  const release = freeze(path, { additionalRuntimeFiles: ['staging-runtime.mjs'] });
  release.images.caddy = caddyImage;
  return release;
}
export function owned(d, kind, target) {
  const value = JSON.parse(docker([kind, 'inspect', target]))[0],
    actual = value.Config?.Labels ?? value.Labels;
  if (Object.entries(labels(d)).some(([k, v]) => actual?.[k] !== v))
    fail('resource ownership mismatch');
  return value;
}
export function validateRelease(d) {
  if (
    !matchesReleaseFiles(join(d.path, 'release'), d.release) ||
    JSON.parse(docker(['image', 'inspect', d.release.image]))[0].Id !== d.release.image
  )
    fail('selected release changed or missing');
}
export function configuration(d) {
  const c = readJson(join(d.path, 'config.json'));
  const u = new URL(c.origin);
  if (
    c.format !== policy ||
    c.instance !== d.id ||
    c.origin !== d.origin ||
    u.origin !== c.origin ||
    u.protocol !== 'https:' ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(u.hostname) ||
    u.hostname.endsWith('.localhost') ||
    c.rpId !== u.hostname ||
    c.release?.sha256 !== d.release?.sha256 ||
    c.database !== d.database ||
    !c.bootstrap ||
    !c.recovery ||
    c.bootstrap === c.recovery ||
    !c.passwords?.POSTGRES_PASSWORD ||
    !c.storage?.secretAccessKey ||
    c.subnet !== d.subnet ||
    c.quarantine !== d.quarantine ||
    (c.ipv6 ?? false) !== (d.ipv6 ?? false) ||
    (c.ipv6 !== undefined && typeof c.ipv6 !== 'boolean') ||
    (!c.quarantine && (u.port || c.tls?.ca || c.transport))
  )
    fail('missing or incompatible staging configuration');
  subnet(c.subnet);
  if (
    hash(
      JSON.stringify({
        passwords: c.passwords,
        storage: c.storage,
        bootstrap: c.bootstrap,
        recovery: c.recovery,
      }),
    ) !== d.secretsFingerprint
  )
    fail('configuration custody changed');
  return c;
}
export function providerConfiguration(c) {
  return {
    'postgres.env':
      Object.entries({
        ...c.passwords,
        POSTGRES_DB: c.database,
        POSTGRES_USER: 'postgres',
        POSTGRES_INITDB_ARGS: '--auth-host=scram-sha-256',
      })
        .map(([k, v]) => k + '=' + v)
        .join('\n') + '\n',
    'storage.env': `AWS_ACCESS_KEY_ID=${c.storage.accessKeyId}\nAWS_SECRET_ACCESS_KEY=${c.storage.secretAccessKey}\n`,
  };
}
function runtime(c) {
  return {
    profile: 'staging',
    acknowledge: policy,
    instance: c.instance,
    origin: c.origin,
    rpId: c.rpId,
    proxyAddress: subnet(c.subnet) + '2',
    database: c.database,
    appPassword: c.passwords.LOOM_PG_APP_PASSWORD,
    storage: c.storage,
  };
}
export function saveConfiguration(d, c) {
  replace(join(d.path, 'config.json'), c);
  replace(join(d.path, 'runtime.json'), runtime(c));
  replace(join(d.path, 'compose.json'), composeSpec(d, c));
  // These paths remain stable bind mounts; replacement occurs only while stopped.
  replaceText(join(d.path, 'Caddyfile'), caddyfile(d, c));
  if (c.quarantine) {
    replaceText(join(d.path, 'ca.pem'), c.tls.ca);
    replaceText(join(d.path, 'tls.pem'), c.tls.cert);
    replaceText(join(d.path, 'tls.key'), c.tls.key);
  }
}
function replaceText(path, text) {
  if (existsSync(path)) {
    writeFileSync(path, text, { mode: 0o600, flush: true });
  } else writePrivate(path, text);
}
export function createResources(d, c) {
  for (const [kind, items] of [
    ['volume', volumes],
    ['network', networks],
  ])
    for (const s of items) if (resourceExists(kind, name(d, s))) fail('resource collision');
  for (const s of volumes) docker(['volume', 'create', ...labelArgs(d), name(d, s)]);
  docker([
    'network',
    'create',
    ...labelArgs(d),
    '--internal',
    '--subnet',
    c.subnet,
    name(d, 'network'),
  ]);
  docker(['network', 'create', ...labelArgs(d), name(d, 'edge')]);
}
function compose(d, args) {
  return docker([
    'compose',
    '--project-name',
    d.id,
    '--file',
    join(d.path, 'compose.json'),
    ...args,
  ]);
}
export function topology(d) {
  const c = configuration(d),
    spec = composeSpec(d, c);
  for (const n of networks) {
    const v = owned(d, 'network', name(d, n));
    if (
      v.Driver !== 'bridge' ||
      v.Internal !== (n === 'network') ||
      (n === 'network' && v.IPAM.Config[0]?.Subnet !== c.subnet)
    )
      fail('unexpected staging network');
    for (const id of Object.keys(v.Containers ?? {})) {
      const member = JSON.parse(docker(['container', 'inspect', id]))[0];
      if (!containers.some((s) => name(d, s) === member.Name.slice(1)))
        fail('foreign staging network member');
    }
  }
  for (const service of containers) {
    if (!resourceExists('container', name(d, service))) continue;
    const v = owned(d, 'container', name(d, service)),
      expected = spec.services[service];
    if (
      !v.HostConfig.ReadonlyRootfs ||
      v.HostConfig.Privileged ||
      v.HostConfig.RestartPolicy.Name !== 'no' ||
      v.HostConfig.NetworkMode === 'host' ||
      v.Config.Image !== expected.image ||
      !isDeepStrictEqual(v.Config.Cmd, expected.command)
    )
      fail('unexpected staging container privileges or release');
    if (service === 'proxy') {
      const normalize = (caps) => (caps ?? []).map((cap) => cap.replace(/^CAP_/, '')).sort();
      if (
        !isDeepStrictEqual(normalize(v.HostConfig.CapAdd), normalize(expected.cap_add)) ||
        !isDeepStrictEqual(normalize(v.HostConfig.CapDrop), normalize(expected.cap_drop))
      )
        fail('unexpected proxy capabilities');
    }
    const actualPorts = Object.entries(v.HostConfig.PortBindings ?? {})
      .flatMap(([target, bindings]) =>
        bindings.map((b) => [Number(target.split('/')[0]), b.HostIp, b.HostPort]),
      )
      .sort();
    const expectedPorts = (expected.ports ?? [])
      .map((p) => [p.target, p.host_ip, p.published])
      .sort();
    if (!isDeepStrictEqual(actualPorts, expectedPorts)) fail('unexpected staging public listener');
    const actualMounts = v.Mounts.map((m) => [
      m.Type,
      m.Type === 'volume' ? m.Name : m.Source.replace(/^\/host_mnt(?=\/)/, ''),
      m.Destination,
      m.RW,
    ]).sort();
    const expectedMounts = expected.volumes
      .map((m) => [
        m.type,
        m.type === 'volume' ? name(d, m.source) : m.source,
        m.target,
        !m.read_only,
      ])
      .sort();
    // Engine tmpfs mounts may be included in inspect; persistence/binds remain exact.
    if (
      !isDeepStrictEqual(
        actualMounts.filter((m) => m[0] !== 'tmpfs'),
        expectedMounts,
      )
    )
      fail('unexpected staging custody mount');
    const actualNetworks = Object.keys(v.NetworkSettings.Networks).sort(),
      expectedNetworks = Object.keys(expected.networks)
        .map((n) => name(d, n))
        .sort();
    if (!isDeepStrictEqual(actualNetworks, expectedNetworks))
      fail('unexpected staging container network');
    const desired = expected.networks.network.ipv4_address;
    if (v.State.Running && v.NetworkSettings.Networks[name(d, 'network')].IPAddress !== desired)
      fail('designated proxy or provider address changed');
  }
  for (const s of volumes) {
    owned(d, 'volume', name(d, s));
    const consumers = docker([
      'container',
      'ls',
      '--all',
      '--filter',
      'volume=' + name(d, s),
      '--format',
      '{{.Names}}',
    ])
      .split('\n')
      .filter(Boolean);
    const expected = name(d, s === 'postgres-data' ? 'postgres' : s === 's3-data' ? 's3' : 'proxy');
    if (consumers.some((n) => n !== expected)) fail('foreign staging volume consumer');
  }
}
export function preflight(d) {
  if (!isDeepStrictEqual(engine(), d.engine)) fail('Docker context or platform changed');
  const c = configuration(d);
  validateRelease(d);
  for (const [file, expected] of Object.entries(providerConfiguration(c)))
    if (readFileSync(privatePath(join(d.path, file)), 'utf8') !== expected)
      fail('provider configuration changed');
  if (
    !isDeepStrictEqual(readJson(join(d.path, 'runtime.json')), runtime(c)) ||
    !isDeepStrictEqual(readJson(join(d.path, 'compose.json')), composeSpec(d, c)) ||
    readFileSync(privatePath(join(d.path, 'Caddyfile')), 'utf8') !== caddyfile(d, c)
  )
    fail('staging deployment configuration changed');
  if (
    c.quarantine &&
    (readFileSync(privatePath(join(d.path, 'tls.pem')), 'utf8') !== c.tls.cert ||
      readFileSync(privatePath(join(d.path, 'tls.key')), 'utf8') !== c.tls.key)
  )
    fail('quarantine certificate custody changed');
  topology(d);
  return c;
}
export function maintenanceArgs(d) {
  if (resourceExists('container', name(d, 'maintenance')))
    fail('maintenance operation remains; inspect interrupted command');
  return [
    'run',
    '--rm',
    '--name',
    name(d, 'maintenance'),
    ...labelArgs(d),
    '--read-only',
    '--restart',
    'no',
    '--log-driver',
    'none',
  ];
}
const enrollmentHandoff = `try {
 const fs=await import('node:fs'),directory=fs.statSync('/output');
 if(!directory.isDirectory() || (directory.mode&0o777)!==0o700) throw new Error();
 await import('./scripts/lib/staging-runtime.mjs');
 const fd=fs.openSync('/output/enrollment.json',fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try {const f=fs.fstatSync(fd); if(!f.isFile()||f.nlink!==1||(f.mode&0o777)!==0o600||f.size>4096) throw new Error(); fs.fchownSync(fd,directory.uid,directory.gid);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
} catch { process.stderr.write('{"event":"staging_runtime_failed"}\\n');process.exit(1); }`;
export function helper(d, mode, { operator = false, output } = {}) {
  if (output) privatePath(output);
  const result = docker([
    ...maintenanceArgs(d),
    '--network',
    name(d, 'network'),
    '--mount',
    `type=bind,src=${join(d.path, 'runtime.json')},dst=/custody/runtime.json,readonly`,
    ...(operator ? ['--mount', `type=bind,src=${d.path},dst=/operator,readonly`] : []),
    ...(output ? ['--mount', `type=bind,src=${output},dst=/output`] : []),
    d.release.image,
    ...(output
      ? ['node', '--input-type=module', '-e', enrollmentHandoff, 'staging-ticket', mode]
      : ['node', 'scripts/lib/staging-runtime.mjs', mode]),
  ]);
  if (output) {
    const p = privatePath(join(output, 'enrollment.json'));
    if (readFileSync(p).length > 4096) fail('invalid ticket handoff');
  }
  return result;
}
export function sql(d, query, migrate = false) {
  const c = configuration(d);
  owned(d, 'container', name(d, 'postgres'));
  return docker(
    [
      'exec',
      '-i',
      ...(migrate ? ['-e', 'PGPASSWORD'] : []),
      name(d, 'postgres'),
      'psql',
      '-X',
      '-qAt',
      ...(migrate ? ['-h', '127.0.0.1'] : []),
      '-U',
      migrate ? 'loom_migrator' : 'postgres',
      '-d',
      c.database,
      '-v',
      'ON_ERROR_STOP=1',
    ],
    {
      input: query,
      ...(migrate
        ? { env: { ...process.env, PGPASSWORD: c.passwords.LOOM_PG_MIGRATOR_PASSWORD } }
        : {}),
    },
  );
}
export const inventory = (d) => JSON.parse(helper(d, 'inventory', { operator: true }));
export async function providers(d) {
  if (d.everInitialized) {
    for (const [volume, probe] of [
      ['postgres-data', 'test -s /volume/18/docker/PG_VERSION'],
      ['s3-data', 'test -n "$(ls -A /volume)"'],
    ]) {
      owned(d, 'volume', name(d, volume));
      docker([
        ...maintenanceArgs(d),
        '--network',
        'none',
        '--mount',
        `type=volume,src=${name(d, volume)},dst=/volume,readonly`,
        '--entrypoint',
        'sh',
        d.release.images.postgres,
        '-c',
        probe,
      ]);
    }
  }
  for (const v of volumes) owned(d, 'volume', name(d, v));
  for (const n of networks) owned(d, 'network', name(d, n));
  compose(d, ['up', '--detach', '--no-deps', '--pull', 'missing', 'postgres', 's3']);
  await until(() => {
    try {
      return sql(d, 'SELECT 1') === '1';
    } catch {
      return false;
    }
  }, 'database readiness');
  await until(() => {
    try {
      helper(d, 'storage-ready');
      return true;
    } catch {
      return false;
    }
  }, 'native storage readiness');
}
export async function checkHistory(d, { pending = false } = {}) {
  const expected = (await readMigrations(join(d.path, 'release/db/migrations'))).map(
    ({ version, filename, sha256 }) => ({ version, filename, sha256 }),
  );
  const actual = JSON.parse(
    sql(
      d,
      "SELECT coalesce(json_agg(h ORDER BY version),'[]') FROM (SELECT version,filename,sha256 FROM loom_migrations.history) h",
    ),
  );
  if (
    actual.length > expected.length ||
    !isDeepStrictEqual(actual, expected.slice(0, actual.length)) ||
    (!pending && actual.length !== expected.length)
  )
    fail('incompatible or pending migration history; explicit upgrade required');
}
/** Scoped DNS override exists only for private quarantine/acceptance configuration. */
export function httpsCall(origin, cert, path, body, token, transport) {
  return new Promise((resolve, reject) => {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    const req = https(
      new URL(path, origin),
      {
        ca: cert,
        agent: false,
        ...(transport
          ? {
              lookup: (_h, o, cb) =>
                o.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4),
            }
          : {}),
        method: encoded ? 'POST' : 'GET',
        headers: {
          ...(token ? { authorization: 'Bearer ' + token } : {}),
          ...(encoded
            ? {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(encoded),
                origin,
              }
            : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (b) => chunks.push(b));
        res.on('end', () => {
          const data = Buffer.concat(chunks);
          let output;
          try {
            output = JSON.parse(data.toString());
          } catch {
            output = data.toString('base64');
          }
          resolve({ status: res.statusCode, body: output });
        });
      },
    );
    req.setTimeout(20000, () => req.destroy(new Error('HTTPS timeout')));
    req.on('error', reject);
    req.end(encoded);
  });
}
export async function launch(d, service) {
  if (!services.includes(service)) fail('unknown service');
  const c = configuration(d);
  if (service === 'api')
    compose(d, ['up', '--detach', '--no-deps', '--pull', 'missing', 'api', 'proxy']);
  else compose(d, ['up', '--detach', '--no-deps', '--pull', 'missing', service]);
  await until(async () => {
    if (!owned(d, 'container', name(d, service)).State.Running)
      fail(service + ' exited; explicit restart required');
    if (service === 'api') {
      try {
        return (
          (await httpsCall(c.origin, c.tls?.ca, '/health/ready', undefined, undefined, c.transport))
            .status === 200
        );
      } catch {
        return false;
      }
    }
    return safeLogs(d, service).some((x) => x.event === service + '_worker_ready');
  }, service + ' readiness or public TLS certificate');
}
export function stopService(d, service, { clean = false } = {}) {
  const target = name(d, service);
  if (!resourceExists('container', target)) return;
  const v = owned(d, 'container', target);
  if (v.State.Running) docker(['stop', '--time', '60', target]);
  const s = owned(d, 'container', target).State;
  if (s.Running || (clean && (s.ExitCode !== 0 || s.OOMKilled || s.Error)))
    fail(service + ' did not stop cleanly');
}
export function stopAll(d, { clean = false } = {}) {
  for (const s of ['proxy', ...services, 'postgres', 's3']) stopService(d, s, { clean });
}
export function safeLogs(d, service) {
  if (![...services, 'proxy'].includes(service)) fail('logs support API workers or proxy only');
  const container = owned(d, 'container', name(d, service));
  const r = spawnSync(
    'docker',
    ['logs', '--since', container.State.StartedAt, '--tail', '100', name(d, service)],
    {
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 128 * 1024,
    },
  );
  if (r.error || r.status !== 0) fail('bounded logs unavailable');
  const allowed = new Set([
    'staging_api_ready',
    'staging_runtime_failed',
    'search_worker_ready',
    'notifications_worker_ready',
    'file-text_worker_ready',
    'search_worker_tick_failed',
    'notifications_worker_tick_failed',
    'file_text_tick_failed',
    'search_worker_unavailable',
    'notifications_worker_unavailable',
    'file_text_worker_unavailable',
    'database_pool_error',
  ]);
  return (r.stdout + r.stderr).split('\n').flatMap((line) => {
    try {
      const v = JSON.parse(line);
      if (allowed.has(v.event)) return [{ event: v.event }];
      if (service === 'proxy' && ['error', 'warn'].includes(v.level))
        return [
          { event: v.logger?.startsWith('tls') ? 'proxy_tls_failure' : 'proxy_request_failure' },
        ];
      return [];
    } catch {
      return [];
    }
  });
}
export async function status(d) {
  const c = configuration(d),
    result = {
      scope,
      instance: d.id,
      origin: d.origin,
      state: d.state,
      image: d.release.image,
      release: d.release.sha256,
      services: {},
      https: { ready: false, observation: 'not-checked' },
      processing:
        'Inspect authenticated Administration > Operational health; running is not complete processing.',
    };
  for (const s of containers)
    result.services[s] = resourceExists('container', name(d, s))
      ? { state: owned(d, 'container', name(d, s)).State.Status }
      : { state: 'missing' };
  try {
    const r = await httpsCall(
      c.origin,
      c.tls?.ca,
      '/health/ready',
      undefined,
      undefined,
      c.transport,
    );
    result.https = {
      ready: r.status === 200,
      observation: r.status === 200 ? 'validated-tls-and-api-ready' : 'https-api-unavailable',
    };
  } catch (e) {
    result.https.observation =
      {
        CERT_HAS_EXPIRED: 'certificate-expired',
        ERR_TLS_CERT_ALTNAME_INVALID: 'certificate-hostname-mismatch',
        UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'certificate-untrusted',
        DEPTH_ZERO_SELF_SIGNED_CERT: 'certificate-untrusted',
        SELF_SIGNED_CERT_IN_CHAIN: 'certificate-untrusted',
        ENOTFOUND: 'dns-unavailable',
        ECONNREFUSED: 'proxy-unavailable',
      }[e.code] ?? 'tls-or-proxy-unavailable';
  }
  return result;
}
export async function initialize(path, options) {
  if (options.acknowledge !== policy) fail('acknowledge README vps-staging-1 policies explicitly');
  const host = engine(),
    origin = options.origin,
    u = new URL(origin);
  if (
    u.origin !== origin ||
    u.protocol !== 'https:' ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(u.hostname) ||
    u.hostname.endsWith('.localhost') ||
    (!options.testOwner && u.port)
  )
    fail('exact staging HTTPS domain required');
  if (options.ipv6 !== undefined && options.ipv6 !== 'enabled')
    fail('IPv6 selection must be enabled explicitly');
  const range = options.subnet ?? '172.30.42.0/24';
  subnet(range);
  path = privatePath(path, { fresh: true, instance: true, testOwner: options.testOwner });
  if (options.testOwner) await availablePort(Number(u.port));
  else if (
    docker([
      'container',
      'ls',
      '--all',
      '--filter',
      'label=org.loom.vps-staging',
      '--filter',
      'label=org.loom.kind=retained',
      '--format',
      '{{.Names}}',
    ])
  )
    fail('one retained staging instance per VPS required');
  mkdirSync(path, { mode: 0o700 });
  const d = {
    format: 'loom-vps-staging-1',
    id: 'loom-staging-' + randomUUID(),
    owner: randomBytes(32).toString('hex'),
    path,
    uid: process.getuid(),
    kind: options.testOwner ? 'acceptance' : 'retained',
    ...(options.testOwner ? { testOwner: options.testOwner } : {}),
    policy,
    state: 'initializing',
    engine: host,
    origin,
    subnet: range,
    quarantine: Boolean(options.testOwner),
    ipv6: options.ipv6 === 'enabled',
    database: 'loom_' + randomBytes(16).toString('hex'),
  };
  json(join(path, 'instance.json'), d);
  const unlock = lock(d, 'init');
  try {
    d.release = snapshotRelease(path);
    const c = {
      format: policy,
      instance: d.id,
      origin,
      rpId: u.hostname,
      database: d.database,
      subnet: range,
      quarantine: d.quarantine,
      ipv6: d.ipv6,
      release: d.release,
      nickname: options.nickname ?? 'staging_admin',
      bootstrap: randomBytes(32).toString('base64url'),
      recovery: randomBytes(32).toString('base64url'),
      bootstrapKey: randomUUID(),
      enrollmentKey: randomUUID(),
      passwords: Object.fromEntries(
        ['POSTGRES_PASSWORD', 'LOOM_PG_MIGRATOR_PASSWORD', 'LOOM_PG_APP_PASSWORD'].map((k) => [
          k,
          randomBytes(32).toString('hex'),
        ]),
      ),
      storage: {
        accessKeyId: randomBytes(16).toString('hex'),
        secretAccessKey: randomBytes(32).toString('hex'),
        stagingBucket: d.id + '-staging',
        finalBucket: d.id + '-final',
      },
      tls: {},
      ...(d.quarantine ? { transport: { address: '127.0.0.1' } } : {}),
    };
    if (!/^[a-z][a-z0-9_-]{2,31}$/.test(c.nickname)) fail('invalid administrator nickname');
    if (c.quarantine) c.tls = quarantineCertificate(path, u.hostname);
    d.secretsFingerprint = hash(
      JSON.stringify({
        passwords: c.passwords,
        storage: c.storage,
        bootstrap: c.bootstrap,
        recovery: c.recovery,
      }),
    );
    replace(join(path, 'instance.json'), d);
    saveConfiguration(d, c);
    for (const [file, bytes] of Object.entries(providerConfiguration(c)))
      writePrivate(join(path, file), bytes);
    createResources(d, c);
    await providers(d);
    // Persist native custody before migrations or one-time identity provisioning.
    d.everInitialized = true;
    replace(join(path, 'instance.json'), d);
    sql(d, migrationSql(await readMigrations(join(path, 'release/db/migrations'))), true);
    mkdirSync(join(path, 'enrollment'), { mode: 0o700 });
    helper(d, 'provision', { operator: true, output: join(path, 'enrollment') });
    d.state = 'ready';
    replace(join(path, 'instance.json'), d);
    stopAll(d);
    return {
      scope,
      instance: d.id,
      origin,
      state: 'initialized-stopped',
      enrollment: join(path, 'enrollment/enrollment.json'),
    };
  } catch (error) {
    d.state = 'initialization-interrupted';
    replace(join(path, 'instance.json'), d);
    throw error;
  } finally {
    unlock();
  }
}
export async function lifecycle(path, action, options = {}) {
  const d = readInstance(path);
  if (action === 'recover-lock') {
    engine();
    if (resourceExists('container', name(d, 'maintenance'))) fail('maintenance container remains');
    recoverLock(d);
    return { recovered: 'controller lock only' };
  }
  const unlock = lock(d, action);
  try {
    preflight(d);
    if (action === 'doctor' || action === 'status') return status(d);
    if (action === 'logs') return safeLogs(d, options.service ?? 'api');
    if (action === 'stop') {
      stopAll(d);
      return { state: 'stopped', retained: true };
    }
    if (
      existsSync(join(d.path, 'update.json')) &&
      readJson(join(d.path, 'update.json')).phase !== 'selected-stopped'
    )
      fail('interrupted upgrade; explicit resume-upgrade required');
    if (!['ready', 'verified-snapshot'].includes(d.state))
      fail('partial initialization or quarantine; startup refused');
    if (
      ['worker-stop', 'worker-start'].includes(action) &&
      !services.slice(1).includes(options.service)
    )
      fail('unknown worker');
    if (action === 'worker-stop') {
      stopService(d, options.service);
      return { service: options.service, state: 'stopped' };
    }
    if (['restart', 'recreate'].includes(action)) stopAll(d);
    if (action === 'recreate')
      for (const s of containers)
        if (resourceExists('container', name(d, s))) docker(['rm', name(d, s)]);
    if (['start', 'restart', 'recreate', 'worker-start'].includes(action)) {
      try {
        await providers(d);
        await checkHistory(d);
        helper(d, 'ready');
        for (const s of action === 'worker-start' ? [options.service] : services)
          await launch(d, s);
        return status(d);
      } catch (error) {
        stopAll(d);
        throw error;
      }
    }
    fail('unknown staging lifecycle action');
  } finally {
    unlock();
  }
}
