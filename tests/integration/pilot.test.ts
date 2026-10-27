import { expiredLeaf } from '../helpers/pilot-certificate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, cpSync, unlinkSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import {
  pilotFixture,
  populatePilot,
  pilotCommand,
  freePort,
  sql,
  owned,
  name,
  until,
  readInstance,
  plain,
} from '../helpers/pilot.js';
import { docker, replace } from '../../scripts/lib/pilot-files.mjs';
import { httpsCall } from '../../scripts/lib/recovery.mjs';

test(
  'pilot enrollment tickets remain owner-only through initialization and administrator recovery',
  { timeout: 240000 },
  async (t) => {
    // Linux CI must exercise a real non-root host operator, not mask bind-mount
    // ownership with root access or Docker Desktop's host-file translation.
    if (process.platform === 'linux') assert.notEqual(process.getuid!(), 0);
    const outputs: string[] = [];
    let f: any;
    t.after(async () => {
      await f?.close();
    });
    f = await pilotFixture(
      (fixture) => {
        f = fixture;
      },
      undefined,
      ({ stdout, stderr }) => {
        outputs.push(stdout, stderr);
      },
    );
    const d = f.instance();
    function ticketAt(path: string) {
      const stat = lstatSync(path);
      assert.ok(stat.isFile() && !stat.isSymbolicLink());
      assert.equal(stat.uid, process.getuid!(), 'ticket belongs to the host operator');
      assert.equal(stat.gid, lstatSync(f.path).gid, 'ticket retains host custody group');
      assert.equal(stat.mode & 0o777, 0o600);
      assert.equal(stat.nlink, 1);
      const bytes = readFileSync(path, 'utf8');
      const ticket = JSON.parse(bytes);
      assert.ok(typeof ticket.ticket === 'string' && ticket.ticket.length > 20);
      if (process.platform === 'linux') {
        // Mount the file directly, so denial proves 0600 protects the ticket
        // independently of its private parent directories. No secret is printed.
        const stranger = stat.uid === 65534 ? 65533 : 65534;
        const result = docker([
          'run',
          '--rm',
          '--name',
          d.id + '-ticket-permissions',
          '--label',
          'org.loom.kind=acceptance',
          '--label',
          'org.loom.test-owner=' + f.testOwner,
          '--label',
          'org.loom.instance=' + d.id,
          '--label',
          'org.loom.local-pilot=' + d.owner,
          '--network',
          'none',
          '--read-only',
          '--cap-drop',
          'ALL',
          '--security-opt',
          'no-new-privileges',
          '--user',
          stranger + ':' + stranger,
          '--mount',
          `type=bind,src=${path},dst=/ticket,readonly`,
          d.release.images.node,
          'node',
          '-e',
          "try { require('node:fs').readFileSync('/ticket'); process.exit(2); } catch (e) { process.exit(e.code === 'EACCES' ? 0 : 3); }",
        ]);
        assert.equal(result, '');
      }
      return { bytes, ...ticket };
    }
    const initialPath = join(f.path, 'enrollment/enrollment.json');
    const initial = ticketAt(initialPath);
    const { httpClient } = await import('../helpers/participation-http.js');
    const c = f.config(),
      admin = httpClient(c.origin, c.tls.ca);
    const human = await admin.enroll(initial.ticket);
    assert.equal(human.participant_id, initial.administratorId);
    const recovery = await f.command('recover-administrator', { 'confirm-instance': d.id });
    const replacement = ticketAt(recovery.enrollment);
    assert.equal(replacement.administratorId, human.participant_id);
    assert.ok(replacement.ticket !== initial.ticket, 'recovery is a new one-time issuance');
    assert.ok(readFileSync(initialPath, 'utf8') === initial.bytes, 'initial ticket is untouched');
    const recovered = httpClient(c.origin, c.tls.ca);
    assert.equal((await recovered.enroll(replacement.ticket)).participant_id, human.participant_id);
    assert.equal((await admin.call('/api/v1/identity/self')).status, 401);
    await f.command('restart');
    assert.ok(readFileSync(recovery.enrollment, 'utf8') === replacement.bytes);
    assert.equal(f.instance().release.image, d.release.image, 'handoff preserves the selected image');
    for (const service of [
      'anchor',
      'postgres',
      's3',
      'api',
      'search',
      'notifications',
      'file-text',
    ]) {
      owned(d, 'container', name(d, service));
      const logs = spawnSync('docker', ['logs', '--tail', '100', name(d, service)], {
        encoding: 'utf8',
        timeout: 10000,
        maxBuffer: 128 * 1024,
      });
      assert.ok(!logs.error && logs.status === 0, 'bounded owned-container logs available');
      outputs.push(logs.stdout, logs.stderr);
      if (['api', 'search', 'notifications', 'file-text'].includes(service))
        await f.command('logs', { service });
    }
    for (const ticket of [initial.ticket, replacement.ticket])
      assert.ok(
        outputs.every((output) => !output.includes(ticket)),
        'ticket absent from command output and logs',
      );
  },
);

