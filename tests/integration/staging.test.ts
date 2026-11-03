import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { caddyImage, composeSpec, labelArgs } from '../../scripts/lib/staging-compose.mjs';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, cpSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import {
  stagingFixture,
  populateStaging,
  stagingCommand,
  freePort,
  sql,
  owned,
  name,
  until,
  readInstance,
  plain,
} from '../helpers/staging.js';
import { docker } from '../../scripts/lib/staging-files.mjs';
import { expiredLeaf } from '../helpers/pilot-certificate.mjs';
import { httpsCall } from '../../scripts/lib/staging.mjs';
// Actual CLI, immutable compiled image, real providers, default policy and CA-validated fixture TLS.
// Each teardown is gated by both acceptance owner and exact installation identity.
test(
  'staging CLI retains exact community across stop, start, container replacement and isolated encrypted recovery',
  { timeout: 240000 },
  async (t) => {
    let f: any, destination: string | undefined;
    t.after(async () => {
      if (destination && existsSync(join(destination, 'instance.json'))) {
        const d = readInstance(destination);
        await stagingCommand('destroy-test', destination, {
          'test-owner': f.testOwner,
          'confirm-instance': d.id,
          'confirm-data-loss': 'delete-acceptance-data',
        });
      }
      await f?.close();
    });
    f = await stagingFixture((x) => {
      f = x;
    });
    const p = await populateStaging(f);
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
    assert.equal((await f.command('status')).https.ready, false);
    await f.command('inspect', { backup, 'key-file': key });
    // Explicit test-only destruction proves recovery cannot read the source providers.
    await f.command('destroy-test', {
      'test-owner': f.testOwner,
      'confirm-instance': p.d.id,
      'confirm-data-loss': 'delete-acceptance-data',
    });
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
    await assert.rejects(stagingCommand('start', destination));
    const unsafe = join(f.directory, 'unsafe-expectation.json');
    const changed = JSON.parse(readFileSync(p.expectations, 'utf8'));
    changed.reads[0].path = 'https://127.0.0.1:9/api/v1/community';
    writeFileSync(unsafe, JSON.stringify(changed), { mode: 0o600 });
    await assert.rejects(
      stagingCommand('verify', destination, { expectations: unsafe }),
      /unsafe recovery expectation/,
    );
    assert.equal(readInstance(destination).state, 'quarantined-integrity-verified');
    await stagingCommand('verify', destination, { expectations: p.expectations });
    const c = JSON.parse(readFileSync(join(destination, 'config.json'), 'utf8'));
    await p.verifyReads(c.origin, c.tls.ca);
    const { httpClient } = await import('../helpers/participation-http.js');
    const separate = httpClient(c.origin, c.tls.ca, undefined, c.transport);
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
      sql(readInstance(destination), 'SELECT instance_id FROM loom.community_settings WHERE id=1'),
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
  'staging actual worker and provider outages retain original effects and exact files',
  { timeout: 240000 },
  async (t) => {
    let f: any;
    t.after(async () => {
      await f?.close();
    });
    f = await stagingFixture((x) => {
      f = x;
    });
    const p = await populateStaging(f);
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
      (await p.alice.client.call('/api/v1/search/files?q=workerpendingtoken')).body.items.length,
      0,
    );
    await f.command('worker-start', { service: 'file-text' });
    await until(
      async () =>
        (await p.alice.client.call('/api/v1/search/files?q=workerpendingtoken')).body.items.some(
          (x: any) => x.file_id === files[0].file_id,
        ),
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
    assert.equal(state.https.ready, true);
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
        assert.equal(
          (
            await httpsCall(
              p.c.origin,
              p.c.tls.ca,
              '/health/ready',
              undefined,
              undefined,
              p.c.transport,
            )
          ).status,
          503,
        );
      else
        assert.equal(
          (
            await httpsCall(
              p.c.origin,
              p.c.tls.ca,
              p.downloads[0],
              undefined,
              p.alice.token,
              p.c.transport,
            )
          ).status,
          503,
        );
      docker(['start', name(p.d, service)]);
      await until(async () => {
        try {
          return (
            (
              await httpsCall(
                p.c.origin,
                p.c.tls.ca,
                p.downloads[0],
                undefined,
                p.alice.token,
                p.c.transport,
              )
            ).status === 200
          );
        } catch {
          return false;
        }
      }, 'provider restored');
    }
    for (const [i, url] of p.downloads.entries())
      assert.equal(
        (await httpsCall(p.c.origin, p.c.tls.ca, url, undefined, p.alice.token, p.c.transport))
          .body,
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
    const c=JSON.parse(readFileSync('/custody/runtime.json'));const s=new S3Client({endpoint:'http://s3:8333',region:'us-east-1',forcePathStyle:true,credentials:{accessKeyId:c.storage.accessKeyId,secretAccessKey:c.storage.secretAccessKey}});
    try{const Key='artifact-files-v1/${exact.id}',Bucket=c.storage.finalBucket;
    await s.send(new PutObjectCommand({Bucket,Key,Body:Buffer.from('Wrong replacement bytes')}));
    await s.send(new DeleteObjectCommand({Bucket,Key,VersionId:${JSON.stringify(exact.final_version)}}));
    s.destroy();}catch{process.exit(1);}
  `,
    });
    assert.equal(
      (
        await httpsCall(
          p.c.origin,
          p.c.tls.ca,
          p.downloads[0],
          undefined,
          p.alice.token,
          p.c.transport,
        )
      ).status,
      503,
    );
    assert.equal(
      (
        await httpsCall(
          p.c.origin,
          p.c.tls.ca,
          p.downloads[1],
          undefined,
          p.alice.token,
          p.c.transport,
        )
      ).body,
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
  'staging fixed HTTPS proxy rejects spoofing and preserves audited authorization and one publication after response loss',
  { timeout: 240000 },
  async (t) => {
    let f: any;
    t.after(async () => {
      await f?.close();
    });
    f = await stagingFixture((x) => {
      f = x;
    });
    const p = await populateStaging(f);
    const metadata = await p.accepted(p.alice.client, '/api/v1/community');
    assert.equal(metadata.installation_mode, 'staging');
    assert.equal(
      (
        await httpsCall(
          p.c.origin,
          p.c.tls.ca,
          '/api/v1/runtime',
          undefined,
          undefined,
          p.c.transport,
        )
      ).body.stage,
      'staging-participation',
    );
    const { composeSpec } = await import('../../scripts/lib/staging-compose.mjs');
    const spec = composeSpec(p.d, p.c);
    assert.deepEqual(
      Object.entries(spec.services)
        .filter(([, s]: any) => s.ports)
        .map(([s]) => s),
      ['proxy'],
    );
    for (const s of ['postgres', 's3', 'api', 'search', 'notifications', 'file-text'])
      assert.deepEqual(owned(p.d, 'container', name(p.d, s)).HostConfig.PortBindings, {});
    for (const header of [
      'forwarded',
      'x-forwarded-for',
      'x-forwarded-host',
      'x-forwarded-proto',
      'x-forwarded-port',
      'x-real-ip',
    ])
      assert.equal(
        (
          await p.alice.client.call('/api/v1/identity/self', undefined, {
            headers: { [header]: 'spoof' },
          })
        ).status,
        400,
      );
    assert.equal(
      (
        await p.alice.client.call('/api/v1/identity/self', undefined, {
          headers: { origin: 'https://wrong.example' },
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await p.admin.call(
          '/api/v1/community/setup',
          { idempotency_key: randomUUID() },
          { headers: { origin: 'https://wrong.example' } },
        )
      ).status,
      400,
    );
    assert.ok(p.admin.cookieHeader().includes('__Host-loom-' + p.d.id + '-session='));
    const { request } = await import('node:https');
    const mismatchedHost = await new Promise<number>((resolve, reject) => {
      const url = new URL(p.c.origin);
      const req = request(
        {
          host: '127.0.0.1',
          port: Number(url.port),
          servername: url.hostname,
          ca: p.c.tls.ca,
          agent: false,
          path: '/health/ready',
          headers: { host: 'wrong.example' },
        },
        (res) => {
          res.resume();
          res.once('end', () => resolve(res.statusCode!));
        },
      );
      req.once('error', reject);
      req.end();
    });
    assert.equal(mismatchedHost, 421, 'TLS SNI and HTTP Host cannot disagree');
    const health = await p.accepted(p.admin, '/api/v1/admin/operational-health');
    assert.ok(!JSON.stringify(health).includes('Private exact note'));
    assert.equal((await p.alice.client.call('/api/v1/admin/operational-health')).status, 403);
    const untrusted = await httpsCall(
      p.c.origin,
      undefined,
      '/health/ready',
      undefined,
      undefined,
      p.c.transport,
    ).then(
      () => false,
      (e: any) => ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN'].includes(e.code),
    );
    assert.equal(untrusted, true);
    const wrongName = p.c.origin.replace('loom-staging.test', 'wrong-staging.test');
    await assert.rejects(
      httpsCall(wrongName, p.c.tls.ca, '/health/ready', undefined, undefined, p.c.transport),
      (e: any) => ['ERR_TLS_CERT_ALTNAME_INVALID', 'EPROTO'].includes(e.code),
    );
    // A container on the private network cannot masquerade as the designated proxy.
    const refusal = docker([
      'exec',
      name(p.d, 'search'),
      'node',
      '--input-type=module',
      '-e',
      "const r=await fetch('http://api:3000/health/ready',{headers:{host:'loom-staging.test','x-forwarded-host':'loom-staging.test','x-forwarded-proto':'https','x-forwarded-for':'203.0.113.2'}});console.log(r.status)",
    ]);
    assert.equal(refusal, '400');
    const command = {
      idempotency_key: randomUUID(),
      discussion_id: p.discussion,
      parent_id: p.opening.resource_id,
      content: plain('Lost committed staging reply'),
    };
    const lost = await p.accepted(p.alice.client, '/api/v1/replies', command);
    // The independent client has observed COMMIT; discard its response before restart.
    await f.command('restart');
    const status = await p.accepted(p.alice.client, '/api/v1/operations/status', {
      operation_kind: 'reply.create',
      idempotency_key: command.idempotency_key,
    });
    assert.equal(status.revision_id, lost.revision_id);
    assert.equal(
      (await p.accepted(p.alice.client, '/api/v1/replies', command)).revision_id,
      lost.revision_id,
    );
    assert.equal(
      sql(p.d, `SELECT count(*) FROM loom.revisions WHERE id='${lost.revision_id}'`),
      '1',
    );
    const missing = await p.alice.client.call('/api/v1/identity/self', undefined, {
      headers: { authorization: 'Bearer lost-credential' },
    });
    assert.equal(missing.status, 401);
    const target = { kind: 'discussion', resource_id: p.discussion };
    const decision = await p.accepted(p.admin, '/api/v1/admin/moderation/state', {
      idempotency_key: randomUUID(),
      target,
      suppressed: true,
      expected_version: 1,
    });
    assert.equal(
      (await p.alice.client.call('/api/v1/resources/' + p.opening.resource_id)).status,
      404,
    );
    assert.equal(
      (
        await p.alice.client.call('/api/v1/operations/status', {
          operation_kind: 'reply.create',
          idempotency_key: command.idempotency_key,
        })
      ).status,
      404,
    );
    await p.accepted(p.admin, '/api/v1/admin/moderation/state', {
      idempotency_key: randomUUID(),
      target,
      suppressed: false,
      expected_version: decision.current.version,
    });
    await p.accepted(p.admin, '/api/v1/identity/revoke', {
      idempotency_key: randomUUID(),
      participant_id: p.alice.id,
      credential_id: p.alice.credential,
    });
    assert.equal(
      (
        await p.alice.client.call('/api/v1/operations/status', {
          operation_kind: 'reply.create',
          idempotency_key: command.idempotency_key,
        })
      ).status,
      401,
    );
    assert.equal((await f.command('status')).origin, p.c.origin);
    // Distinct name, expired-chain and unavailable-proxy observations never change origin.
    const { saveConfiguration } = await import('../../scripts/lib/staging.mjs');
    const expired = expiredLeaf(f.directory, p.c.tls, new URL(p.c.origin).hostname);
    saveConfiguration(p.d, { ...p.c, tls: expired });
    docker(['restart', name(p.d, 'proxy')]);
    await until(async () => {
      try {
        await httpsCall(
          p.c.origin,
          p.c.tls.ca,
          '/health/ready',
          undefined,
          undefined,
          p.c.transport,
        );
        return false;
      } catch (e: any) {
        return e.code === 'CERT_HAS_EXPIRED';
      }
    }, 'expired fixture certificate observed');

    assert.equal((await f.command('status')).https.observation, 'certificate-expired');
    saveConfiguration(p.d, p.c);
    docker(['restart', name(p.d, 'proxy')]);
    await until(async () => {
      try {
        return (
          (
            await httpsCall(
              p.c.origin,
              p.c.tls.ca,
              '/health/ready',
              undefined,
              undefined,
              p.c.transport,
            )
          ).status === 200
        );
      } catch {
        return false;
      }
    }, 'certificate restored');
    await assert.rejects(
      httpsCall('https://loom-staging-no-such-dns.invalid', p.c.tls.ca, '/health/ready'),
      (e: any) => e.code === 'ENOTFOUND',
    );
    const retained = readFileSync(join(f.path, 'enrollment/enrollment.json'));
    await f.command('recreate');
    assert.ok(readFileSync(join(f.path, 'enrollment/enrollment.json')).equals(retained));
    await f.command('stop');
    await assert.rejects(
      httpsCall(p.c.origin, p.c.tls.ca, '/health/ready', undefined, undefined, p.c.transport),
      (e: any) => ['ECONNREFUSED', 'ECONNRESET'].includes(e.code),
    );
  },
);

test(
  'staging custody, retained deletion and incompatible schema fail closed; backed-up upgrade preserves exact state',
  { timeout: 240000 },
  async (t) => {
    let f: any;
    t.after(async () => {
      await f?.close();
    });
    f = await stagingFixture((x) => {
      f = x;
    });
    const p = await populateStaging(f);
    await assert.rejects(
      f.command('destroy-test', { 'test-owner': f.testOwner, 'confirm-instance': p.d.id }),
    );
    await assert.rejects(
      f.command('destroy-test', {
        'test-owner': randomUUID(),
        'confirm-instance': p.d.id,
        'confirm-data-loss': 'delete-acceptance-data',
      }),
    );
    const { replace } = await import('../../scripts/lib/staging-files.mjs');
    replace(join(f.path, 'instance.json'), { ...p.d, kind: 'retained', testOwner: undefined });
    await assert.rejects(
      f.command('destroy-test', {
        'test-owner': f.testOwner,
        'confirm-instance': p.d.id,
        'confirm-data-loss': 'delete-acceptance-data',
      }),
    );
    replace(join(f.path, 'instance.json'), p.d);
    sql(
      p.d,
      "INSERT INTO loom_migrations.history(version,filename,sha256) VALUES ('9999','9999_foreign.sql',repeat('a',64))",
    );
    await assert.rejects(f.command('start'));
    assert.equal(owned(p.d, 'container', name(p.d, 'api')).State.Running, false);
    const { providers } = await import('../../scripts/lib/staging.mjs');
    await providers(p.d);
    sql(p.d, "DELETE FROM loom_migrations.history WHERE version='9999'");
    await f.command('start');
    const key = join(f.directory, 'upgrade-key');
    writeFileSync(key, randomBytes(32).toString('base64url'), { mode: 0o600 });
    const result = await f.command('upgrade', {
      'confirm-instance': p.d.id,
      backup: join(f.directory, 'pre-upgrade'),
      'key-file': key,
    });
    assert.equal(result.state, 'updated-stopped');
    assert.equal(owned(p.d, 'volume', name(p.d, 'postgres-data')).Name, name(p.d, 'postgres-data'));
    await f.command('start');
    await p.verifyReads();
    assert.equal(f.instance().origin, p.c.origin);
    // Missing external storage is refused before Compose can create providers.
    await f.command('stop');
    docker(['rm', name(p.d, 'postgres')]);
    docker(['volume', 'rm', name(p.d, 'postgres-data')]);
    await assert.rejects(f.command('start'));
    assert.equal(
      docker([
        'volume',
        'ls',
        '--filter',
        'name=^' + name(p.d, 'postgres-data') + '$',
        '--format',
        '{{.Name}}',
      ]),
      '',
    );
  },
);

test(
  'staging proxy reads private operator-owned configuration on Linux without widening file modes',
  { timeout: 90000 },
  async (t) => {
    const d = {
      id: 'loom-staging-' + randomUUID(),
      owner: randomBytes(32).toString('hex'),
      kind: 'acceptance',
      testOwner: randomUUID(),
      path: '/private/staging',
      origin: 'https://loom-staging.example.com',
      release: { image: 'sha256:unused', images: { caddy: caddyImage } },
    };
    const volume = d.id + '-permissions';
    docker(['volume', 'create', ...labelArgs(d), volume]);
    t.after(() => {
      owned(d, 'volume', volume);
      assert.equal(
        docker([
          'container',
          'ls',
          '--all',
          '--filter',
          'volume=' + volume,
          '--format',
          '{{.Names}}',
        ]),
        '',
      );
      docker(['volume', 'rm', volume]);
    });
    const spec = (
      composeSpec(d, { subnet: '172.30.42.0/24', quarantine: false }).services as Record<
        string,
        { cap_drop: string[]; cap_add: string[] }
      >
    ).proxy!;
    const args = [
      'run',
      '--rm',
      '--network',
      'none',
      ...labelArgs(d),
      '--mount',
      `type=volume,src=${volume},dst=/custody`,
    ];
    docker(
      [
        ...args,
        '-i',
        '--entrypoint',
        'sh',
        caddyImage,
        '-c',
        'umask 077; cat > /custody/Caddyfile; chown 65534:65534 /custody/Caddyfile; chmod 600 /custody/Caddyfile',
      ],
      { input: '{\n admin off\n}\n:8443 {\n respond ok\n}\n' },
    );
    const readArgs = args.map((arg) =>
      arg === `type=volume,src=${volume},dst=/custody` ? arg + ',readonly' : arg,
    );
    const result = spawnSync(
      'docker',
      [
        ...readArgs,
        '--read-only',
        ...spec.cap_drop.flatMap((cap: string) => ['--cap-drop', cap]),
        ...spec.cap_add.flatMap((cap: string) => ['--cap-add', cap]),
        caddyImage,
        'caddy',
        'adapt',
        '--config',
        '/custody/Caddyfile',
        '--adapter',
        'caddyfile',
      ],
      { encoding: 'utf8', timeout: 30000 },
    );
    assert.equal(result.status, 0, 'proxy must read an independent UID-owned 0600 config');
    const metadata = docker([
      ...readArgs,
      '--entrypoint',
      'stat',
      caddyImage,
      '-c',
      '%a:%u',
      '/custody/Caddyfile',
    ]);
    assert.equal(metadata, '600:65534');
  },
);
