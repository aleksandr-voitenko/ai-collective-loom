// Runs only inside the owned recovery namespace. There is no backup HTTP route.
import { readFileSync } from 'node:fs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import pg from 'pg';
import {
  S3Client,
  CreateBucketCommand,
  PutBucketVersioningCommand,
  GetBucketVersioningCommand,
  ListObjectVersionsCommand,
  GetObjectCommand,
  ListBucketsCommand,
} from '@aws-sdk/client-s3';
import { PostgresDatabase } from '../../dist/server/db/postgres.js';
import { createApplication } from '../../dist/server/http/app.js';
import { syntheticIdentityPolicy } from '../../dist/server/participation-profile.js';
import { IdentityAdministration } from '../../dist/server/modules/identity/administration.js';
import { IdentityAuthentication } from '../../dist/server/modules/identity/authentication.js';
import { verifier } from '../../dist/server/modules/identity/secrets.js';
import { FileStorage } from '../../dist/server/modules/participation/file-storage.js';

const c = JSON.parse(readFileSync('/custody/config.json', 'utf8'));
const databaseConfig = {
  host: '127.0.0.1',
  port: 5432,
  database: 'loom_dev',
  user: 'loom_app',
  password: c.passwords.LOOM_PG_APP_PASSWORD,
};
const storageConfig = {
  endpoint: 'http://127.0.0.1:8333',
  accessKeyId: c.storage.accessKeyId,
  secretAccessKey: c.storage.secretAccessKey,
  stagingBucket: 'loom-recovery-staging',
  finalBucket: 'loom-recovery-final',
};
const db = new pg.Client({
  ...databaseConfig,
  user: 'postgres',
  password: c.passwords.POSTGRES_PASSWORD,
});
const s3 = new S3Client({
  endpoint: storageConfig.endpoint,
  region: 'us-east-1',
  forcePathStyle: true,
  credentials: { accessKeyId: c.storage.accessKeyId, secretAccessKey: c.storage.secretAccessKey },
  maxAttempts: 1,
});
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
let phase = 'configuration';
const derived = new Set([
  'search_state',
  'search_jobs',
  'search_documents',
  'file_text_state',
  'file_text_jobs',
  'file_text_documents',
  'notification_jobs',
  'notification_projection_heads',
  'notification_gaps',
]);

async function inventory() {
  phase = 'inventory-database';
  await db.connect();
  const tables = {};
  // Every non-system table is included, including migration history and private/key tables.
  const names = (
    await db.query(
      "SELECT schemaname,tablename FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema') ORDER BY 1,2",
    )
  ).rows;
  for (const { schemaname, tablename } of names) {
    const quote = (name) => '"' + name.replaceAll('"', '""') + '"';
    const rows = (
      await db.query(
        `SELECT row_to_json(t)::text AS row FROM ${quote(schemaname)}.${quote(tablename)} t ORDER BY 1`,
      )
    ).rows;
    tables[schemaname + '.' + tablename] = {
      rows: rows.length,
      sha256: hash(JSON.stringify(rows)),
      classification: derived.has(tablename)
        ? 'rebuildable-derived-captured'
        : 'authoritative-captured',
    };
    if (schemaname === 'loom' && tablename === 'participation_rate_windows') {
      // Capture all counters exactly. Application verification may subsequently
      // charge its own reads; publication allowance must remain byte-identical.
      tables[schemaname + '.' + tablename].publicationSha256 = hash(
        JSON.stringify(rows.filter(({ row }) => JSON.parse(row).category === 'new_publications')),
      );
      tables[schemaname + '.' + tablename].requestWindows = rows
        .map(({ row }) => JSON.parse(row))
        .filter((row) => row.category !== 'new_publications');
    }
    if (schemaname === 'loom' && tablename === 'notification_state') {
      const progress = [
        'source_after',
        'revision_after',
        'scan_complete',
        'event_after',
        'event_after_intent',
        'heartbeat_at',
        'capacity_limited',
        'discovery_generation',
      ];
      const authoritative = rows.map(({ row }) =>
        Object.fromEntries(
          Object.entries(JSON.parse(row)).filter(([key]) => !progress.includes(key)),
        ),
      );
      tables[schemaname + '.' + tablename].classification = 'mixed-captured';
      tables[schemaname + '.' + tablename].authoritativeSha256 = hash(
        JSON.stringify(authoritative),
      );
    }
  }
  const buckets = {};
  phase = 'inventory-native-versions';
  for (const Bucket of [storageConfig.stagingBucket, storageConfig.finalBucket]) {
    if ((await s3.send(new GetBucketVersioningCommand({ Bucket }))).Status !== 'Enabled')
      throw new Error('versioning');
    const versions = [];
    let KeyMarker, VersionIdMarker;
    do {
      const page = await s3.send(
        new ListObjectVersionsCommand({ Bucket, KeyMarker, VersionIdMarker }),
      );
      for (const v of page.Versions ?? []) {
        const object = await s3.send(
          new GetObjectCommand({ Bucket, Key: v.Key, VersionId: v.VersionId }),
        );
        const bytes = await object.Body.transformToByteArray();
        versions.push({
          key: v.Key,
          version: v.VersionId,
          size: bytes.length,
          sha256: hash(bytes),
        });
      }
      for (const v of page.DeleteMarkers ?? [])
        versions.push({ key: v.Key, version: v.VersionId, deleted: true });
      KeyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
      VersionIdMarker = page.NextVersionIdMarker;
      if (page.IsTruncated && !KeyMarker) throw new Error('pagination');
    } while (KeyMarker);
    buckets[Bucket] = {
      versioning: 'Enabled',
      versions: versions.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    };
  }
  const required = (
    await db.query(
      'SELECT DISTINCT u.id,u.size,u.sha256,u.final_version FROM loom.file_contexts f JOIN loom.file_uploads u ON u.id=f.upload_id ORDER BY u.id',
    )
  ).rows;
  phase = 'inventory-required-versions';
  for (const u of required) {
    const v = buckets[storageConfig.finalBucket].versions.find(
      (v) => v.key === 'artifact-files-v1/' + u.id && v.version === u.final_version,
    );
    if (!v || v.size !== u.size || v.sha256 !== u.sha256)
      throw new Error('required exact native version');
  }
  const migrations = (
    await db.query('SELECT version,filename,sha256 FROM loom_migrations.history ORDER BY version')
  ).rows;
  phase = 'inventory-history';
  const instance = (await db.query('SELECT instance_id FROM loom.community_settings WHERE id=1'))
    .rows[0]?.instance_id;
  await db.end();
  s3.destroy();
  return { tables, buckets, migrations, instance, requiredVersions: required.length };
}

