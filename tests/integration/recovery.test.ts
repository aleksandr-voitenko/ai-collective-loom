import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
  cpSync,
  mkdirSync,
  realpathSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { recoveryFixture } from '../helpers/recovery-fixture.js';
import {
  backup,
  restore,
  verify,
  destroy,
  inventory,
  sql,
  readInstance,
  inspectBackup,
  start,
  stop,
  serve,
  docker,
} from '../../scripts/lib/recovery.mjs';

test(
  'cold encrypted recovery preserves exact application history and private outcomes without source storage',
  { timeout: 300000 },
  async (t) => {
    const directory = mkdtempSync(join(realpathSync(tmpdir()), 'loom-recovery-native-')),
      key = directory + '/key';
    writeFileSync(key, randomBytes(32).toString('base64url'), { mode: 0o600 });
    let source: any, restored: any;
    t.after(async () => {
      if (restored) await destroy(restored);
      if (source) await destroy(source);
      rmSync(directory, { recursive: true, force: true });
    });
    const f = await recoveryFixture(directory, (d) => {
      source = d;
    });
    source = f.source;
    const completed = directory + '/backup';
    await backup(source, completed, key);
    assert.equal(
      inspectBackup(completed, key).status,
      'integrity-checked; application recovery unverified',
    );
    const pre = JSON.parse(readFileSync(f.expectations, 'utf8'));
    assert.ok(pre.reads.some((r: any) => r.expected.body?.operation_state === 'version_conflict'));
    assert.ok(pre.reads.some((r: any) => r.expected.body?.operation_state === 'not_recorded'));
    // Snapshot predates a later note deletion, credential revocation and publication.
    await start(source);
    await f.accepted(f.alice.client, '/api/v1/me/notes/delete', {
      idempotency_key: crypto.randomUUID(),
      note_id: f.note.note_id,
      expected_version: 2,
    });
    const late = await f.accepted(f.alice.client, '/api/v1/artifacts', {
      idempotency_key: crypto.randomUUID(),
      area_id: f.area,
      title: 'After backup',
      content: {
        format: 'loom-markdown-v1',
        text: 'Later publication absent from snapshot',
        mentions: [],
      },
    });
    await f.accepted(f.admin, '/api/v1/identity/revoke', {
      idempotency_key: crypto.randomUUID(),
      participant_id: f.bob.id,
      credential_id: f.bob.credential,
    });
    // No source process, endpoint, bucket namespace or source volume survives this point.
    await destroy(source);
    source = undefined;
    restored = await restore(completed, directory + '/destination', key);
    assert.equal(restored.status, 'quarantined-integrity-verified');
    await assert.rejects(start(restored), /quarantine/);
    const before = inventory(restored);
    assert.ok(Object.keys(before.tables).length > 60);
    const result = await verify(restored, f.expectations);
    assert.equal(result.status, 'verified-isolated-snapshot');
    assert.equal(
      JSON.parse(readFileSync(directory + '/uncertain-command.json', 'utf8')).state,
      'uncertain',
    );
    assert.ok(existsSync(restored.path + '/VERIFIED.json'));
    const c = JSON.parse(readFileSync(restored.path + '/config.json', 'utf8'));
    assert.notEqual(c.origin, f.c.origin);
    const { httpsCall } = await import('../../scripts/lib/recovery.mjs');
    assert.equal(
      (
        await httpsCall(
          c.origin,
          c.tls.cert,
          '/api/v1/resources/' + late.resource_id,
          undefined,
          f.alice.token,
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await httpsCall(
          c.origin,
          c.tls.cert,
          '/api/v1/me/notes/' + f.note.note_id,
          undefined,
          f.alice.token,
        )
      ).status,
      200,
    );
    assert.equal(
      (await httpsCall(c.origin, c.tls.cert, '/api/v1/identity/self', undefined, f.bob.token))
        .status,
      200,
    );
    assert.equal(
      JSON.stringify(inventory(restored)),
      JSON.stringify(before),
      'Verification must preserve every captured table and native version',
    );
    // Same native worker programs resume; existing signals and source/private rows cannot multiply.
    docker(['stop', '--time', '60', restored.id + '-runtime']);
    await serve(restored, { workers: true });
    const deadline = Date.now() + 10000;
    while (
      sql(restored, "SELECT count(*) FROM loom.file_text_jobs WHERE state='complete'") === '0'
    ) {
      assert.ok(Date.now() < deadline, 'Derived work did not resume');
      await new Promise((r) => setTimeout(r, 200));
    }
    await stop(restored);
    await start(restored);
    docker(['stop', '--time', '60', restored.id + '-runtime']);
    const after = inventory(restored);
    for (const [table, expected] of Object.entries(before.tables) as [string, any][])
      if (expected.classification === 'authoritative-captured') {
        assert.equal(
          JSON.stringify(after.tables[table]),
          JSON.stringify(expected),
          'Authoritative state changed: ' + table,
        );
      }
    assert.equal(
      after.tables['loom.notification_state'].authoritativeSha256,
      before.tables['loom.notification_state'].authoritativeSha256,
    );
  },
);

test(
  'incomplete, interrupted, corrupted and incompatible recovery fails before destination mutation',
  { timeout: 300000 },
  async (t) => {
    const directory = mkdtempSync(join(realpathSync(tmpdir()), 'loom-recovery-faults-')),
      key = directory + '/key',
      wrong = directory + '/wrong';
    writeFileSync(key, randomBytes(32).toString('base64url'), { mode: 0o600 });
    writeFileSync(wrong, randomBytes(32).toString('base64url'), { mode: 0o600 });
    let source: any;
    const destinations: any[] = [];
    t.after(async () => {
      for (const d of destinations) await destroy(d);
      if (source) await destroy(source);
      rmSync(directory, { recursive: true, force: true });
    });
    const f = await recoveryFixture(directory, (d) => {
      source = d;
    });
    source = f.source;
    await assert.rejects(
      backup(source, directory + '/incomplete', key, { fault: 'before-completion' }),
    );
    assert.equal(existsSync(directory + '/incomplete/COMPLETED.json'), false);
    await assert.rejects(
      restore(directory + '/incomplete', directory + '/refused-incomplete', key),
    );
    assert.equal(existsSync(directory + '/refused-incomplete'), false);
    await start(source);
    await backup(source, directory + '/backup', key);
    const overlapping = directory + '/backup/destination';
    await assert.rejects(async () => {
      const unexpected = await restore(directory + '/backup', overlapping, key);
      destinations.push(unexpected);
    }, /overlap/);
    assert.equal(existsSync(overlapping), false);
    for (const [name, mutate] of [
      ['missing-database', (p: string) => rmSync(p + '/postgres.gpg')],
      ['missing-storage', (p: string) => rmSync(p + '/seaweed.gpg')],
      ['corrupt-database', (p: string) => writeFileSync(p + '/postgres.gpg', 'damaged')],
      ['corrupt-storage', (p: string) => writeFileSync(p + '/seaweed.gpg', 'damaged')],
      ['corrupt-manifest', (p: string) => writeFileSync(p + '/manifest.gpg', 'damaged')],
    ] as const) {
      const path = directory + '/' + name;
      cpSync(directory + '/backup', path, { recursive: true });
      mutate(path);
      await assert.rejects(restore(path, directory + '/refused-' + name, key));
      assert.equal(existsSync(directory + '/refused-' + name), false);
    }
    for (const keyFile of [wrong, directory + '/absent-key']) {
      await assert.rejects(
        restore(directory + '/backup', directory + '/wrong-key-destination', keyFile),
      );
      assert.equal(existsSync(directory + '/wrong-key-destination'), false);
    }
    for (const kind of ['manifest-version', 'schema']) {
      const path = directory + '/' + kind;
      cpSync(directory + '/backup', path, { recursive: true });
      const plain = directory + '/' + kind + '.json';
      const gpgHome = mkdtempSync(join(tmpdir(), 'loom-gpg-'));
      const gpg = (args: string[]) => {
        const r = spawnSync(
          'gpg',
          [
            '--no-options',
            '--homedir',
            gpgHome,
            '--batch',
            '--yes',
            '--no-symkey-cache',
            '--pinentry-mode',
            'loopback',
            '--passphrase-fd',
            '0',
            ...args,
          ],
          { input: readFileSync(key, 'utf8') + '\n', encoding: 'utf8' },
        );
        assert.equal(r.status, 0, 'Fixture encryption failed');
      };
      gpg(['--output', plain, '--decrypt', path + '/manifest.gpg']);
      const manifest = JSON.parse(readFileSync(plain, 'utf8'));
      if (kind === 'manifest-version') manifest.format = 'unsupported-backup';
      else manifest.inventory.migrations[0].sha256 = '0'.repeat(64);
      writeFileSync(plain, JSON.stringify(manifest), { mode: 0o600 });
      gpg(['--output', path + '/manifest.gpg', '--symmetric', '--cipher-algo', 'AES256', plain]);
      writeFileSync(
        path + '/COMPLETED.json',
        JSON.stringify({
          format: 'loom-cold-backup-1',
          manifestSha256: createHash('sha256')
            .update(readFileSync(path + '/manifest.gpg'))
            .digest('hex'),
        }),
        { mode: 0o600 },
      );
      await assert.rejects(restore(path, directory + '/refused-' + kind, key));
      assert.equal(existsSync(directory + '/refused-' + kind), false);
      rmSync(gpgHome, { recursive: true, force: true });
    }
    const interrupted = directory + '/interrupted';
    await assert.rejects(
      restore(directory + '/backup', interrupted, key, { fault: 'after-database' }),
    );
    assert.equal(readInstance(interrupted).status, 'quarantined-failed');
    assert.equal(existsSync(interrupted + '/VERIFIED.json'), false);
    const existing = directory + '/existing';
    mkdirSync(existing, { mode: 0o700 });
    writeFileSync(existing + '/sentinel', 'unrelated', { mode: 0o600 });
    await assert.rejects(restore(directory + '/backup', existing, key));
    assert.equal(readFileSync(existing + '/sentinel', 'utf8'), 'unrelated');
    const command = spawnSync(
      process.execPath,
      [
        'scripts/recovery.mjs',
        'restore',
        '--backup',
        directory + '/backup',
        '--destination',
        existing,
        '--key-file',
        key,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(command.status, 1);
    assert.ok(!command.stderr.includes(f.alice.token));
    assert.equal(command.stdout, '');
    await destroy(source);
    source = undefined;
    const missing = await restore(directory + '/backup', directory + '/missing-exact', key);
    destinations.push(missing);
    const c = JSON.parse(readFileSync(missing.path + '/config.json', 'utf8'));
    const version = JSON.parse(
      sql(
        missing,
        'SELECT row_to_json(t) FROM (SELECT id,final_version FROM loom.file_uploads WHERE final_version IS NOT NULL ORDER BY id LIMIT 1) t',
      ),
    );
    const nodeImage = JSON.parse(readFileSync('config/recovery.json', 'utf8')).nodeImage;
    // Same native key has a surviving alternative. Only the required exact version is removed.
    const damage = `const {readFileSync}=await import('node:fs');const {S3Client,PutObjectCommand,DeleteObjectCommand,ListObjectVersionsCommand}=await import('@aws-sdk/client-s3');const c=JSON.parse(readFileSync('/custody/config.json'));const s=new S3Client({endpoint:'http://127.0.0.1:8333',region:'us-east-1',forcePathStyle:true,credentials:{accessKeyId:c.storage.accessKeyId,secretAccessKey:c.storage.secretAccessKey},maxAttempts:1});const Bucket='loom-recovery-final',Key='artifact-files-v1/${version.id}';await s.send(new PutObjectCommand({Bucket,Key,Body:'different surviving native version'}));await s.send(new DeleteObjectCommand({Bucket,Key,VersionId:'${version.final_version}'}));const versions=await s.send(new ListObjectVersionsCommand({Bucket,Prefix:Key}));if(!versions.Versions?.length)process.exit(1);s.destroy();`;
    docker([
      'run',
      '--rm',
      '--read-only',
      '--log-driver',
      'none',
      '--network',
      'container:' + missing.id + '-s3',
      '--mount',
      'type=bind,src=' + process.cwd() + ',dst=/release,readonly',
      '--mount',
      'type=bind,src=' + missing.path + ',dst=/custody,readonly',
      '--workdir',
      '/release',
      nodeImage,
      'node',
      '--input-type=module',
      '-e',
      damage,
    ]);
    await assert.rejects(verify(missing, f.expectations));
    await assert.rejects(start(missing), /quarantine/);
    assert.equal(readInstance(missing.path).status, 'quarantined-failed');
    assert.equal(existsSync(missing.path + '/VERIFIED.json'), false);
    assert.ok(c.origin.startsWith('https://localhost:'));
  },
);