// Actual CLI, immutable compiled image, real providers, default policy and real TLS.
// Each teardown is gated by both acceptance owner and exact installation identity.
test(
  'pilot CLI retains exact community across stop, start, container replacement and isolated encrypted recovery',
  { timeout: 240000 },
  async (t) => {
    let f: any, destination: string | undefined;
    t.after(async () => {
      if (destination && existsSync(join(destination, 'instance.json'))) {
        const d = readInstance(destination);
        await pilotCommand('destroy-test', destination, {
          'test-owner': f.testOwner,
          'confirm-instance': d.id,
        });
      }
      await f?.close();
    });
    f = await pilotFixture((x) => {
      f = x;
    });
    const p = await populatePilot(f);
    const identity = p.human.participant_id,
      origin = p.c.origin,
      instance = p.d.id;
    const before = sql(p.d, 'SELECT row_to_json(t) FROM loom.identity_initialization t');
    const originalIds = Object.fromEntries(
      ['api', 'postgres', 's3'].map((s) => [s, owned(p.d, 'container', name(p.d, s)).Id]),
    );
    const current = () => readInstance(f.path);
    await f.command('stop');
    await f.command('start');
    assert.equal((await p.admin.call('/api/v1/identity/self')).body.participant_id, identity);
    for (const s of Object.keys(originalIds))
      assert.equal(owned(p.d, 'container', name(p.d, s)).Id, originalIds[s]);
    await f.command('recreate');
    for (const s of Object.keys(originalIds))
      assert.notEqual(owned(p.d, 'container', name(p.d, s)).Id, originalIds[s]);
    assert.equal(current().origin, origin);
    assert.equal(current().id, instance);
    assert.equal(sql(p.d, 'SELECT row_to_json(t) FROM loom.identity_initialization t'), before);
    await p.verifyReads();
    const history = sql(p.d, 'SELECT count(*) FROM loom.revisions');
    assert.equal(
      (await p.alice.client.call('/api/v1/artifacts', p.originalCommand)).body.revision_id,
      p.first.revision_id,
    );
    assert.equal(sql(p.d, 'SELECT count(*) FROM loom.revisions'), history);
    const key = join(f.directory, 'backup-key');
    writeFileSync(key, randomBytes(32).toString('base64url'), { mode: 0o600 });
    const backup = join(f.directory, 'backup');
    await f.command('backup', { backup, 'key-file': key });
    assert.equal((await f.command('status')).apiReady, false);
    await f.command('inspect', { backup, 'key-file': key });
    // Explicit test-only destruction proves recovery cannot read the source providers.
    await f.command('destroy-test', { 'test-owner': f.testOwner, 'confirm-instance': p.d.id });
    for (const file of ['config.json', 'runtime.json', 'postgres.env', 'storage.env', 'ca.pem'])
      unlinkSync(join(f.path, file));
    await assert.rejects(f.command('start'));
    destination = join(f.directory, 'restored');
    const restored = await f.command('restore', {
      backup,
      'key-file': key,
      destination,
      port: String(await freePort()),
    });
    assert.equal(restored.verified, false);
    assert.notEqual(restored.origin, origin);
    await assert.rejects(pilotCommand('start', destination));
    const unsafe = join(f.directory, 'unsafe-expectation.json');
    const changed = JSON.parse(readFileSync(p.expectations, 'utf8'));
    changed.reads[0].path = 'https://127.0.0.1:9/api/v1/community';
    writeFileSync(unsafe, JSON.stringify(changed), { mode: 0o600 });
    await assert.rejects(
      pilotCommand('verify', destination, { expectations: unsafe }),
      /unsafe recovery expectation/,
    );
    assert.equal(readInstance(destination).state, 'quarantined-integrity-verified');
    await pilotCommand('verify', destination, { expectations: p.expectations });
    const c = JSON.parse(readFileSync(join(destination, 'config.json'), 'utf8'));
    await p.verifyReads(c.origin, c.tls.ca);
    const { httpClient } = await import('../helpers/participation-http.js');
    const separate = httpClient(c.origin, c.tls.ca);
    assert.equal(
      (
        await separate.call('/api/v1/identity/self', undefined, {
          headers: { cookie: p.admin.cookieHeader() },
        })
      ).status,
      401,
      'snapshot does not automatically accept source browser cookies',
    );
    assert.equal(
      sql(
        readInstance(destination),
        'SELECT instance_id FROM loom.community_settings WHERE id=1',
      ),
      sqlFromSnapshot(p),
    );
    const incomplete = join(f.directory, 'incomplete');
    cpSync(backup, incomplete, { recursive: true });
    unlinkSync(join(incomplete, 'COMPLETED.json'));
    await assert.rejects(f.command('inspect', { backup: incomplete, 'key-file': key }));
    const corrupt = join(f.directory, 'corrupt');
    cpSync(backup, corrupt, { recursive: true });
    writeFileSync(join(corrupt, 'seaweed.gpg'), 'corrupted', { mode: 0o600 });
    const refused = join(f.directory, 'refused');
    await assert.rejects(
      f.command('restore', {
        backup: corrupt,
        'key-file': key,
        destination: refused,
        port: String(await freePort()),
      }),
    );
    assert.equal(existsSync(refused), false);
    function sqlFromSnapshot(p: any) {
      return JSON.parse(readFileSync(p.expectations, 'utf8')).instance;
    }
  },
);