try {
  const mode = process.argv[2];
  if (mode === 'ready') {
    await s3.send(new ListBucketsCommand({}));
    s3.destroy();
  } else if (mode === 'inventory') process.stdout.write(JSON.stringify(await inventory()));
  else if (mode === 'provision') {
    for (const Bucket of [storageConfig.stagingBucket, storageConfig.finalBucket]) {
      await s3.send(new CreateBucketCommand({ Bucket }));
      await s3.send(
        new PutBucketVersioningCommand({ Bucket, VersioningConfiguration: { Status: 'Enabled' } }),
      );
    }
    const database = new PostgresDatabase(databaseConfig),
      policy = syntheticIdentityPolicy(c.origin);
    const administration = new IdentityAdministration(database, policy, {
      bootstrap: verifier(c.bootstrap),
      recovery: verifier(c.recovery),
    });
    const account = await administration.bootstrap(c.bootstrap, {
      idempotency_key: randomUUID(),
      nickname: 'recovery_admin',
    });
    const ticket = await administration.deploymentEnrollment(c.bootstrap, 'bootstrap', {
      idempotency_key: randomUUID(),
      participant_id: account.participant_id,
      kind: 'enrollment',
      purpose: 'enroll',
      label: 'Disposable recovery fixture',
      replace_credential_id: null,
    });
    process.stdout.write(
      JSON.stringify({ ticket: ticket.secret, administratorId: account.participant_id }),
    );
    await database.close();
    s3.destroy();
  } else if (mode === 'serve') {
    s3.destroy();
    const database = new PostgresDatabase(databaseConfig),
      policy = syntheticIdentityPolicy(c.origin),
      storage = new FileStorage(storageConfig);
    const app = await createApplication({
      database,
      logger: false,
      browserRoot: '/release/dist/web',
      tls: c.tls,
      participation: {
        database,
        authentication: new IdentityAuthentication(database, policy),
        administration: new IdentityAdministration(database, policy, {
          bootstrap: randomBytes(32).toString('hex'),
          recovery: randomBytes(32).toString('hex'),
        }),
        fileStorage: storage,
      },
    });
    const children = [],
      exits = [];
    let closing = false;
    const stop = async () => {
      if (closing) return;
      closing = true;
      // close stops admission, drains HTTP transfers/cleanup; workers then finish their own work.
      await app.close();
      for (const child of children) child.kill('SIGTERM');
      const codes = await Promise.all(exits);
      storage.client.destroy();
      if (codes.some((code) => code !== 0)) process.exitCode = 1;
    };
    process.once('SIGTERM', () => void stop()).once('SIGINT', () => void stop());
    if (c.workers)
      for (const worker of ['search', 'notifications', 'file-text']) {
        const child = spawn(process.execPath, [`/release/dist/server/${worker}-worker.js`], {
          stdio: ['ignore', 'ignore', 'ignore'],
          env: {
            ...process.env,
            LOOM_PARTICIPATION_PROFILE: 'synthetic',
            LOOM_DATABASE_HOST: '127.0.0.1',
            LOOM_POSTGRES_PORT: '5432',
            LOOM_DATABASE_NAME: 'loom_dev',
            LOOM_DATABASE_USER: 'loom_app',
            LOOM_PG_APP_PASSWORD: c.passwords.LOOM_PG_APP_PASSWORD,
            LOOM_FILE_STORAGE: JSON.stringify(storageConfig),
          },
        });
        children.push(child);
        exits.push(
          new Promise((resolve) =>
            child.once('close', (code) => {
              resolve(code);
              if (!closing) {
                process.exitCode = 1;
                void stop();
              }
            }),
          ),
        );
      }
    await app.listen({ host: '0.0.0.0', port: 3443 });
  } else throw new Error('mode');
} catch {
  // Provider/SQL errors may contain keys, private text or credentials.
  process.stderr.write('Recovery runtime failed: ' + phase + '.\n');
  process.exit(1);
}
