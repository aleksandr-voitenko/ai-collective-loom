import { spawnSync } from 'node:child_process';
import { randomUUID, randomBytes } from 'node:crypto';
import {
  readFileSync,
  existsSync,
  mkdirSync,
  cpSync,
  readdirSync,
  lstatSync,
  rmSync,
  chmodSync,
} from 'node:fs';
import { join } from 'node:path';
import { platform, arch } from 'node:os';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import {
  root,
  policy,
  hash,
  fail,
  run,
  docker,
  privatePath,
  readPrivateText,
  readJson,
  json,
  replace,
  readInstance,
  lock,
  recoverLock,
  certificate,
  validateTls,
  writePrivate,
} from './pilot-files.mjs';
import { localDockerEndpoint } from './local-config.mjs';
import { readMigrations, migrationSql } from './migrations.mjs';
import { httpsCall } from './recovery.mjs';
import { applicationInputs } from './release-identity.mjs';

export const scope =
  'Local retained evaluation of public/synthetic/non-sensitive material only; no production, sensitive data, or agent execution.';
export const services = ['api', 'search', 'notifications', 'file-text'];
const label = 'org.loom.local-pilot';
export const name = (d, service) => d.id + '-' + service;
export function engine() {
  if (process.version !== 'v24.19.0') fail('Node 24.19.0 required');
  const context = docker(['context', 'show']);
  const endpoint = process.env.DOCKER_CONTEXT
    ? docker(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'])
    : process.env.DOCKER_HOST ||
      docker(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']);
  if (!localDockerEndpoint(endpoint)) fail('local Docker endpoint required');
  const dockerPlatform = docker(['info', '--format', '{{.OSType}}/{{.Architecture}}']);
  if (!['darwin', 'linux'].includes(platform())) fail('unsupported host');
  for (const [tool, args] of [
    ['openssl', ['version']],
    ['gpg', ['--version']],
    ['python3', ['--version']],
  ])
    run(tool, args);
  return { host: platform() + '/' + arch(), context, endpoint, dockerPlatform };
}
export function doctor() {
  return {
    ...engine(),
    scope,
    node: process.version,
    dockerVersion: docker(['version', '--format', '{{.Server.Version}}']),
    prerequisites: {
      openssl: run('openssl', ['version']),
      gpg: run('gpg', ['--version']).split('\n')[0],
      python: run('python3', ['--version']),
    },
    pinnedImages: pins(),
  };
}
export function resourceExists(kind, target) {
  const args = kind === 'container' ? ['container', 'ls', '--all'] : [kind, 'ls'];
  return docker([
    ...args,
    '--filter',
    'name=' + (kind === 'container' ? '^/' : '^') + target + '$',
    '--format',
    kind === 'container' ? '{{.Names}}' : '{{.Name}}',
  ])
    .split('\n')
    .includes(target);
}
export function owned(d, kind, target) {
  const value = JSON.parse(docker([kind, 'inspect', target]))[0];
  const labels = value.Config?.Labels ?? value.Labels;
  if (
    labels?.[label] !== d.owner ||
    labels?.['org.loom.instance'] !== d.id ||
    labels?.['org.loom.kind'] !== d.kind ||
    (d.testOwner && labels?.['org.loom.test-owner'] !== d.testOwner)
  )
    fail('resource ownership mismatch');
  return value;
}
const labels = (d) => [
  '--label',
  label + '=' + d.owner,
  '--label',
  'org.loom.instance=' + d.id,
  '--label',
  'org.loom.kind=' + d.kind,
  ...(d.testOwner ? ['--label', 'org.loom.test-owner=' + d.testOwner] : []),
];
const base = (d) => [
  ...labels(d),
  '--read-only',
  '--restart',
  'no',
  '--log-driver',
  'local',
  '--log-opt',
  'max-size=1m',
  '--log-opt',
  'max-file=2',
];
export function maintenanceArgs(d) {
  const target = name(d, 'maintenance');
  if (resourceExists('container', target))
    fail('maintenance operation remains; inspect interrupted command');
  return ['run', '--rm', '--name', target, ...base(d)];
}
export function configuration(d, { expiredLeaf = false } = {}) {
  const c = readJson(join(d.path, 'config.json'));
  if (
    c.format !== policy ||
    c.instance !== d.id ||
    c.origin !== d.origin ||
    !/^https:\/\/localhost:[0-9]+$/.test(c.origin) ||
    c.rpId !== 'localhost' ||
    c.database !== d.database ||
    c.release?.sha256 !== d.release?.sha256 ||
    c.tls?.caFingerprint !== hash(c.tls?.ca ?? '') ||
    c.tls.caFingerprint !== d.caFingerprint ||
    !c.bootstrap ||
    !c.recovery ||
    c.bootstrap === c.recovery ||
    !c.passwords?.POSTGRES_PASSWORD ||
    !c.storage?.secretAccessKey
  )
    fail('missing or incompatible configuration');
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
  validateTls(c, { allowExpiredLeaf: expiredLeaf });
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
        .map(([key, value]) => key + '=' + value)
        .join('\n') + '\n',
    'storage.env': `AWS_ACCESS_KEY_ID=${c.storage.accessKeyId}\nAWS_SECRET_ACCESS_KEY=${c.storage.secretAccessKey}\n`,
  };
}
export function saveConfiguration(d, c) {
  replace(join(d.path, 'config.json'), c);
  const runtime = {
    instance: c.instance,
    origin: c.origin,
    database: c.database,
    appPassword: c.passwords.LOOM_PG_APP_PASSWORD,
    storage: c.storage,
    tls: { key: c.tls.key, cert: c.tls.cert },
  };
  replace(join(d.path, 'runtime.json'), runtime);
}
export function matchesReleaseFiles(directory, release) {
  try {
    const files = {};
    const visit = (path, relative = '') => {
      for (const entry of readdirSync(path).sort()) {
        const file = join(path, entry),
          name = relative ? relative + '/' + entry : entry;
        const stat = lstatSync(file);
        if (stat.isSymbolicLink()) return false;
        if (stat.isDirectory()) {
          if (!visit(file, name)) return false;
        } else if (stat.isFile()) files[name] = hash(readFileSync(file));
        else return false;
      }
      return true;
    };
    return visit(directory) && isDeepStrictEqual(files, release.files);
  } catch {
    return false;
  }
}
export function validateRelease(d) {
  if (!matchesReleaseFiles(join(d.path, 'release'), d.release))
    fail('selected release changed or missing');
  if (JSON.parse(docker(['image', 'inspect', d.release.image]))[0].Id !== d.release.image)
    fail('selected image missing');
}
export function preflight(d, options) {
  const current = engine();
  if (!isDeepStrictEqual(current, d.engine)) fail('Docker context or platform changed');
  const c = configuration(d, options);
  validateRelease(d);
  for (const s of ['postgres-data', 's3-data']) owned(d, 'volume', name(d, s));
  owned(d, 'network', name(d, 'network'));
  for (const s of ['anchor', 'postgres', 's3', ...services, 'maintenance'])
    if (resourceExists('container', name(d, s))) owned(d, 'container', name(d, s));
  const expectedRuntime = {
    instance: c.instance,
    origin: c.origin,
    database: c.database,
    appPassword: c.passwords.LOOM_PG_APP_PASSWORD,
    storage: c.storage,
    tls: { key: c.tls.key, cert: c.tls.cert },
  };
  if (!isDeepStrictEqual(readJson(join(d.path, 'runtime.json')), expectedRuntime))
    fail('runtime configuration changed');
  for (const file of ['postgres.env', 'storage.env', 'ca.pem']) privatePath(join(d.path, file));
  for (const [file, expected] of Object.entries(providerConfiguration(c)))
    if (readFileSync(join(d.path, file), 'utf8') !== expected)
      fail('provider configuration changed');
  if (readFileSync(join(d.path, 'ca.pem'), 'utf8') !== c.tls.ca)
    fail('CA configuration changed');
  topology(d);
  return c;
}
export function topology(d) {
  const network = owned(d, 'network', name(d, 'network'));
  if (network.Driver !== 'bridge') fail('unexpected network');
  const anchor = resourceExists('container', name(d, 'anchor'))
    ? owned(d, 'container', name(d, 'anchor'))
    : undefined;
  if (anchor) {
    const bindings = anchor.HostConfig.PortBindings;
    if (
      anchor.Config.Image !== d.release.images.node ||
      Object.keys(bindings ?? {}).join() !== '3443/tcp' ||
      bindings['3443/tcp'].length !== 1 ||
      bindings['3443/tcp'][0].HostIp !== '127.0.0.1' ||
      bindings['3443/tcp'][0].HostPort !== new URL(d.origin).port
    )
      fail('unexpected listener');
  }
  for (const id of Object.keys(network.Containers ?? {}))
    if (id !== anchor?.Id) fail('foreign network member');
  for (const service of ['anchor', 'postgres', 's3', ...services]) {
    if (!resourceExists('container', name(d, service))) continue;
    const v = owned(d, 'container', name(d, service));
    if (
      !v.HostConfig.ReadonlyRootfs ||
      v.HostConfig.Privileged ||
      v.HostConfig.RestartPolicy.Name !== 'no'
    )
      fail('unexpected container privileges or restart policy');
    if (
      service !== 'anchor' &&
      (v.HostConfig.NetworkMode !== 'container:' + anchor?.Id ||
        Object.keys(v.HostConfig.PortBindings ?? {}).length)
    )
      fail('unexpected provider namespace');
    const expectedImage =
      service === 'postgres'
        ? d.release.images.postgres
        : service === 's3'
          ? d.release.images.seaweed
          : service === 'anchor'
            ? d.release.images.node
            : d.release.image;
    if (v.Config.Image !== expectedImage) fail('unexpected container release');
    const binds = v.Mounts.filter((m) => m.Type === 'bind').map((m) => [
      d.engine.host.startsWith('darwin/')
        ? m.Source.replace(/^\/host_mnt(?=\/)/, '')
        : m.Source,
      m.Destination,
      m.RW,
    ]);
    const expectedBinds =
      service === 'postgres'
        ? [[join(d.path, 'release/infra/pilot'), '/opt/loom', false]]
        : services.includes(service)
          ? [[join(d.path, 'runtime.json'), '/custody/runtime.json', false]]
          : [];
    if (!isDeepStrictEqual(binds, expectedBinds)) fail('unexpected configuration mount');
    const expectedCommand =
      service === 'anchor'
        ? [
            'node',
            '-e',
            'process.once("SIGTERM",()=>process.exit(0));setInterval(()=>{},2147483647)',
          ]
        : service === 'postgres'
          ? ['/opt/loom/postgres.sh', 'postgres']
          : service === 's3'
            ? ['mini', '-dir=/data', '-s3.port=8333', '-master.telemetry=false']
            : ['node', 'scripts/lib/pilot-runtime.mjs', service];
    if (!isDeepStrictEqual(v.Config.Cmd, expectedCommand)) fail('unexpected service command');
    const writable = v.Mounts.filter((m) => m.RW);
    if (['postgres', 's3'].includes(service)) {
      const volume = name(d, service === 'postgres' ? 'postgres-data' : 's3-data');
      if (
        writable.length !== 1 ||
        writable[0].Name !== volume ||
        writable[0].Destination !== (service === 'postgres' ? '/var/lib/postgresql' : '/data')
      )
        fail('unexpected persistent mount');
    } else if (writable.length) fail('unexpected runtime writable mount');
  }
  for (const [volume, service] of [
    ['postgres-data', 'postgres'],
    ['s3-data', 's3'],
  ]) {
    const consumers = docker([
      'container',
      'ls',
      '--all',
      '--filter',
      'volume=' + name(d, volume),
      '--format',
      '{{.Names}}',
    ])
      .split('\n')
      .filter(Boolean);
    if (consumers.some((c) => c !== name(d, service)))
      fail('foreign persistent volume consumer');
  }
}
export async function availablePort(port) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) fail('port must be 1024–65535');
  const server = createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: '127.0.0.1', port }, resolve);
    });
  } catch {
    fail('configured HTTPS port is occupied; no other port will be selected');
  } finally {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  }
}
function pins() {
  const compose = readFileSync(join(root, 'compose.yaml'), 'utf8');
  return {
    postgres: /image: (postgres:\S+@sha256:[a-f0-9]{64})/.exec(compose)[1],
    seaweed: /image: (chrislusf\/seaweedfs:\S+@sha256:[a-f0-9]{64})/.exec(compose)[1],
    node: JSON.parse(readFileSync(join(root, 'config/recovery.json'))).nodeImage,
  };
}
export function snapshotRelease(path) {
  const built = JSON.parse(readFileSync(join(root, 'dist/release.json'), 'utf8'));
  if (!isDeepStrictEqual(built, applicationInputs(root)))
    fail('application build does not match source; run app build explicitly');
  const releaseRoot = join(path, 'release');
  mkdirSync(releaseRoot, { mode: 0o700 });
  const files = {};
  // A retained release never refers to checkout dist, tests, or fixture launchers.
  for (const entry of [
    'dist',
    'db/migrations',
    'infra/pilot',
    'scripts',
    'config',
    'compose.yaml',
    'package.json',
    'package-lock.json',
    '.nvmrc',
  ]) {
    cpSync(join(root, entry), join(releaseRoot, entry), { recursive: true });
  }
  function visit(directory, relative = '') {
    for (const entry of readdirSync(directory).sort()) {
      const p = join(directory, entry),
        rel = relative ? relative + '/' + entry : entry,
        stat = lstatSync(p);
      if (stat.isSymbolicLink()) fail('release links unsupported');
      if (stat.isDirectory()) {
        chmodSync(p, 0o700);
        visit(p, rel);
      } else {
        chmodSync(p, 0o600);
        files[rel] = hash(readFileSync(p));
      }
    }
  }
  visit(releaseRoot);
  const release = {
    revision: run('git', ['rev-parse', 'HEAD'], { cwd: root }),
    applicationSource: built.sha256,
    sha256: hash(JSON.stringify(files)),
    lockSha256: files['package-lock.json'],
    platform: docker(['info', '--format', '{{.OSType}}/{{.Architecture}}']),
    images: pins(),
    files,
  };
  const context = join(path, 'build');
  mkdirSync(context, { mode: 0o700 });
  try {
    for (const entry of ['dist', 'node_modules', 'package.json'])
      cpSync(join(root, entry), join(context, entry), { recursive: true, dereference: true });
    mkdirSync(join(context, 'scripts/lib'), { recursive: true, mode: 0o700 });
    for (const file of ['pilot-runtime.mjs', 'native-inventory.mjs'])
      cpSync(join(root, 'scripts/lib', file), join(context, 'scripts/lib', file));
    writePrivate(
      join(context, 'Dockerfile'),
      `FROM ${release.images.node}\nWORKDIR /release\nCOPY . /release\nLABEL org.loom.release=${release.sha256}\n`,
    );
    const output = join(path, 'image-id');
    docker(['build', '--network', 'none', '--quiet', '--iidfile', output, context]);
    release.image = readFileSync(output, 'utf8').trim();
    chmodSync(output, 0o600);
    return release;
  } finally {
    rmSync(context, { recursive: true, force: true });
  }
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
// Keep the handoff in the controller so recovery also works with already-selected
// releases. The immutable runtime creates the ticket exclusively; only afterward
// does this wrapper transfer its open inode to the mounted custody directory's
// owner. Passing the host UID would be wrong under Docker Desktop UID translation.
const enrollmentHandoff = `
try {
  const fs = await import('node:fs');
  const directory = fs.statSync('/output');
  if (!directory.isDirectory() || (directory.mode & 0o777) !== 0o700) throw new Error();
  await import('./scripts/lib/pilot-runtime.mjs');
  const fd = fs.openSync('/output/enrollment.json', fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const file = fs.fstatSync(fd);
    if (!file.isFile() || file.nlink !== 1 || (file.mode & 0o777) !== 0o600 || file.size > 4096) throw new Error();
    fs.fchownSync(fd, directory.uid, directory.gid);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
} catch {
  process.stderr.write('{"event":"pilot_runtime_failed","phase":"ticket-handoff"}\\n');
  process.exit(1);
}
`;
export function helper(d, mode, { operator = false, output } = {}) {
  owned(d, 'container', name(d, 'anchor'));
  if (output) {
    privatePath(output);
    if (!operator || !['provision', 'recover'].includes(mode) || !lstatSync(output).isDirectory())
      fail('invalid enrollment output custody');
  }
  const result = docker([
    ...maintenanceArgs(d),
    '--network',
    'container:' + name(d, 'anchor'),
    '--mount',
    `type=bind,src=${join(d.path, 'runtime.json')},dst=/custody/runtime.json,readonly`,
    ...(operator ? ['--mount', `type=bind,src=${d.path},dst=/operator,readonly`] : []),
    ...(output ? ['--mount', `type=bind,src=${output},dst=/output`] : []),
    d.release.image,
    ...(output
      ? ['node', '--input-type=module', '-e', enrollmentHandoff, 'pilot-ticket', mode]
      : ['node', 'scripts/lib/pilot-runtime.mjs', mode]),
  ]);
  // A successful container exit alone does not establish delivery to the operator.
  if (output) readPrivateText(join(output, 'enrollment.json'), 4096);
  return result;
}
export function inventory(d) {
  return JSON.parse(helper(d, 'inventory', { operator: true }));
}
async function ensureContainer(d, service, args) {
  const target = name(d, service);
  if (resourceExists('container', target)) {
    const v = owned(d, 'container', target);
    if (!v.State.Running) docker(['start', target]);
  } else docker(['run', '--detach', '--name', target, ...base(d), ...args]);
}
export async function providers(d) {
  const c = configuration(d);
  for (const v of ['postgres-data', 's3-data']) owned(d, 'volume', name(d, v));
  owned(d, 'network', name(d, 'network'));
  const anchor = name(d, 'anchor');
  if (!resourceExists('container', anchor) || !owned(d, 'container', anchor).State.Running)
    await availablePort(Number(new URL(c.origin).port));
  await ensureContainer(d, 'anchor', [
    '--network',
    name(d, 'network'),
    '-p',
    `127.0.0.1:${new URL(c.origin).port}:3443`,
    d.release.images.node,
    'node',
    '-e',
    'process.once("SIGTERM",()=>process.exit(0));setInterval(()=>{},2147483647)',
  ]);
  await ensureContainer(d, 's3', [
    '--network',
    'container:' + anchor,
    '--stop-signal',
    'SIGINT',
    '--tmpfs',
    '/tmp',
    '--mount',
    `type=volume,src=${name(d, 's3-data')},dst=/data`,
    '--env-file',
    join(d.path, 'storage.env'),
    d.release.images.seaweed,
    'mini',
    '-dir=/data',
    '-s3.port=8333',
    '-master.telemetry=false',
  ]);
  await ensureContainer(d, 'postgres', [
    '--network',
    'container:' + anchor,
    '--stop-signal',
    'SIGINT',
    '--tmpfs',
    '/var/run/postgresql',
    '--tmpfs',
    '/docker-entrypoint-initdb.d',
    '--tmpfs',
    '/tmp',
    '--mount',
    `type=volume,src=${name(d, 'postgres-data')},dst=/var/lib/postgresql`,
    '--mount',
    `type=bind,src=${join(d.path, 'release/infra/pilot')},dst=/opt/loom,readonly`,
    '--env-file',
    join(d.path, 'postgres.env'),
    '--entrypoint',
    'bash',
    d.release.images.postgres,
    '/opt/loom/postgres.sh',
    'postgres',
  ]);
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
export async function until(predicate, reason, timeout = 90000) {
  const deadline = Date.now() + timeout;
  while (!(await predicate())) {
    if (Date.now() >= deadline) fail(reason + ' deadline');
    await delay(200);
  }
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
    fail('incompatible or pending migration history; explicit update required');
  return expected.length - actual.length;
}
export async function launch(d, service) {
  if (!services.includes(service)) fail('unknown service');
  const c = configuration(d);
  await ensureContainer(d, service, [
    '--network',
    'container:' + name(d, 'anchor'),
    '--mount',
    `type=bind,src=${join(d.path, 'runtime.json')},dst=/custody/runtime.json,readonly`,
    d.release.image,
    'node',
    'scripts/lib/pilot-runtime.mjs',
    service,
  ]);
  await until(async () => {
    if (!owned(d, 'container', name(d, service)).State.Running)
      fail(service + ' exited; explicit restart required');
    if (service === 'api') {
      try {
        return (await httpsCall(c.origin, c.tls.ca, '/health/ready')).status === 200;
      } catch {
        return false;
      }
    }
    return safeLogs(d, service).some((x) => x.event === service + '_worker_ready');
  }, service + ' readiness');
}
export function stopService(d, service, { clean = false } = {}) {
  const target = name(d, service);
  if (!resourceExists('container', target)) return;
  const v = owned(d, 'container', target);
  if (v.State.Running) docker(['stop', '--time', '60', target]);
  const state = owned(d, 'container', target).State;
  if (state.Running || (clean && (state.ExitCode !== 0 || state.OOMKilled || state.Error)))
    fail(service + ' did not stop cleanly');
}
export function stopAll(d, { clean = false } = {}) {
  for (const service of [...services, 'postgres', 's3', 'anchor'])
    stopService(d, service, { clean: clean && service !== 'anchor' });
}
export function safeLogs(d, service) {
  if (!services.includes(service)) fail('logs support api, search, notifications or file-text');
  const v = owned(d, 'container', name(d, service));
  const result = spawnSync(
    'docker',
    ['logs', '--since', v.State.StartedAt, '--tail', '100', name(d, service)],
    { encoding: 'utf8', timeout: 10000, maxBuffer: 128 * 1024 },
  );
  if (result.error || result.status !== 0) fail('bounded logs unavailable');
  const raw = result.stdout + result.stderr;
  const allowed = new Set([
    'pilot_api_ready',
    'pilot_runtime_failed',
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
  return raw.split('\n').flatMap((line) => {
    try {
      const x = JSON.parse(line);
      return allowed.has(x.event) ? [{ event: x.event }] : [];
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
      release: d.release.sha256,
      image: d.release.image,
      services: {},
      apiReady: false,
      processing:
        'Inspect authenticated Administration > Operational health; running is not complete processing.',
    };
  for (const service of ['anchor', 'postgres', 's3', ...services]) {
    const target = name(d, service);
    if (!resourceExists('container', target)) result.services[service] = { state: 'missing' };
    else {
      const v = owned(d, 'container', target);
      result.services[service] = {
        state: v.State.Status,
        exitCode: v.State.ExitCode,
        oom: v.State.OOMKilled,
        ...(services.includes(service)
          ? {
              readinessObserved:
                v.State.Running &&
                safeLogs(d, service).some(
                  (x) =>
                    x.event ===
                    (service === 'api' ? 'pilot_api_ready' : service + '_worker_ready'),
                ),
            }
          : {}),
      };
    }
  }
  try {
    result.apiReady = (await httpsCall(c.origin, c.tls.ca, '/health/ready')).status === 200;
  } catch {}
  return result;
}
export async function initialize(path, options) {
  if (options.acknowledge !== policy)
    fail('acknowledge README local-pilot-1 policies explicitly');
  const host = engine(),
    port = Number(options.port ?? 3444);
  path = privatePath(path, { fresh: true, instance: true, testOwner: options.testOwner });
  await availablePort(port);
  mkdirSync(path, { mode: 0o700 });
  const id = 'loom-pilot-' + randomUUID();
  const d = {
    format: 'loom-local-pilot-1',
    id,
    owner: randomBytes(32).toString('hex'),
    path,
    uid: process.getuid(),
    kind: options.testOwner ? 'acceptance' : 'retained',
    ...(options.testOwner ? { testOwner: options.testOwner } : {}),
    policy,
    state: 'initializing',
    engine: host,
    origin: 'https://localhost:' + port,
    database: 'loom_' + id.slice(11).replaceAll('-', ''),
  };
  json(join(path, 'instance.json'), d);
  const unlock = lock(d, 'init');
  try {
    d.release = snapshotRelease(path);
    const tls = certificate(path);
    tls.caFingerprint = hash(tls.ca);
    const c = {
      format: policy,
      instance: id,
      origin: d.origin,
      rpId: 'localhost',
      database: d.database,
      release: d.release,
      tls,
      nickname: options.nickname ?? 'pilot_admin',
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
        stagingBucket: id + '-staging',
        finalBucket: id + '-final',
      },
    };
    if (!/^[a-z][a-z0-9_-]{2,31}$/.test(c.nickname)) fail('invalid administrator nickname');
    d.caFingerprint = tls.caFingerprint;
    d.secretsFingerprint = hash(
      JSON.stringify({
        passwords: c.passwords,
        storage: c.storage,
        bootstrap: c.bootstrap,
        recovery: c.recovery,
      }),
    );
    replace(join(path, 'instance.json'), d);
    json(join(path, 'config.json'), c);
    saveConfiguration(d, c);
    writePrivate(join(path, 'ca.pem'), tls.ca);
    for (const [file, bytes] of Object.entries(providerConfiguration(c)))
      writePrivate(join(path, file), bytes);
    for (const [kind, suffix] of [
      ['network', 'network'],
      ['volume', 'postgres-data'],
      ['volume', 's3-data'],
    ]) {
      if (resourceExists(kind, name(d, suffix))) fail('resource collision');
      docker([kind, 'create', ...labels(d), name(d, suffix)]);
    }
    await providers(d);
    sql(d, migrationSql(await readMigrations(join(path, 'release/db/migrations'))), true);
    mkdirSync(join(path, 'enrollment'), { mode: 0o700 });
    await until(() => {
      try {
        helper(d, 'provision', { operator: true, output: join(path, 'enrollment') });
        return true;
      } catch (error) {
        throw error;
      }
    }, 'initial enrollment');
    // The singleton bootstrap and one-time ticket are never invoked by start.
    d.state = 'ready';
    replace(join(path, 'instance.json'), d);
    stopAll(d);
    return {
      scope,
      instance: id,
      origin: d.origin,
      state: 'initialized-stopped',
      enrollment: join(path, 'enrollment/enrollment.json'),
      ca: join(path, 'ca.pem'),
    };
  } catch (error) {
    d.state = 'initialization-interrupted';
    replace(join(path, 'instance.json'), d);
    // Preserve every created file/volume for explicit diagnosis; no compensating deletion.
    throw error;
  } finally {
    unlock();
  }
}
export async function lifecycle(path, action, options = {}) {
  const d = readInstance(path);
  if (action === 'recover-lock') {
    engine();
    if (resourceExists('container', name(d, 'maintenance')))
      fail('maintenance container remains; explicit inspection required');
    recoverLock(d);
    return {
      state: d.state,
      recovered: 'controller lock only; inspect status before another operation',
    };
  }
  const unlock = lock(d, action);
  try {
    preflight(d, { expiredLeaf: action === 'renew-certificate' });
    if (action === 'doctor' || action === 'status') return status(d);
    if (action === 'logs') return safeLogs(d, options.service ?? 'api');
    if (action === 'stop') {
      stopAll(d);
      return { state: 'stopped', retained: true };
    }
    if (action === 'renew-certificate') {
      stopService(d, 'api');
      const c = configuration(d, { expiredLeaf: true });
      c.tls = { ...certificate(d.path, c.tls), caFingerprint: d.caFingerprint };
      saveConfiguration(d, c);
      if (resourceExists('container', name(d, 'api'))) docker(['rm', name(d, 'api')]);
      return {
        state: 'leaf-renewed',
        origin: d.origin,
        trustAnchor: 'unchanged',
        next: 'start explicitly',
      };
    }
    if (
      existsSync(join(d.path, 'update.json')) &&
      readJson(join(d.path, 'update.json')).phase !== 'selected-stopped'
    )
      fail('interrupted update; explicit resume-update required');
    if (d.state !== 'ready' && d.state !== 'verified-snapshot')
      fail('partial initialization or quarantine; ordinary startup refused');
    if (action === 'worker-stop') {
      if (!services.slice(1).includes(options.service)) fail('unknown worker');
      stopService(d, options.service);
      return { service: options.service, state: 'stopped' };
    }
    if (action === 'restart' || action === 'recreate') stopAll(d);
    if (action === 'recreate') {
      for (const service of [...services, 'postgres', 's3', 'anchor'])
        if (resourceExists('container', name(d, service))) docker(['rm', name(d, service)]);
    }
    if (['start', 'restart', 'recreate', 'worker-start'].includes(action)) {
      await providers(d);
      await checkHistory(d);
      helper(d, 'ready');
      if (action === 'worker-start') {
        if (!services.slice(1).includes(options.service)) fail('unknown worker');
        await launch(d, options.service);
      } else for (const service of services) await launch(d, service);
      return status(d);
    }
    fail('unknown lifecycle action');
  } finally {
    unlock();
  }
}