test(
  'pilot actual worker and provider outages retain original effects and exact files',
  { timeout: 240000 },
  async (t) => {
    let f: any;
    t.after(async () => {
      await f?.close();
    });
    f = await pilotFixture((x) => {
      f = x;
    });
    const p = await populatePilot(f);
    // Each actual worker is stopped independently while the other two remain running.
    await f.command('worker-stop', { service: 'search' });
    const indexed = await p.accepted(p.alice.client, '/api/v1/artifacts', {
      idempotency_key: randomUUID(),
      area_id: p.area,
      title: 'Search outage',
      content: plain('authoredpendingtoken'),
    });
    assert.equal(
      (await p.alice.client.call('/api/v1/search?q=authoredpendingtoken')).body.items.length,
      0,
    );
    assert.equal(
      (await p.alice.client.call('/api/v1/resources/' + indexed.resource_id)).body.content.text,
      'authoredpendingtoken',
    );
    assert.equal(
      (await p.alice.client.call('/api/v1/search/status')).body.coverage,
      'not_established',
    );
    await f.command('worker-start', { service: 'search' });
    await until(
      async () =>
        (await p.alice.client.call('/api/v1/search?q=authoredpendingtoken')).body.items.some(
          (x: any) => x.revision_id === indexed.revision_id,
        ),
      'exact search revision',
    );
    await f.command('worker-stop', { service: 'file-text' });
    const member = await p.upload(p.area, 'pending.txt', Buffer.from('workerpendingtoken'));
    const artifact = await p.accepted(p.alice.client, '/api/v1/artifacts', {
      idempotency_key: randomUUID(),
      area_id: p.area,
      title: 'Worker pending artifact',
      content: plain('File processing'),
      file_set: { version: 'artifact-files-v1', files: [member] },
    });
    const files = (
      await p.alice.client.call(
        `/api/v1/artifacts/${artifact.resource_id}/revisions/${artifact.revision_id}/files`,
      )
    ).body.items;
    assert.equal((await p.alice.client.call(files[0].download_url)).body, 'workerpendingtoken');
    assert.equal(
      (await p.alice.client.call('/api/v1/search/files?q=workerpendingtoken')).body.items
        .length,
      0,
    );
    await f.command('worker-start', { service: 'file-text' });
    await until(
      async () =>
        (
          await p.alice.client.call('/api/v1/search/files?q=workerpendingtoken')
        ).body.items.some((x: any) => x.file_id === files[0].file_id),
      'exact extracted file',
    );
    assert.equal(
      sql(p.d, `SELECT body FROM loom.file_text_documents WHERE file_id='${files[0].file_id}'`),
      'workerpendingtoken',
    );
    await f.command('worker-stop', { service: 'notifications' });
    const checkpoint = (await p.accepted(p.alice.client, '/api/v1/me/notifications/query', {}))
      .checkpoint;
    const delayed = await p.accepted(p.bob.client, '/api/v1/replies', {
      idempotency_key: randomUUID(),
      discussion_id: p.discussion,
      parent_id: p.opening.resource_id,
      content: plain('Delayed worker evidence'),
    });
    const state = await f.command('status');
    assert.equal(state.apiReady, true);
    assert.equal(state.services.notifications.state, 'exited');
    for (const service of ['search', 'file-text'])
      assert.equal(state.services[service].state, 'running');
    assert.equal(
      sql(
        p.d,
        `SELECT count(*) FROM loom.notification_signals WHERE revision_id='${delayed.revision_id}'`,
      ),
      '0',
    );
    await f.command('worker-start', { service: 'notifications' });
    await until(
      () =>
        sql(
          p.d,
          `SELECT count(*) FROM loom.notification_signals WHERE revision_id='${delayed.revision_id}'`,
        ) === '1',
      'one original notification',
    );
    const page = await p.accepted(p.alice.client, '/api/v1/me/notifications/query', {
      checkpoint,
    });
    assert.ok(page.items.some((x: any) => x.source.revision_id === delayed.revision_id));
    await f.command('worker-stop', { service: 'notifications' });
    await f.command('worker-start', { service: 'notifications' });
    assert.equal(
      sql(
        p.d,
        `SELECT count(*) FROM loom.notification_signals WHERE revision_id='${delayed.revision_id}'`,
      ),
      '1',
    );
    assert.equal(
      (
        await p.accepted(p.alice.client, '/api/v1/me/notifications/query', {
          checkpoint: page.checkpoint,
        })
      ).items.length,
      0,
    );
    for (const service of ['postgres', 's3']) {
      owned(p.d, 'container', name(p.d, service));
      docker(['stop', '--time', '60', name(p.d, service)]);
      if (service === 'postgres')
        assert.equal((await httpsCall(p.c.origin, p.c.tls.ca, '/health/ready')).status, 503);
      else
        assert.equal(
          (await httpsCall(p.c.origin, p.c.tls.ca, p.downloads[0], undefined, p.alice.token))
            .status,
          503,
        );
      docker(['start', name(p.d, service)]);
      await until(async () => {
        try {
          return (
            (await httpsCall(p.c.origin, p.c.tls.ca, p.downloads[0], undefined, p.alice.token))
              .status === 200
          );
        } catch {
          return false;
        }
      }, 'provider restored');
    }
    for (const [i, url] of p.downloads.entries())
      assert.equal(
        (await httpsCall(p.c.origin, p.c.tls.ca, url, undefined, p.alice.token)).body,
        p.bytes[i]!.toString('base64'),
      );
    const exact = JSON.parse(
      sql(
        p.d,
        `SELECT row_to_json(u) FROM loom.file_uploads u JOIN loom.file_contexts f ON f.upload_id=u.id WHERE f.artifact_id='${p.first.resource_id}' AND f.revision_id='${p.first.revision_id}' LIMIT 1`,
      ),
    );
    owned(p.d, 'container', name(p.d, 'api'));
    docker(['exec', '-i', name(p.d, 'api'), 'node', '--input-type=module'], {
      input: `
    import {readFileSync} from 'node:fs';
    import {S3Client,PutObjectCommand,DeleteObjectCommand} from '@aws-sdk/client-s3';
    const c=JSON.parse(readFileSync('/custody/runtime.json'));const s=new S3Client({endpoint:'http://127.0.0.1:8333',region:'us-east-1',forcePathStyle:true,credentials:{accessKeyId:c.storage.accessKeyId,secretAccessKey:c.storage.secretAccessKey}});
    try{const Key='artifact-files-v1/${exact.id}',Bucket=c.storage.finalBucket;
    await s.send(new PutObjectCommand({Bucket,Key,Body:Buffer.from('Wrong replacement bytes')}));
    await s.send(new DeleteObjectCommand({Bucket,Key,VersionId:${JSON.stringify(exact.final_version)}}));
    s.destroy();}catch{process.exit(1);}
  `,
    });
    assert.equal(
      (await httpsCall(p.c.origin, p.c.tls.ca, p.downloads[0], undefined, p.alice.token))
        .status,
      503,
    );
    assert.equal(
      (await httpsCall(p.c.origin, p.c.tls.ca, p.downloads[1], undefined, p.alice.token)).body,
      p.bytes[1]!.toString('base64'),
    );
    const key = join(f.directory, 'key');
    writeFileSync(key, randomBytes(32).toString('base64url'), { mode: 0o600 });
    const failed = join(f.directory, 'missing-native-version');
    await assert.rejects(f.command('backup', { backup: failed, 'key-file': key }));
    assert.equal(existsSync(join(failed, 'COMPLETED.json')), false);
  },
);

