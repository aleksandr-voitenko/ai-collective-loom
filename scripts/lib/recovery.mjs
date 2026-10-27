import { spawnSync } from 'node:child_process';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  existsSync,
  lstatSync,
  realpathSync,
  readdirSync,
  openSync,
  closeSync,
  renameSync,
} from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { request } from 'node:https';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { localDockerEndpoint } from './local-config.mjs';
import { readMigrations, migrationSql } from './migrations.mjs';
import { recoveryBundle } from './recovery-bundle.mjs';
import { normalizeVerifierObservations } from './recovery-observations.mjs';

export const root = fileURLToPath(new URL('../../', import.meta.url));
const policy = JSON.parse(readFileSync(join(root, 'config/recovery.json')));
const bundle = recoveryBundle({ validateManifest: validateRelease });
const label = 'org.loom.recovery-attempt';
const hash = (value) => createHash('sha256').update(value).digest('hex');
const fail = (code) => {
  throw new Error('Recovery refused: ' + code + '.');
};
function run(command, args, options = {}) {
  const r = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 900000,
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
  // Raw provider, GPG, SQL and process errors are never diagnostics.
  if (r.error || r.status !== 0) {
    const phase =
      /^Recovery runtime failed: (configuration|inventory-database|inventory-native-versions|inventory-required-versions|inventory-history)\.\n$/.exec(
        r.stderr ?? '',
      )?.[1];
    fail(
      phase ??
        (command === 'docker' ? 'owned-resource operation failed' : command + ' operation failed'),
    );
  }
  return r.stdout?.trim() ?? '';
}
export const docker = (args, options) => run('docker', args, options);
function inside(parent, path) {
  const r = relative(parent, path);
  return !r || (!r.startsWith('..') && !isAbsolute(r));
}
export function privatePath(path, { newPath = false } = {}) {
  if (!isAbsolute(path)) fail('an explicit absolute external path is required');
  const absolute = resolve(path),
    parent = realpathSync(dirname(absolute));
  if (/[,\x00-\x1f\x7f]/.test(absolute)) fail('unsupported mount path');
  if (parent !== dirname(absolute) || inside(realpathSync(root), absolute))
    fail('repository or symlink path');
  if (newPath && existsSync(absolute)) fail('destination already exists');
  if (existsSync(absolute)) {
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink() || stat.mode & 0o077 || stat.uid !== process.getuid?.())
      fail('private owner-only paths required');
  }
  return absolute;
}
function json(path, value) {
  writeFileSync(path, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx', flush: true });
}
function replace(path, value) {
  const temporary = path + '.' + randomUUID();
  json(temporary, value);
  renameSync(temporary, path);
}
function readJson(path, limit = 16 * 1024 * 1024) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) fail('invalid private file');
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    fail('malformed JSON');
  }
}
export function readInstance(path) {
  path = privatePath(path);
  const d = readJson(join(path, 'instance.json'));
  if (
    d.format !== 'loom-recovery-instance-1' ||
    !/^loom-recovery-[a-f0-9-]{36}$/.test(d.id) ||
    !/^\w{64}$/.test(d.owner) ||
    d.path !== path
  )
    fail('unowned instance');
  return d;
}
function inspect(kind, name) {
  return JSON.parse(docker([kind, 'inspect', name]))[0];
}
function owned(d, kind, name) {
  const v = inspect(kind, name),
    labels = v.Config?.Labels ?? v.Labels;
  if (labels?.[label] !== d.owner) fail('resource ownership mismatch');
  return v;
}
const names = (d) => ({
  s3: d.id + '-s3',
  postgres: d.id + '-postgres',
  runtime: d.id + '-runtime',
  pgVolume: d.id + '-postgres-data',
  s3Volume: d.id + '-s3-data',
  network: d.id + '-network',
});
function resourceExists(kind, name) {
  const args =
    kind === 'volume'
      ? ['volume', 'ls', '--filter', 'name=^' + name + '$', '--format', '{{.Name}}']
      : kind === 'network'
        ? ['network', 'ls', '--filter', 'name=^' + name + '$', '--format', '{{.Name}}']
        : [
            'container',
            'ls',
            '--all',
            '--filter',
            'name=^/' + name + '$',
            '--format',
            '{{.Names}}',
          ];
  return docker(args).split('\n').includes(name);
}
export function prerequisites() {
  run('gpg', ['--version']);
  run('python3', ['--version']);
  run('openssl', ['version']);
  const endpoint = docker([
    'context',
    'inspect',
    ...(process.env.DOCKER_CONTEXT ? [process.env.DOCKER_CONTEXT] : []),
    '--format',
    '{{.Endpoints.docker.Host}}',
  ]);
  if (
    !localDockerEndpoint(
      process.env.DOCKER_CONTEXT ? endpoint : process.env.DOCKER_HOST || endpoint,
    )
  )
    fail('local Docker required');
  docker(['info', '--format', '{{.ServerVersion}}']);
}
function images() {
  const compose = readFileSync(join(root, 'compose.yaml'), 'utf8');
  const postgres = /image: (postgres:\S+@sha256:[a-f0-9]{64})/.exec(compose)?.[1];
  const seaweed = /image: (chrislusf\/seaweedfs:\S+@sha256:[a-f0-9]{64})/.exec(compose)?.[1];
  if (!postgres || !seaweed) fail('provider pins missing');
  return { postgres, seaweed, node: policy.nodeImage };
}
function release() {
  const files = {};
  function visit(directory) {
    for (const name of readdirSync(join(root, directory)).sort()) {
      const path = join(directory, name),
        stat = lstatSync(join(root, path));
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) files[path] = hash(readFileSync(join(root, path)));
      else fail('release symlink');
    }
  }
  visit('dist');
  visit('db/migrations');
  for (const file of [
    'package-lock.json',
    'config/recovery.json',
    'scripts/lib/recovery-runtime.mjs',
    'scripts/lib/native-inventory.mjs',
    'scripts/lib/recovery.mjs',
    'scripts/lib/recovery-archive.py',
    'scripts/lib/recovery-bundle.mjs',
    'scripts/recovery.mjs',
    'infra/postgres/start.sh',
    'infra/postgres/10-roles.sh',
  ])
    files[file] = hash(readFileSync(join(root, file)));
  return {
    revision: run('git', ['rev-parse', 'HEAD'], { cwd: root }),
    sha256: hash(JSON.stringify(files)),
    lockSha256: files['package-lock.json'],
    platform: docker(['info', '--format', '{{.OSType}}/{{.Architecture}}']),
    images: images(),
  };
}
function base(d) {
  return ['--label', label + '=' + d.owner, '--read-only', '--log-driver', 'none'];
}
function mounts(d) {
  return [
    ...['dist', 'node_modules', 'package.json', 'scripts/lib/recovery-runtime.mjs', 'scripts/lib/native-inventory.mjs'].flatMap(
      (path) => ['--mount', `type=bind,src=${join(root, path)},dst=/release/${path},readonly`],
    ),
    '--mount',
    `type=bind,src=${d.path},dst=/custody,readonly`,
    '--workdir',
    '/release',
  ];
}
function helper(d, mode) {
  const n = names(d);
  owned(d, 'container', n.s3);
  return docker([
    'run',
    '--rm',
    ...base(d),
    '--network',
    'container:' + n.s3,
    ...mounts(d),
    images().node,
    'node',
    'scripts/lib/recovery-runtime.mjs',
    mode,
  ]);
}
export function sql(d, query) {
  const n = names(d);
  owned(d, 'container', n.postgres);
  return docker(
    [
      'exec',
      '-i',
      n.postgres,
      'psql',
      '-X',
      '-qAt',
      '-U',
      'postgres',
      '-d',
      'loom_dev',
      '-v',
      'ON_ERROR_STOP=1',
    ],
    { input: query },
  );
}
function configuration(d) {
  return readJson(join(d.path, 'config.json'));
}
function setStatus(d, status) {
  d.status = status;
  replace(join(d.path, 'instance.json'), d);
}
function reserve(path) {
  privatePath(path, { newPath: true });
  mkdirSync(path, { mode: 0o700 });
  const d = {
    format: 'loom-recovery-instance-1',
    id: 'loom-recovery-' + randomUUID(),
    owner: randomBytes(32).toString('hex'),
    path,
    status: 'creating',
  };
  json(join(path, 'instance.json'), d);
  return d;
}
async function provisionResources(d, c, { restore = false } = {}) {
  const n = names(d),
    i = images();
  for (const [kind, name] of [
    ['network', n.network],
    ['volume', n.pgVolume],
    ['volume', n.s3Volume],
    ['container', n.s3],
    ['container', n.postgres],
    ['container', n.runtime],
  ]) {
    if (resourceExists(kind, name)) fail('destination resource already exists');
  }
  docker(['network', 'create', '--label', label + '=' + d.owner, n.network]);
  for (const name of [n.pgVolume, n.s3Volume])
    docker(['volume', 'create', '--label', label + '=' + d.owner, name]);
  if (!restore) await launchProviders(d, c);
}
async function launchProviders(d, c) {
  const n = names(d),
    i = images();
  for (const [name, volume] of [
    [n.pgVolume, 'pg'],
    [n.s3Volume, 's3'],
  ])
    owned(d, 'volume', name);
  const anchor = (port) =>
    docker(
      [
        'run',
        '--detach',
        '--name',
        n.s3,
        ...base(d),
        '--network',
        n.network,
        '--stop-signal',
        'SIGINT',
        '--tmpfs',
        '/tmp',
        '-p',
        `127.0.0.1:${port}:3443`,
        '--mount',
        `type=volume,src=${n.s3Volume},dst=/data`,
        '-e',
        'AWS_ACCESS_KEY_ID',
        '-e',
        'AWS_SECRET_ACCESS_KEY',
        i.seaweed,
        'mini',
        '-dir=/data',
        '-s3.port=8333',
        '-master.telemetry=false',
      ],
      {
        env: {
          ...process.env,
          AWS_ACCESS_KEY_ID: c.storage.accessKeyId,
          AWS_SECRET_ACCESS_KEY: c.storage.secretAccessKey,
        },
      },
    );
  const reservation = createServer();
  await new Promise((resolvePort, reject) => {
    reservation.once('error', reject);
    reservation.listen({ host: '127.0.0.1', port: 0 }, resolvePort);
  });
  const port = reservation.address().port;
  await new Promise((resolvePort, reject) =>
    reservation.close((error) => (error ? reject(error) : resolvePort())),
  );
  const origin = 'https://localhost:' + port;
  if (origin === c.origin) fail('fresh isolated origin required');
  // Freeze a fresh origin before identity initialization. A stolen port fails; no retry/cutover.
  anchor(String(port));
  c.origin = origin;
  replace(join(d.path, 'config.json'), c);
  docker(
    [
      'run',
      '--detach',
      '--name',
      n.postgres,
      ...base(d),
      '--network',
      'container:' + n.s3,
      '--stop-signal',
      'SIGINT',
      '--tmpfs',
      '/var/run/postgresql',
      '--tmpfs',
      '/docker-entrypoint-initdb.d',
      '--tmpfs',
      '/tmp',
      '--mount',
      `type=volume,src=${n.pgVolume},dst=/var/lib/postgresql`,
      '--mount',
      `type=bind,src=${join(root, 'infra/postgres')},dst=/opt/loom/postgres,readonly`,
      '--entrypoint',
      'bash',
      '-e',
      'POSTGRES_DB=loom_dev',
      '-e',
      'POSTGRES_USER=postgres',
      '-e',
      'POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256',
      ...Object.keys(c.passwords).flatMap((key) => ['-e', key]),
      i.postgres,
      '/opt/loom/postgres/start.sh',
      'postgres',
    ],
    { env: { ...process.env, ...c.passwords } },
  );
}
async function waitProviders(d) {
  const deadline = Date.now() + 90000;
  while (true) {
    try {
      sql(d, 'SELECT 1');
      break;
    } catch {
      if (Date.now() > deadline) fail('database readiness deadline');
      await delay(200);
    }
  }
  // Native S3 readiness is checked without provisioning or changing retained bucket settings.
  while (true) {
    try {
      helper(d, 'ready');
      break;
    } catch {
      if (Date.now() > deadline) fail('storage readiness deadline');
      await delay(200);
    }
  }
}
async function serveRuntime(d, { workers = false } = {}) {
  const n = names(d),
    c = configuration(d);
  c.workers = workers;
  replace(join(d.path, 'config.json'), c);
  if (resourceExists('container', n.runtime)) {
    const old = owned(d, 'container', n.runtime);
    if (old.State.Running) fail('runtime already running');
    docker(['rm', n.runtime]);
  }
  docker([
    'run',
    '--detach',
    '--name',
    n.runtime,
    ...base(d),
    '--network',
    'container:' + n.s3,
    ...mounts(d),
    images().node,
    'node',
    'scripts/lib/recovery-runtime.mjs',
    'serve',
  ]);
  const deadline = Date.now() + 90000;
  while (true) {
    try {
      if ((await httpsCall(c.origin, c.tls.cert, '/health/ready')).status === 200) return;
    } catch {}
    if (!owned(d, 'container', n.runtime).State.Running || Date.now() > deadline)
      fail('application readiness deadline');
    await delay(200);
  }
}
export async function createInstance(path) {
  prerequisites();
  const d = reserve(path);
  try {
    const temporary = mkdtempSync(join(tmpdir(), 'loom-recovery-tls-'));
    let tls;
    try {
      run('openssl', [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        join(temporary, 'key'),
        '-out',
        join(temporary, 'cert'),
        '-days',
        '2',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=DNS:localhost,IP:127.0.0.1',
      ]);
      tls = {
        key: readFileSync(join(temporary, 'key'), 'utf8'),
        cert: readFileSync(join(temporary, 'cert'), 'utf8'),
      };
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
    const c = {
      passwords: Object.fromEntries(
        ['POSTGRES_PASSWORD', 'LOOM_PG_MIGRATOR_PASSWORD', 'LOOM_PG_APP_PASSWORD'].map((key) => [
          key,
          randomBytes(32).toString('hex'),
        ]),
      ),
      storage: {
        accessKeyId: randomBytes(16).toString('hex'),
        secretAccessKey: randomBytes(32).toString('hex'),
      },
      bootstrap: randomBytes(32).toString('base64url'),
      recovery: randomBytes(32).toString('base64url'),
      tls,
    };
    c.release = release();
    json(join(d.path, 'config.json'), c);
    await provisionResources(d, c);
    await waitProviders(d);
    docker(
      [
        'exec',
        '-i',
        '-e',
        'PGPASSWORD',
        names(d).postgres,
        'psql',
        '-X',
        '-q',
        '-h',
        '127.0.0.1',
        '-U',
        'loom_migrator',
        '-d',
        'loom_dev',
        '-v',
        'ON_ERROR_STOP=1',
      ],
      {
        input: migrationSql(await readMigrations(join(root, 'db/migrations'))),
        env: { ...process.env, PGPASSWORD: c.passwords.LOOM_PG_MIGRATOR_PASSWORD },
      },
    );
    const provisioned = JSON.parse(helper(d, 'provision'));
    json(join(d.path, 'enrollment.json'), provisioned);
    await serveRuntime(d, { workers: true });
    setStatus(d, 'synthetic-source');
    return d;
  } catch (error) {
    setStatus(d, 'failed');
    await destroyResources(d);
    throw error;
  }
}
function assertTopology(d) {
  const n = names(d);
  const network = owned(d, 'network', n.network);
  if (network.Driver !== 'bridge') fail('network is not an owned bridge');
  const anchor = owned(d, 'container', n.s3),
    pg = owned(d, 'container', n.postgres);
  for (const v of [anchor, pg])
    if (!v.HostConfig.ReadonlyRootfs || v.HostConfig.Privileged)
      fail('unbounded provider persistent state');
  if (anchor.Config.Image !== images().seaweed || pg.Config.Image !== images().postgres)
    fail('provider image mismatch');
  const ports = anchor.HostConfig.PortBindings;
  if (
    Object.keys(ports ?? {}).join() !== '3443/tcp' ||
    ports['3443/tcp'].some((p) => p.HostIp !== '127.0.0.1')
  )
    fail('non-loopback provider exposure');
  if (resourceExists('container', n.runtime)) {
    const runtime = owned(d, 'container', n.runtime);
    if (
      runtime.HostConfig.NetworkMode !== 'container:' + anchor.Id ||
      runtime.Config.Image !== images().node ||
      !runtime.HostConfig.ReadonlyRootfs ||
      runtime.HostConfig.Privileged
    )
      fail('unmanaged application supervisor');
  }
  const expected = [
    [anchor, n.s3Volume, '/data'],
    [pg, n.pgVolume, '/var/lib/postgresql'],
  ];
  for (const [v, volume, target] of expected) {
    const writable = v.Mounts.filter((m) => m.RW);
    if (writable.length !== 1 || writable[0].Name !== volume || writable[0].Destination !== target)
      fail('unexpected writable provider mount');
    owned(d, 'volume', volume);
    const mountedBy = docker([
      'container',
      'ls',
      '--all',
      '--filter',
      'volume=' + volume,
      '--format',
      '{{.Names}}',
    ])
      .split('\n')
      .filter(Boolean);
    if (mountedBy.length !== 1 || mountedBy[0] !== v.Name.slice(1))
      fail('volume has another consumer');
  }
  if (pg.HostConfig.NetworkMode !== 'container:' + anchor.Id) fail('database namespace mismatch');
  if (Object.keys(network.Containers ?? {}).length !== 1) fail('unexpected network member');
}
async function stopProviders(d) {
  assertTopology(d);
  const n = names(d);
  for (const name of [n.runtime, n.postgres, n.s3]) {
    if (!resourceExists('container', name)) {
      if (name === n.runtime) continue;
      fail('provider missing');
    }
    const v = owned(d, 'container', name);
    if (v.State.Running) docker(['stop', '--time', '60', name]);
    const state = owned(d, 'container', name).State;
    if (state.Running || state.ExitCode !== 0 || state.OOMKilled || state.Error)
      fail('unclean shutdown');
  }
  setStatus(
    d,
    existsSync(join(d.path, 'restored-manifest.json'))
      ? d.status.startsWith('verified')
        ? 'verified-stopped'
        : 'quarantined-stopped'
      : 'stopped',
  );
}
async function startSource(d) {
  const restored = existsSync(join(d.path, 'restored-manifest.json'));
  if (
    restored ? d.status !== 'verified-stopped' : !['stopped', 'synthetic-source'].includes(d.status)
  )
    fail('quarantine cannot be bypassed by restart');
  const n = names(d);
  for (const name of [n.s3, n.postgres]) {
    owned(d, 'container', name);
    docker(['start', name]);
  }
  await waitProviders(d);
  await serveRuntime(d, { workers: true });
  setStatus(d, restored ? 'verified-isolated-snapshot' : 'synthetic-source');
}
function lock(d) {
  let fd;
  try {
    fd = openSync(join(d.path, 'operation.lock'), 'wx', 0o600);
  } catch {
    fail('instance operation is locked');
  }
  return () => {
    closeSync(fd);
    rmSync(join(d.path, 'operation.lock'));
  };
}
function keyMaterial(path) {
  privatePath(path);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > 1024) fail('invalid key file');
  const key = readFileSync(path, 'utf8').trim();
  if (!/^[A-Za-z0-9_+\/-]{43,128}={0,2}$/.test(key))
    fail('a separate random fixture key is required');
  return key + '\n';
}
function archive(d, volume, output) {
  owned(d, 'volume', volume);
  docker([
    'run',
    '--rm',
    ...base(d),
    '--network',
    'none',
    '--mount',
    `type=volume,src=${volume},dst=/volume,readonly`,
    '--mount',
    `type=bind,src=${dirname(output)},dst=/capture`,
    '--entrypoint',
    'tar',
    images().postgres,
    '--format=ustar',
    '--hard-dereference',
    '-C',
    '/volume',
    '-cf',
    '/capture/' + output.split('/').at(-1),
    '.',
  ]);
}
function validateRelease(manifest) {
  if (
    manifest.format !== policy.format ||
    manifest.consistency !== policy.consistency ||
    !manifest.backupId ||
    !manifest.inventory?.instance
  )
    fail('unsupported manifest');
  if (
    !/^loom-recovery-[a-f0-9-]{36}$/.test(manifest.source?.id ?? '') ||
    typeof manifest.source.path !== 'string' ||
    !isAbsolute(manifest.source.path)
  )
    fail('malformed source identity');
  if (JSON.stringify(manifest.release) !== JSON.stringify(release()))
    fail('incompatible release or provider platform');
  const migrations = readdirSync(join(root, 'db/migrations'))
    .filter((p) => p.endsWith('.sql'))
    .sort()
    .map((filename) => ({
      version: filename.slice(0, 4),
      filename,
      sha256: hash(readFileSync(join(root, 'db/migrations', filename))),
    }));
  if (JSON.stringify(manifest.inventory.migrations) !== JSON.stringify(migrations))
    fail('incompatible migration history');
}
export async function backup(d, path, keyFile, { fault } = {}) {
  prerequisites();
  privatePath(path, { newPath: true });
  if (inside(d.path, keyFile) || inside(path, keyFile)) fail('key custody must be separate');
  const key = keyMaterial(keyFile),
    unlock = lock(d);
  mkdirSync(path, { mode: 0o700 });
  const scratch = mkdtempSync(join(tmpdir(), 'loom-recovery-capture-'));
  try {
    assertTopology(d);
    const n = names(d);
    if (!isDeepStrictEqual(configuration(d).release, release()))
      fail('release changed since source startup');
    if (resourceExists('container', n.runtime)) {
      owned(d, 'container', n.runtime);
      docker(['stop', '--time', '60', n.runtime]);
      if (owned(d, 'container', n.runtime).State.ExitCode !== 0) fail('application drain failed');
    }
    if (
      sql(
        d,
        "SELECT count(*) FROM pg_stat_activity WHERE datname='loom_dev' AND pid<>pg_backend_pid()",
      ) !== '0'
    )
      fail('unmanaged database connections');
    if (
      sql(
        d,
        "SELECT count(*) FROM pg_tablespace WHERE spcname NOT IN ('pg_default','pg_global')",
      ) !== '0'
    )
      fail('external tablespace');
    const inventory = JSON.parse(helper(d, 'inventory'));
    await stopProviders(d);
    const control = docker([
      'run',
      '--rm',
      ...base(d),
      '--network',
      'none',
      '--mount',
      `type=volume,src=${n.pgVolume},dst=/volume,readonly`,
      '--entrypoint',
      'pg_controldata',
      images().postgres,
      '/volume/18/docker',
    ]);
    if (!/Database cluster state:\s+shut down\s*\n/.test(control))
      fail('PostgreSQL is not cleanly shut down');
    const manifest = {
      format: policy.format,
      backupId: randomUUID(),
      source: { id: d.id, path: d.path },
      boundary: new Date().toISOString(),
      consistency: policy.consistency,
      release: release(),
      inventory,
      components: {},
      processLocal:
        'HTTP admissions, in-flight IO, worker processes, rate windows and nonpersisted cursors restart; no client journal adoption',
    };
    const sources = {};
    for (const [name, volume] of [
      ['postgres', n.pgVolume],
      ['seaweed', n.s3Volume],
    ]) {
      sources[name] = join(scratch, name + '.tar');
      archive(d, volume, sources[name]);
    }
    sources.config = join(scratch, 'config.json');
    json(sources.config, configuration(d));
    bundle.write(path, manifest, sources, key, scratch, { fault });
    return {
      backupId: manifest.backupId,
      status: 'backup-created-and-integrity-checked',
      source: 'stopped; explicit start required',
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    unlock();
  }
}
function unpackBackup(path, keyFile, scratch) {
  if (inside(path, keyFile)) fail('key custody must be separate');
  privatePath(path);
  const { manifest, config: c } = bundle.read(path, keyMaterial(keyFile), scratch);
  if (!c.passwords?.POSTGRES_PASSWORD || !c.storage?.secretAccessKey || !c.tls?.key)
    fail('configuration prerequisite missing');
  return { manifest, c };
}
export function inspectBackup(path, keyFile) {
  prerequisites();
  const scratch = mkdtempSync(join(tmpdir(), 'loom-recovery-inspect-'));
  try {
    const { manifest: m } = unpackBackup(path, keyFile, scratch);
    return {
      format: m.format,
      backupId: m.backupId,
      boundary: m.boundary,
      revision: m.release.revision,
      consistency: m.consistency,
      tables: Object.keys(m.inventory.tables).length,
      requiredVersions: m.inventory.requiredVersions,
      status: 'integrity-checked; application recovery unverified',
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
export async function restore(path, destination, keyFile, { fault } = {}) {
  prerequisites();
  privatePath(destination, { newPath: true });
  privatePath(path);
  if (inside(path, destination) || inside(destination, path)) fail('backup destination overlap');
  const scratch = mkdtempSync(join(tmpdir(), 'loom-recovery-restore-'));
  let d;
  try {
    // All decryption, compatibility, integrity and archive checks precede destination creation.
    const { manifest, c } = unpackBackup(path, keyFile, scratch);
    if (inside(manifest.source.path, destination) || inside(destination, manifest.source.path))
      fail('source destination overlap');
    d = reserve(destination);
    setStatus(d, 'quarantined-restoring');
    json(join(d.path, 'config.json'), c);
    json(join(d.path, 'restored-manifest.json'), manifest);
    await provisionResources(d, c, { restore: true });
    const n = names(d);
    for (const [name, volume] of [
      ['postgres', n.pgVolume],
      ['seaweed', n.s3Volume],
    ]) {
      owned(d, 'volume', volume);
      docker([
        'run',
        '--rm',
        ...base(d),
        '--network',
        'none',
        '--mount',
        `type=volume,src=${volume},dst=/volume`,
        '--mount',
        `type=bind,src=${scratch},dst=/capture,readonly`,
        '--entrypoint',
        'sh',
        images().postgres,
        '-c',
        'test -z "$(ls -A /volume)" && tar --keep-old-files -C /volume -xf /capture/' +
          name +
          '-checked.tar',
      ]);
      if (fault === 'after-database' && name === 'postgres') fail('injected restore interruption');
    }
    await launchProviders(d, c);
    await waitProviders(d);
    const actual = JSON.parse(helper(d, 'inventory'));
    if (JSON.stringify(actual) !== JSON.stringify(manifest.inventory))
      fail('restored database or exact storage differs');
    setStatus(d, 'quarantined-integrity-verified');
    return d;
  } catch (error) {
    if (d) {
      setStatus(d, 'quarantined-failed');
      await destroyResources(d);
    }
    throw error;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
export function inventory(d) {
  return JSON.parse(helper(d, 'inventory'));
}
export async function httpsCall(origin, cert, path, body, token) {
  if (!path.startsWith('/api/v1/') && !path.startsWith('/health/'))
    fail('unsupported verification request');
  return new Promise((resolveCall, reject) => {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    const req = request(
      new URL(path, origin),
      {
        ca: cert,
        agent: false,
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
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks);
          let value;
          try {
            value = JSON.parse(raw);
          } catch {
            value = raw.toString('base64');
          }
          resolveCall({ status: res.statusCode, body: value });
        });
      },
    );
    req.setTimeout(20000, () => req.destroy(new Error('HTTPS verification deadline')));
    req.on('error', reject);
    req.end(encoded);
  });
}
async function verifyApplication(d, expectationsPath) {
  if (d.status !== 'quarantined-integrity-verified')
    fail('destination is not ready for verification');
  privatePath(expectationsPath);
  const expectations = readJson(expectationsPath);
  if (
    expectations.format !== 'loom-recovery-expectations-1' ||
    !Array.isArray(expectations.reads) ||
    !expectations.reads.length
  )
    fail('independent expectations required');
  const manifest = readJson(join(d.path, 'restored-manifest.json'));
  if (expectations.instance !== manifest.inventory.instance)
    fail('expectations belong to another installation');
  const c = configuration(d);
  try {
    for (const suffix of ['-runtime', '-postgres', '-s3']) {
      const source = manifest.source.id + suffix;
      if (resourceExists('container', source) && inspect('container', source).State.Running)
        fail('source must be unavailable');
    }
    await serveRuntime(d);
    const observations = await verifyRequests(c, expectations, { query: q => sql(d, q), capture: () => inventory(d), drain: () => docker(['stop', '--time', '60', names(d).runtime]), expectedInventory: manifest.inventory });
    await serveRuntime(d);
    setStatus(d, 'verified-isolated-snapshot');
    json(join(d.path, 'VERIFIED.json'), {
      format: 'loom-isolated-verification-1',
      backupId: manifest.backupId,
      reads: expectations.reads.length,
      observedRequests: [...observations].map(([request_id, fields]) => ({request_id, ...fields})),
    });
    return { status: d.status, requests: expectations.reads.length, cutover: false };
  } catch (error) {
    setStatus(d, 'quarantined-failed');
    const n = names(d);
    if (resourceExists('container', n.runtime)) {
      owned(d, 'container', n.runtime);
      docker(['stop', '--time', '60', n.runtime]);
    }
    throw error;
  }
}
/** Full inventory equality except bounded authenticated read charges and identified
 * verifier observations. All other participants, domain rows and policy stay exact. */
export function verificationStatePreserved(before, after, admissions, startTime, endTime, observations = new Map()) {
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime < startTime) return false;
  const tables = normalizeVerifierObservations(before.tables, after.tables, observations, startTime, endTime);
  if (!tables) return false;
  after = {...after, tables};
  const table = 'loom.participation_rate_windows',
    original = before.tables[table],
    current = after.tables[table];
  if (!original || !current) return isDeepStrictEqual(before, after);
  if (
    current.publicationSha256 !== original.publicationSha256 ||
    current.classification !== original.classification ||
    Object.keys(current).sort().join() !== Object.keys(original).sort().join()
  )
    return false;
  const prior = new Map(
    original.requestWindows.map((row) => [row.participant_id + ':' + row.category, row]),
  );
  const next = new Map(
    current.requestWindows.map((row) => [row.participant_id + ':' + row.category, row]),
  );
  if (
    next.size !== current.requestWindows.length ||
    [...prior.keys()].some((key) => !next.has(key))
  )
    return false;
  if (current.rows - original.rows !== next.size - prior.size) return false;
  for (const [key, row] of next) {
    const old = prior.get(key),
      allowed = admissions.get(key) ?? 0;
    if (isDeepStrictEqual(row, old)) continue;
    if (
      !allowed ||
      !['ordinary_requests', 'recovery_control'].includes(row.category) ||
      !Number.isSafeInteger(row.used) ||
      row.used < 1 ||
      row.used > 6000
    )
      return false;
    // No extra row fields may escape comparison through this narrow exception.
    if (Object.keys(row).sort().join() !== 'category,participant_id,used,window_started_at')
      return false;
    const started = Date.parse(row.window_started_at);
    if (old && row.window_started_at === old.window_started_at) {
      if (
        startTime >= Date.parse(old.window_started_at) + 60000 ||
        row.used < old.used ||
        row.used - old.used > allowed
      )
        return false;
    } else if (
      !Number.isFinite(started) ||
      started < startTime ||
      started > endTime ||
      row.used > allowed ||
      (old && started - Date.parse(old.window_started_at) < 60000)
    )
      return false;
  }
  const normalized = { ...after, tables: { ...after.tables, [table]: original } };
  return isDeepStrictEqual(before, normalized);
}
export function comparable(result, path = '') {
  const copy = structuredClone(result);
  if (copy.body?.error) delete copy.body.error.request_id;
  // A newly opened reference traversal has a new process-local five-minute TTL.
  // Persisted upload/preparation/session/reservation timestamps are never removed.
  if (/^\/api\/v1\/resources\/[a-f0-9-]{36}\/revisions\/[a-f0-9-]{36}\/references$/.test(path))
    delete copy.body.expires_at;
  return copy;
}
async function destroyResources(d) {
  const n = names(d);
  for (const name of [n.runtime, n.postgres, n.s3])
    if (resourceExists('container', name)) {
      owned(d, 'container', name);
      docker(['rm', '--force', name]);
    }
  for (const name of [n.pgVolume, n.s3Volume])
    if (resourceExists('volume', name)) {
      owned(d, 'volume', name);
      docker(['volume', 'rm', name]);
    }
  if (resourceExists('network', n.network)) {
    owned(d, 'network', n.network);
    docker(['network', 'rm', n.network]);
  }
}

async function exclusive(d, operation) {
  const unlock = lock(d);
  try {
    return await operation();
  } finally {
    unlock();
  }
}
export const serve = (d, options) =>
  exclusive(d, () => {
    if (!['synthetic-source', 'verified-isolated-snapshot'].includes(d.status))
      fail('quarantine cannot be bypassed by serving');
    return serveRuntime(d, options);
  });
export const stop = (d) => exclusive(d, () => stopProviders(d));
export const start = (d) => exclusive(d, () => startSource(d));
export const destroy = (d) => exclusive(d, () => destroyResources(d));
export const verify = (d, expectations) => exclusive(d, () => verifyApplication(d, expectations));

export async function verifyRequests(c, expectations, { query, capture, drain, expectedInventory, verifierPolicy }) {
    const startTime = Date.parse(query('SELECT clock_timestamp()'));
    const admissions = new Map(),
      identities = new Map(), observations = new Map();
    const operationFamily = verifierPolicy
      ? template => new Map(verifierPolicy.families).get(template)
      : (await import('../../dist/server/modules/operations/collector.js')).operationFamily;
    const outcomeCodes = verifierPolicy?.outcomeCodes ?? (await import('../../dist/contracts/operations.js')).outcomeCodes;
    const record = (result, template) => {
      const error=result.body?.error, family=operationFamily(template);
      if (family && outcomeCodes.includes(error?.code) && !error?.forbidden_reason &&
          result.status >= 400 && result.status <= 599 && typeof error.request_id === 'string')
        observations.set(error.request_id,{family,code:error.code,status:result.status});
    };
    const add = (participant, category) => {
      const key = participant + ':' + category;
      admissions.set(key, (admissions.get(key) ?? 0) + 1);
    };
    const participationRateRoutes = verifierPolicy ? new Map(verifierPolicy.routes) : (await import('../../dist/server/http/rate-policy.js')).participationRateRoutes;
    // Validate each credential through the actual API. This extra control read
    // is itself charged; no verifier bypass or counter reset is permitted.
    for (const { token } of expectations.reads)
      if (!identities.has(token)) {
        const self = await httpsCall(
          c.origin,
          c.tls.ca ?? c.tls.cert,
          '/api/v1/identity/self',
          undefined,
          token,
        );
        record(self, '/api/v1/identity/self');
        if (self.status === 401) identities.set(token, null);
        else {
          if (self.status !== 200 || typeof self.body?.participant_id !== 'string')
            fail('verification identity unavailable');
          identities.set(token, self.body.participant_id);
          add(self.body.participant_id, 'recovery_control');
        }
      }
    for (const [index, entry] of expectations.reads.entries()) {
      const result = await httpsCall(c.origin, c.tls.ca ?? c.tls.cert, entry.path, entry.body, entry.token);
      if (!isDeepStrictEqual(comparable(result, entry.path), entry.expected))
        fail('application expectation ' + (index + 1) + ' differs');
      const method = entry.body === undefined ? 'GET' : 'POST';
      const pathname = new URL(entry.path, c.origin).pathname;
      const route = [...participationRateRoutes].find(([key]) => {
        const [verb, template] = key.split(' ');
        return (
          method === verb &&
          new RegExp('^' + template.replace(/:[^/]+/g, '[^/]+') + '$').test(pathname)
        );
      });
      if (route) record(result, route[0].split(' ')[1]);
      if (identities.get(entry.token) && route && route[1] !== 'excluded')
        add(
          identities.get(entry.token),
          route[1] === 'publication' ? 'ordinary_requests' : route[1],
        );
    }
    // Graceful close drains the bounded asynchronous collector before comparison.
    await drain();
    const after = capture();
    const endTime = Date.parse(query('SELECT clock_timestamp()'));
    if (!verificationStatePreserved(expectedInventory, after, admissions, startTime, endTime, observations))
      fail('verification changed retained state');
    return observations;
}
