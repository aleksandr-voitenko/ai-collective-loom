import { randomUUID, randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  cpSync,
  renameSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import {
  root,
  policy,
  hash,
  fail,
  docker,
  privatePath,
  inside,
  readJson,
  readPrivateText,
  json,
  replace,
  readInstance,
  lock,
  writePrivate,
  certificate,
} from './pilot-files.mjs';
import {
  engine,
  preflight,
  configuration,
  saveConfiguration,
  name,
  owned,
  resourceExists,
  services,
  providers,
  sql,
  helper,
  inventory,
  launch,
  stopService,
  stopAll,
  topology,
  checkHistory,
  snapshotRelease,
  availablePort,
  maintenanceArgs,
  matchesReleaseFiles,
  validateRelease,
  providerConfiguration,
} from './pilot.mjs';
import { recoveryBundle } from './recovery-bundle.mjs';
import { verifyRequests, httpsCall, comparable } from './recovery.mjs';
import { readMigrations, migrationSql } from './migrations.mjs';

function keyMaterial(keyFile, paths) {
  privatePath(keyFile);
  if (paths.some((path) => inside(path, keyFile)))
    fail('backup key must be separate from instance and backup');
  const value = readPrivateText(keyFile, 256).trim();
  if (!/^[A-Za-z0-9_+\/-]{43,128}={0,2}$/.test(value))
    fail('separate random backup key required');
  return value + '\n';
}
function bundle(d) {
  return recoveryBundle({
    validateManifest: (m) => {
      if (
        m.format !== 'loom-cold-backup-1' ||
        m.adapter !== policy ||
        m.consistency !== 'managed-runtime-drained-and-both-providers-cleanly-stopped' ||
        !m.inventory?.instance ||
        !/^loom-pilot-[a-f0-9-]{36}$/.test(m.source?.id ?? '') ||
        !/^[a-f0-9]{64}$/.test(m.source?.owner ?? '') ||
        !isDeepStrictEqual(m.release, d.release)
      )
        fail('incompatible pilot snapshot or selected release');
      const migrations = Object.entries(d.release.files)
        .filter(([p]) => /^db\/migrations\/[0-9]{4}_[a-z0-9_]+\.sql$/.test(p))
        .map(([p, sha256]) => ({
          version: p.split('/').at(-1).slice(0, 4),
          filename: p.split('/').at(-1),
          sha256,
        }));
      if (!isDeepStrictEqual(m.inventory.migrations, migrations))
        fail('incompatible backup migration history');
    },
  });
}
function archive(d, volume, output) {
  owned(d, 'volume', volume);
  docker([
    ...maintenanceArgs(d),
    '--network',
    'none',
    '--mount',
    `type=volume,src=${volume},dst=/volume,readonly`,
    '--mount',
    `type=bind,src=${dirname(output)},dst=/capture`,
    '--entrypoint',
    'tar',
    d.release.images.postgres,
    '--format=ustar',
    '--hard-dereference',
    '-C',
    '/volume',
    '-cf',
    '/capture/' + output.split('/').at(-1),
    '.',
  ]);
}
export async function capture(d, path, keyFile) {
  privatePath(path, { fresh: true });
  if (inside(d.path, path) || inside(path, d.path))
    fail('backup must be separate from instance');
  const key = keyMaterial(keyFile, [d.path, path]);
  const c = preflight(d);
  if (!['ready', 'verified-snapshot'].includes(d.state))
    fail('unverified or interrupted installation cannot be backed up');
  mkdirSync(path, { mode: 0o700 });
  const scratch = mkdtempSync(join(tmpdir(), 'loom-pilot-capture-'));
  try {
    for (const s of services) stopService(d, s, { clean: true });
    await providers(d);
    topology(d);
    await checkHistory(d);
    if (
      sql(
        d,
        `SELECT count(*) FROM pg_stat_activity WHERE datname='${c.database}' AND pid<>pg_backend_pid()`,
      ) !== '0' ||
      sql(
        d,
        "SELECT count(*) FROM pg_tablespace WHERE spcname NOT IN ('pg_default','pg_global')",
      ) !== '0'
    )
      fail('unmanaged database activity or tablespace');
    const captured = inventory(d);
    stopAll(d, { clean: true });
    const control = docker([
      ...maintenanceArgs(d),
      '--network',
      'none',
      '--mount',
      `type=volume,src=${name(d, 'postgres-data')},dst=/volume,readonly`,
      '--entrypoint',
      'pg_controldata',
      d.release.images.postgres,
      '/volume/18/docker',
    ]);
    if (!/Database cluster state:\s+shut down\s*\n/.test(control))
      fail('database was not cleanly shut down');
    const manifest = {
      format: 'loom-cold-backup-1',
      adapter: policy,
      backupId: randomUUID(),
      source: {
        id: d.id,
        path: d.path,
        owner: d.owner,
        kind: d.kind,
        testOwner: d.testOwner,
        origin: d.origin,
      },
      boundary: new Date().toISOString(),
      consistency: 'managed-runtime-drained-and-both-providers-cleanly-stopped',
      release: d.release,
      inventory: captured,
      components: {},
    };
    const sources = {};
    for (const [key, suffix] of [
      ['postgres', 'postgres-data'],
      ['seaweed', 's3-data'],
    ]) {
      sources[key] = join(scratch, key + '.tar');
      archive(d, name(d, suffix), sources[key]);
    }
    sources.config = join(scratch, 'config.json');
    json(sources.config, c);
    bundle(d).write(path, manifest, sources, key, scratch);
    return {
      status: 'encrypted-and-integrity-checked',
      backupId: manifest.backupId,
      source: 'stopped; explicit start required',
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
function sourceStopped(m) {
  for (const s of [...services, 'postgres', 's3', 'anchor']) {
    const target = m.source.id + '-' + s;
    if (resourceExists('container', target)) {
      const v = JSON.parse(docker(['container', 'inspect', target]))[0];
      if (v.Config.Labels?.['org.loom.local-pilot'] !== m.source.owner || v.State.Running)
        fail('snapshot source must remain unavailable');
    }
  }
}
export async function restoreSnapshot(source, options) {
  if (!isDeepStrictEqual(engine(), source.engine)) fail('Docker context or platform changed');
  validateRelease(source);
  const path = privatePath(options.destination, {
    fresh: true,
    instance: true,
    testOwner: source.testOwner,
  });
  const backup = privatePath(options.backup),
    key = keyMaterial(options['key-file'], [source.path, path, backup]);
  if (
    inside(backup, path) ||
    inside(path, backup) ||
    inside(source.path, path) ||
    inside(path, source.path)
  )
    fail('restore path overlap');
  const port = Number(options.port);
  await availablePort(port);
  const scratch = mkdtempSync(join(tmpdir(), 'loom-pilot-restore-'));
  let d;
  try {
    const { manifest: m, config: c } = bundle(source).read(backup, key, scratch);
    sourceStopped(m);
    if ('https://localhost:' + port === m.source.origin)
      fail('restore requires a separate origin');
    mkdirSync(path, { mode: 0o700 });
    d = {
      ...source,
      id: 'loom-pilot-' + randomUUID(),
      owner: randomBytes(32).toString('hex'),
      path,
      origin: 'https://localhost:' + port,
      state: 'quarantined-restoring',
    };
    cpSync(join(source.path, 'release'), join(path, 'release'), { recursive: true });
    c.instance = d.id;
    c.origin = d.origin;
    // A restored browser scope gets its own trust material and never adopts live journals.
    c.tls = certificate(path);
    c.tls.caFingerprint = hash(c.tls.ca);
    d.caFingerprint = c.tls.caFingerprint;
    json(join(path, 'instance.json'), d);
    json(join(path, 'config.json'), c);
    saveConfiguration(d, c);
    writePrivate(join(path, 'ca.pem'), c.tls.ca);
    for (const [file, bytes] of Object.entries(providerConfiguration(c)))
      writePrivate(join(path, file), bytes);
    json(join(path, 'restored-manifest.json'), m);
    const labels = [
      '--label',
      'org.loom.local-pilot=' + d.owner,
      '--label',
      'org.loom.instance=' + d.id,
      '--label',
      'org.loom.kind=' + d.kind,
      ...(d.testOwner ? ['--label', 'org.loom.test-owner=' + d.testOwner] : []),
    ];
    docker(['network', 'create', ...labels, name(d, 'network')]);
    for (const [component, suffix] of [
      ['postgres', 'postgres-data'],
      ['seaweed', 's3-data'],
    ]) {
      docker(['volume', 'create', ...labels, name(d, suffix)]);
      owned(d, 'volume', name(d, suffix));
      docker([
        ...maintenanceArgs(d),
        '--network',
        'none',
        '--mount',
        `type=volume,src=${name(d, suffix)},dst=/volume`,
        '--mount',
        `type=bind,src=${scratch},dst=/capture,readonly`,
        '--entrypoint',
        'sh',
        d.release.images.postgres,
        '-c',
        'test -z "$(ls -A /volume)" && tar --keep-old-files -C /volume -xf /capture/' +
          component +
          '-checked.tar',
      ]);
    }
    preflight(d);
    await providers(d);
    if (!isDeepStrictEqual(inventory(d), m.inventory))
      fail('restored rows or native exact versions differ');
    d.state = 'quarantined-integrity-verified';
    replace(join(path, 'instance.json'), d);
    return { instance: d.id, origin: d.origin, state: d.state, verified: false };
  } catch (error) {
    if (d) {
      d.state = 'quarantined-failed';
      replace(join(path, 'instance.json'), d);
      for (const s of [...services, 'postgres', 's3', 'anchor']) stopService(d, s);
    }
    throw error;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
async function verify(d, expectationsPath) {
  if (d.state !== 'quarantined-integrity-verified')
    fail('destination is not ready for verification');
  const expectations = readJson(expectationsPath),
    m = readJson(join(d.path, 'restored-manifest.json')),
    c = configuration(d);
  if (
    expectations.format !== 'loom-recovery-expectations-1' ||
    expectations.instance !== m.inventory.instance ||
    !Array.isArray(expectations.reads) ||
    !expectations.reads.length
  )
    fail('independent expectations required');
  if (
    expectations.reads.length > 100 ||
    expectations.reads.some(
      (entry) =>
        typeof entry.path !== 'string' ||
        !entry.path.startsWith('/api/v1/') ||
        /[\x00-\x1f\x7f]/.test(entry.path) ||
        new URL(entry.path, c.origin).origin !== c.origin ||
        typeof entry.token !== 'string' ||
        entry.token.length > 1024 ||
        /[\x00-\x1f\x7f]/.test(entry.token),
    )
  )
    fail('unsafe recovery expectation; only bounded local API requests are allowed');
  const source = existsSync(join(m.source.path, 'instance.json'))
    ? readInstance(m.source.path)
    : undefined;
  if (source && source.owner !== m.source.owner) fail('source ownership changed');
  const unlockSource = source ? lock(source, 'restore-verification') : () => {};
  try {
    sourceStopped(m);
    await launch(d, 'api');
    const observations = await verifyRequests(c, expectations, {
      query: (q) => sql(d, q),
      capture: () => inventory(d),
      drain: () => stopService(d, 'api', { clean: true }),
      expectedInventory: m.inventory,
      verifierPolicy: JSON.parse(helper(d, 'verification-policy')),
    });
    sourceStopped(m);
    d.state = 'verified-snapshot';
    replace(join(d.path, 'instance.json'), d);
    json(join(d.path, 'VERIFIED.json'), {
      backupId: m.backupId,
      requests: expectations.reads.length,
      observations: [...observations],
      cutover: false,
    });
    await launch(d, 'api');
    return { state: d.state, requests: expectations.reads.length, cutover: false };
  } catch (error) {
    stopService(d, 'api');
    d.state = 'quarantined-failed';
    replace(join(d.path, 'instance.json'), d);
    throw error;
  } finally {
    unlockSource();
  }
}
async function recoverAdministrator(d, options) {
  if (options['confirm-instance'] !== d.id)
    fail('explicit instance identity required for deployment recovery');
  await providers(d);
  await checkHistory(d);
  const participant = sql(
    d,
    'SELECT administrator_id FROM loom.identity_initialization WHERE id=1',
  );
  if (!/^[a-f0-9-]{36}$/.test(participant)) fail('initialized administrator required');
  const active = JSON.parse(
    sql(
      d,
      `SELECT coalesce(json_agg(id),'[]') FROM loom.participant_credentials WHERE participant_id='${participant}' AND kind='enrollment' AND state='active'`,
    ),
  );
  if (active.length > 1 && !options['replace-credential'])
    fail('ambiguous active enrollment; inspect credential metadata before recovery');
  const replaceCredential = options['replace-credential'] ?? active[0] ?? null;
  if (replaceCredential !== null && !/^[a-f0-9-]{36}$/.test(replaceCredential))
    fail('invalid replacement credential ID');
  const output = join(d.path, 'recovery-' + randomUUID());
  mkdirSync(output, { mode: 0o700 });
  const request = { key: randomUUID(), replace: replaceCredential };
  replace(join(d.path, 'recovery-request.json'), request);
  helper(d, 'recover', { operator: true, output });
  if (d.state === 'initialization-interrupted') {
    d.enrollmentLocation = join(output, 'enrollment.json');
    replace(join(d.path, 'instance.json'), d);
  }
  return {
    enrollment: join(output, 'enrollment.json'),
    participant,
    warning: 'Redemption revokes old passkeys and sessions; ticket expiry remains one hour.',
  };
}
async function update(d, options) {
  if (options['confirm-instance'] !== d.id)
    fail('explicit instance identity required for update');
  configuration(d);
  // Freeze the candidate before stopping the source. Provider/platform changes are unsupported.
  const candidatePath = join(d.path, 'update-' + randomUUID());
  mkdirSync(candidatePath, { mode: 0o700 });
  const candidate = snapshotRelease(candidatePath);
  if (
    !isDeepStrictEqual(candidate.images, d.release.images) ||
    candidate.platform !== d.release.platform
  )
    fail('provider or platform upgrade unsupported');
  const prior = await readMigrations(join(d.path, 'release/db/migrations')),
    next = await readMigrations(join(candidatePath, 'release/db/migrations'));
  if (
    next.length < prior.length ||
    prior.some((m, i) => m.filename !== next[i].filename || m.sha256 !== next[i].sha256)
  )
    fail('only additive migration transitions supported');
  await capture(d, options.backup, options['key-file']);
  const journal = {
    format: policy,
    previous: d.release,
    candidate,
    backup: options.backup,
    phase: 'backup-complete',
    candidatePath,
  };
  if (existsSync(join(d.path, 'update.json')))
    renameSync(
      join(d.path, 'update.json'),
      join(d.path, 'update-history-' + randomUUID() + '.json'),
    );
  json(join(d.path, 'update.json'), journal);
  d.state = 'update-interrupted';
  replace(join(d.path, 'instance.json'), d);
  return resumeUpdate(d, options);
}
async function resumeUpdate(d, options) {
  if (options['confirm-instance'] !== d.id)
    fail('explicit instance identity required for update recovery');
  const journal = readJson(join(d.path, 'update.json'));
  if (
    journal.format !== policy ||
    !inside(d.path, journal.candidatePath) ||
    !['backup-complete', 'migrations-committed', 'selected-stopped'].includes(journal.phase)
  )
    fail('ambiguous update journal');
  const { previous, candidate, candidatePath } = journal;
  if (
    !isDeepStrictEqual(previous.images, candidate.images) ||
    previous.platform !== candidate.platform ||
    ![previous.sha256, candidate.sha256].includes(d.release.sha256)
  )
    fail('incompatible interrupted update');
  const selected = join(d.path, 'release'),
    candidateFiles = join(candidatePath, 'release'),
    oldFiles = join(candidatePath, 'previous-release');
  // Equal source files can still produce a different immutable image. The physical
  // candidate slot, not hash equality with the old selection, identifies the phase.
  const target = existsSync(candidateFiles) ? candidateFiles : selected;
  if (target === selected && !matchesReleaseFiles(oldFiles, previous))
    fail('ambiguous selected release');
  if (!matchesReleaseFiles(target, candidate))
    fail('candidate release missing; keep source stopped');
  const c = readJson(join(d.path, 'config.json'));
  if (![previous.sha256, candidate.sha256].includes(c.release?.sha256))
    fail('configuration does not belong to interrupted update');
  // Selection writes are recoverable only within these two recorded release identities.
  if (target === selected) {
    d.release = candidate;
    c.release = candidate;
    replace(join(d.path, 'instance.json'), d);
    saveConfiguration(d, c);
  } else if (!matchesReleaseFiles(selected, previous)) {
    if (!existsSync(selected) && matchesReleaseFiles(oldFiles, previous))
      renameSync(oldFiles, selected);
    else fail('ambiguous selected release');
  }
  preflight(d);
  await providers(d);
  const next = await readMigrations(join(target, 'db/migrations'));
  sql(d, migrationSql(next), true);
  journal.phase = 'migrations-committed';
  replace(join(d.path, 'update.json'), journal);
  stopAll(d);
  for (const s of [...services, 'postgres', 's3', 'anchor'])
    if (resourceExists('container', name(d, s))) docker(['rm', name(d, s)]);
  if (target !== selected) {
    renameSync(selected, oldFiles);
    renameSync(candidateFiles, selected);
  }
  d.release = candidate;
  c.release = candidate;
  d.state = 'ready';
  replace(join(d.path, 'instance.json'), d);
  saveConfiguration(d, c);
  journal.phase = 'selected-stopped';
  replace(join(d.path, 'update.json'), journal);
  return {
    state: 'updated-stopped',
    backup: journal.backup,
    next: 'start explicitly; old binary is not database rollback',
  };
}

export async function maintenance(action, options) {
  const d = readInstance(options.instance);
  engine();
  const unlock = lock(d, action);
  try {
    if (action === 'restore') return await restoreSnapshot(d, options);
    if (action === 'recover-initialization') {
      if (options['confirm-instance'] !== d.id || d.state !== 'initialization-interrupted')
        fail('explicit interrupted initialization identity required');
      preflight(d);
      await providers(d);
      sql(d, migrationSql(await readMigrations(join(d.path, 'release/db/migrations'))), true);
      const output = join(d.path, 'enrollment');
      if (!existsSync(output)) mkdirSync(output, { mode: 0o700 });
      if (sql(d, 'SELECT count(*) FROM loom.identity_initialization') === '0')
        helper(d, 'provision', { operator: true, output });
      else if (!existsSync(d.enrollmentLocation ?? join(output, 'enrollment.json')))
        fail(
          'bootstrap exists but ticket delivery is uncertain; run recover-administrator explicitly',
        );
      helper(d, 'ready');
      d.state = 'ready';
      replace(join(d.path, 'instance.json'), d);
      stopAll(d);
      return {
        state: 'initialized-stopped',
        enrollment: d.enrollmentLocation ?? join(output, 'enrollment.json'),
      };
    }
    if (action === 'witness') {
      const c = configuration(d),
        requests = readJson(options.requests);
      if (
        requests.format !== 'loom-pilot-witness-1' ||
        !Array.isArray(requests.reads) ||
        !requests.reads.length ||
        requests.reads.length > 100
      )
        fail('bounded witness request list required');
      privatePath(options.output, { fresh: true });
      const reads = [];
      let instance;
      for (const entry of requests.reads) {
        if (
          typeof entry.path !== 'string' ||
          !entry.path.startsWith('/api/v1/') ||
          entry.path.includes('..') ||
          !Number.isInteger(entry.expected_status) ||
          entry.expected_status < 200 ||
          entry.expected_status > 499 ||
          (entry.body !== undefined && !/\/(query|lookup|status)$/.test(entry.path))
        )
          fail('witness accepts explicit read-only API requests');
        privatePath(entry.credential_file);
        const token = readPrivateText(entry.credential_file, 2048).trim();
        if (token.length > 1024) fail('invalid participant credential file');
        const community = await httpsCall(
          c.origin,
          c.tls.ca,
          '/api/v1/community',
          undefined,
          token,
        );
        if (community.status !== 200 || !community.body.instance_id)
          fail('witness identity unavailable');
        if (instance && instance !== community.body.instance_id)
          fail('witness installation changed');
        instance = community.body.instance_id;
        const expected = comparable(
          await httpsCall(c.origin, c.tls.ca, entry.path, entry.body, token),
          entry.path,
        );
        if (expected.status !== entry.expected_status)
          fail('witness status differs; no expectation published');
        reads.push({
          token,
          path: entry.path,
          ...(entry.body === undefined ? {} : { body: entry.body }),
          expected,
        });
      }
      json(options.output, { format: 'loom-recovery-expectations-1', instance, reads });
      return {
        expectations: options.output,
        requests: reads.length,
        meaning: 'observed before capture; protect like credentials',
      };
    }
    if (action === 'inspect') {
      const scratch = mkdtempSync(join(tmpdir(), 'loom-pilot-inspect-'));
      try {
        const { manifest: m } = bundle(d).read(
          privatePath(options.backup),
          keyMaterial(options['key-file'], [d.path, options.backup]),
          scratch,
        );
        return {
          status: 'integrity-checked; application verification pending',
          backupId: m.backupId,
          boundary: m.boundary,
        };
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    }
    if (action === 'destroy-test') {
      if (
        d.kind !== 'acceptance' ||
        options['test-owner'] !== d.testOwner ||
        options['confirm-instance'] !== d.id
      )
        fail('destruction is restricted to the exact acceptance owner and instance');
      // Validate every existing target before the first removal. Retained instances have no delete command.
      for (const s of [...services, 'maintenance', 'postgres', 's3', 'anchor'])
        if (resourceExists('container', name(d, s))) owned(d, 'container', name(d, s));
      for (const s of ['postgres-data', 's3-data'])
        if (resourceExists('volume', name(d, s))) owned(d, 'volume', name(d, s));
      if (resourceExists('network', name(d, 'network')))
        owned(d, 'network', name(d, 'network'));
      for (const s of [...services, 'maintenance', 'postgres', 's3', 'anchor'])
        if (resourceExists('container', name(d, s))) docker(['rm', '--force', name(d, s)]);
      for (const s of ['postgres-data', 's3-data'])
        if (resourceExists('volume', name(d, s))) docker(['volume', 'rm', name(d, s)]);
      if (resourceExists('network', name(d, 'network')))
        docker(['network', 'rm', name(d, 'network')]);
      return { removed: d.id, testOwner: d.testOwner };
    }
    if (action === 'resume-update') return await resumeUpdate(d, options);
    preflight(d);
    if (action === 'backup') return await capture(d, options.backup, options['key-file']);
    if (action === 'verify') return await verify(d, options.expectations);
    if (action === 'recover-administrator') return await recoverAdministrator(d, options);
    if (action === 'update') return await update(d, options);
    fail('unknown maintenance action');
  } finally {
    unlock();
  }
}