test(
  'pilot refuses unsafe lifecycle, custody and schema changes without replacement data',
  { timeout: 240000 },
  async (t) => {
    let f: any;
    t.after(async () => {
      await f?.close();
    });
    f = await pilotFixture((x) => {
      f = x;
    });
    const d = f.instance(),
      c = f.config();
    const configBytes = readFileSync(join(f.path, 'config.json'));
    await assert.rejects(
      f.command('destroy-test', { 'test-owner': randomUUID(), 'confirm-instance': d.id }),
    );
    const volumes = ['postgres-data', 's3-data'].map(
      (s) => owned(d, 'volume', name(d, s)).Name,
    );
    await assert.rejects(
      f.command('init', {
        port: String(await freePort()),
        acknowledge: 'local-pilot-1',
        'test-owner': f.testOwner,
      }),
    );
    assert.ok(readFileSync(join(f.path, 'config.json')).equals(configBytes));
    const ticketBytes = readFileSync(join(f.path, 'enrollment/enrollment.json'));
    await f.command('stop');
    replace(join(f.path, 'instance.json'), { ...d, state: 'initialization-interrupted' });
    await assert.rejects(f.command('start'));
    await f.command('recover-initialization', { 'confirm-instance': d.id });
    assert.ok(
      readFileSync(join(f.path, 'enrollment/enrollment.json')).equals(ticketBytes),
      'partial metadata recovery does not reissue enrollment',
    );
    assert.ok(
      readFileSync(join(f.path, 'config.json')).equals(configBytes),
      'partial metadata recovery does not replace custody',
    );
    await f.command('start');
    const { createServer } = await import('node:net');
    const port = await freePort();
    const listener = createServer();
    await new Promise<void>((r) => listener.listen(port, '127.0.0.1', r));
    const blocked = join(f.directory, 'occupied');
    try {
      await assert.rejects(
        pilotCommand('init', blocked, {
          port: String(port),
          acknowledge: 'local-pilot-1',
          'test-owner': f.testOwner,
        }),
      );
      assert.equal(existsSync(blocked), false);
    } finally {
      await new Promise<void>((r) => listener.close(() => r()));
    }
    const pending = f.command('restart');
    await until(() => existsSync(join(f.path, 'operation.lock')), 'actual lifecycle lock');
    await assert.rejects(f.command('stop'));
    await pending;
    const { lock } = await import('../../scripts/lib/pilot-files.mjs');
    const unlock = lock(d, 'test');
    try {
      await assert.rejects(f.command('stop'));
      assert.equal((await httpsCall(c.origin, c.tls.ca, '/health/ready')).status, 200);
    } finally {
      unlock();
    }
    const identityPath = join(f.path, 'instance.json');
    replace(identityPath, { ...d, owner: 'a'.repeat(64) });
    await assert.rejects(f.command('stop'));
    replace(identityPath, d);
    writeFileSync(join(f.path, 'config.json'), '{damaged', { mode: 0o600 });
    await assert.rejects(f.command('start'));
    writeFileSync(join(f.path, 'config.json'), configBytes, { mode: 0o600 });
    const { saveConfiguration } = await import('../../scripts/lib/pilot.mjs');
    const bad = structuredClone(c);
    bad.tls.key = bad.tls.caKey;
    saveConfiguration(d, bad);
    await assert.rejects(f.command('start'));
    saveConfiguration(d, c);
    await f.command('stop');
    // Ahead-of-release history must fail before any API/worker resumes.
    const { providers } = await import('../../scripts/lib/pilot.mjs');
    await providers(d);
    sql(
      d,
      "INSERT INTO loom_migrations.history(version,filename,sha256) VALUES ('9999','9999_foreign.sql',repeat('a',64))",
    );
    await assert.rejects(f.command('start'));
    assert.equal(owned(d, 'container', name(d, 'api')).State.Running, false);
    sql(d, "DELETE FROM loom_migrations.history WHERE version='9999'");
    const original = sql(d, "SELECT sha256 FROM loom_migrations.history WHERE version='0001'");
    sql(d, "UPDATE loom_migrations.history SET sha256=repeat('a',64) WHERE version='0001'");
    await assert.rejects(f.command('start'));
    sql(d, `UPDATE loom_migrations.history SET sha256='${original}' WHERE version='0001'`);
    saveConfiguration(d, { ...c, tls: expiredLeaf(f.directory, c.tls) });
    await assert.rejects(f.command('start'));
    await f.command('renew-certificate');
    await f.command('start');
    const renewed = f.config();
    assert.equal(renewed.origin, c.origin);
    assert.equal(renewed.tls.ca, c.tls.ca);
    assert.notEqual(renewed.tls.cert, c.tls.cert);
    assert.equal((await httpsCall(c.origin, c.tls.ca, '/health/ready')).status, 200);
    assert.equal((await httpsCall(c.origin, c.tls.ca, '/api/v1/identity/self')).status, 401);
    for (const v of volumes) assert.equal(owned(d, 'volume', v).Name, v);
    await f.command('stop');
    for (const s of ['postgres']) {
      owned(d, 'container', name(d, s));
      docker(['rm', name(d, s)]);
    }
    owned(d, 'volume', name(d, 'postgres-data'));
    docker(['volume', 'rm', name(d, 'postgres-data')]);
    await assert.rejects(f.command('start'));
    assert.equal(
      docker([
        'volume',
        'ls',
        '--filter',
        'name=^' + name(d, 'postgres-data') + '$',
        '--format',
        '{{.Name}}',
      ]),
      '',
    );
    assert.equal(owned(d, 'volume', name(d, 's3-data')).Name, name(d, 's3-data'));
  },
);

