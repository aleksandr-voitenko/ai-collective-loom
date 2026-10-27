import { nativeInventory } from './native-inventory.mjs';
// Runs only inside the owned recovery namespace. There is no backup HTTP route.
import { readFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import pg from 'pg';
import {
  S3Client,
  CreateBucketCommand,
  PutBucketVersioningCommand,
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
let phase = 'configuration';
async function inventory() { return nativeInventory(db, s3, storageConfig, value => { phase = value; }); }

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