test(
  'pilot populated explicit no-op update and audited administrator recovery preserve identity and outcomes',
  { timeout: 240000 },
  async (t) => {
    let f: any;
    t.after(async () => {
      await f?.close();
    });
    f = await pilotFixture((x) => {
      f = x;
    });
    const p = await populatePilot(f);
    const originalInitialization = sql(
      p.d,
      'SELECT row_to_json(t) FROM loom.identity_initialization t',
    );
    const key = join(f.directory, 'key');
    writeFileSync(key, randomBytes(32).toString('base64url'), { mode: 0o600 });
    const credential = join(f.directory, 'agent');
    writeFileSync(credential, p.alice.token, { mode: 0o600 });
    const request = join(f.directory, 'witness-requests.json'),
      witness = join(f.directory, 'witness.json');
    writeFileSync(
      request,
      JSON.stringify({
        format: 'loom-pilot-witness-1',
        reads: [
          { credential_file: credential, path: p.downloads[0], expected_status: 200 },
          {
            credential_file: credential,
            path: '/api/v1/operations/status',
            body: {
              operation_kind: 'artifact.create',
              idempotency_key: p.originalCommand.idempotency_key,
            },
            expected_status: 200,
          },
        ],
      }),
      { mode: 0o600 },
    );
    await f.command('witness', { requests: request, output: witness });
    const observed = JSON.parse(readFileSync(witness, 'utf8'));
    assert.equal(observed.reads[0].expected.body, p.bytes[0]!.toString('base64'));
    assert.equal(observed.reads[1].expected.body.revision_id, p.first.revision_id);
    const migrations = sql(
      p.d,
      'SELECT json_agg(h ORDER BY version) FROM loom_migrations.history h',
    );
    await f.command('update', {
      'confirm-instance': p.d.id,
      backup: join(f.directory, 'pre-update'),
      'key-file': key,
    });
    await f.command('start');
    assert.equal(
      sql(f.instance(), 'SELECT json_agg(h ORDER BY version) FROM loom_migrations.history h'),
      migrations,
    );
    await p.verifyReads();
    // No historical/additive transition is claimed by this same-schema release selection.
    const { unlinkSync } = await import('node:fs');
    unlinkSync(join(f.path, 'enrollment/enrollment.json'));
    const recovery = await f.command('recover-administrator', { 'confirm-instance': p.d.id });
    const ticket = JSON.parse(readFileSync(recovery.enrollment, 'utf8'));
    assert.equal(ticket.administratorId, p.human.participant_id);
    const { httpClient } = await import('../helpers/participation-http.js');
    const replacement = httpClient(p.c.origin, p.c.tls.ca);
    const same = await replacement.enroll(ticket.ticket);
    assert.equal(same.participant_id, p.human.participant_id);
    assert.equal((await p.admin.call('/api/v1/identity/self')).status, 401);
    assert.equal(
      sql(f.instance(), 'SELECT row_to_json(t) FROM loom.identity_initialization t'),
      originalInitialization,
    );
    assert.equal(
      (await p.alice.client.call('/api/v1/artifacts', p.originalCommand)).body.revision_id,
      p.first.revision_id,
    );
  },
);

test(
  'pilot updates populated actual 0028 source to 0029 and resumes an interrupted controller after verified backup',
  { timeout: 240000 },
  async (t) => {
    const { historicalPilot, previousPilotSource, interruptAfterBackup } =
      await import('../helpers/pilot-historical.js');
    let f: any, old: any;
    t.after(async () => {
      await f?.close();
      old?.close();
    });
    old = await historicalPilot((x) => {
      f = x;
    });
    f = old.f;
    const p = await populatePilot(f);
    assert.equal(p.d.release.revision, previousPilotSource);
    assert.equal(sql(p.d, 'SELECT max(version) FROM loom_migrations.history'), '0028');
    const keys = sql(p.d, 'SELECT row_to_json(t) FROM loom.identity_initialization t');
    const key = join(f.directory, 'key');
    writeFileSync(key, randomBytes(32).toString('base64url'), { mode: 0o600 });
    await interruptAfterBackup(f.path, {
      'confirm-instance': p.d.id,
      backup: join(f.directory, 'pre-upgrade'),
      'key-file': key,
    });
    await assert.rejects(pilotCommand('start', f.path));
    await pilotCommand('recover-lock', f.path);
    await pilotCommand('resume-update', f.path, { 'confirm-instance': p.d.id });
    await pilotCommand('start', f.path);
    const next = f.instance();
    assert.notEqual(next.release.applicationSource, p.d.release.applicationSource);
    assert.equal(sql(next, 'SELECT max(version) FROM loom_migrations.history'), '0029');
    assert.equal(sql(next, 'SELECT row_to_json(t) FROM loom.identity_initialization t'), keys);
    await p.verifyReads();
    assert.equal((await p.alice.client.call('/api/v1/admin/operational-health')).status, 403);
    assert.equal(
      sql(
        next,
        "SELECT count(*) FROM information_schema.tables WHERE table_schema='loom' AND table_name='operational_capture'",
      ),
      '1',
    );
  },
);
