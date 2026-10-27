// Runs from an immutable release image. Only offline provision/recover modes see
// deployment capability custody; ordinary API/workers receive runtime.json only.
import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
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
import { nativeInventory } from './native-inventory.mjs';

let phase = 'configuration';
try {
  const mode = process.argv[2];
  const c = JSON.parse(readFileSync('/custody/runtime.json', 'utf8'));
  const databaseConfig = {
    host: '127.0.0.1',
    port: 5432,
    database: c.database,
    user: 'loom_app',
    password: c.appPassword,
  };
  const storageConfig = { endpoint: 'http://127.0.0.1:8333', ...c.storage };
  const s3 = () =>
    new S3Client({
      endpoint: storageConfig.endpoint,
      region: 'us-east-1',
      forcePathStyle: true,
      credentials: {
        accessKeyId: c.storage.accessKeyId,
        secretAccessKey: c.storage.secretAccessKey,
      },
      maxAttempts: 1,
    });
  const policy = syntheticIdentityPolicy(c.origin);
  if (mode === 'verification-policy') {
    const { participationRateRoutes } = await import('../../dist/server/http/rate-policy.js');
    const { operationFamily } =
      await import('../../dist/server/modules/operations/collector.js');
    const { outcomeCodes } = await import('../../dist/contracts/operations.js');
    const routes = [...participationRateRoutes];
    process.stdout.write(
      JSON.stringify({
        routes,
        outcomeCodes,
        families: routes.map(([route]) => {
          const template = route.split(' ')[1];
          return [template, operationFamily(template)];
        }),
      }),
    );
  } else if (mode === 'inventory') {
    phase = 'inventory';
    const secret = JSON.parse(readFileSync('/operator/config.json', 'utf8'));
    const db = new pg.Client({
      ...databaseConfig,
      user: 'postgres',
      password: secret.passwords.POSTGRES_PASSWORD,
    });
    process.stdout.write(JSON.stringify(await nativeInventory(db, s3(), storageConfig)));
  } else if (mode === 'storage-ready') {
    const client = s3();
    await client.send(new ListBucketsCommand({}));
    client.destroy();
  } else if (mode === 'ready') {
    const storage = new FileStorage(storageConfig);
    await storage.check();
    storage.client.destroy();
  } else if (mode === 'provision' || mode === 'recover') {
    phase = mode;
    const secret = JSON.parse(readFileSync('/operator/config.json', 'utf8'));
    const database = new PostgresDatabase(databaseConfig);
    const administration = new IdentityAdministration(database, policy, {
      bootstrap: verifier(secret.bootstrap),
      recovery: verifier(secret.recovery),
    });
    let account;
    if (mode === 'provision') {
      const client = s3();
      // Only exclusive initialization invokes this branch. Never on start/restart.
      for (const Bucket of [c.storage.stagingBucket, c.storage.finalBucket]) {
        await client.send(new CreateBucketCommand({ Bucket }));
        await client.send(
          new PutBucketVersioningCommand({
            Bucket,
            VersioningConfiguration: { Status: 'Enabled' },
          }),
        );
      }
      client.destroy();
      account = await administration.bootstrap(secret.bootstrap, {
        idempotency_key: secret.bootstrapKey,
        nickname: secret.nickname,
      });
    } else {
      account = {
        participant_id: (
          await database.transaction(
            async (tx) =>
              (
                await tx.query(
                  'SELECT administrator_id FROM loom.identity_initialization WHERE id=1',
                  [],
                )
              ).rows[0],
          )
        ).administrator_id,
      };
    }
    const attempt =
      mode === 'provision'
        ? { key: secret.enrollmentKey, replace: null }
        : JSON.parse(readFileSync('/operator/recovery-request.json', 'utf8'));
    const ticket = await administration.deploymentEnrollment(
      mode === 'provision' ? secret.bootstrap : secret.recovery,
      mode === 'provision' ? 'bootstrap' : 'recovery',
      {
        idempotency_key: attempt.key,
        participant_id: account.participant_id,
        kind: 'enrollment',
        purpose: mode === 'provision' ? 'enroll' : 'recover',
        label: 'Private local pilot administrator',
        replace_credential_id: attempt.replace,
      },
    );
    // An interrupted/lost issuance must be explicitly replaced, never replayed.
    if (!ticket.secret) throw new Error('one-time issuance unavailable');
    writeFileSync(
      '/output/enrollment.json',
      JSON.stringify({
        ticket: ticket.secret,
        administratorId: account.participant_id,
        credentialId: ticket.credential_id,
      }) + '\n',
      { flag: 'wx', mode: 0o600, flush: true },
    );
    await database.close();
  } else if (['search', 'notifications', 'file-text'].includes(mode)) {
    const child = spawn(process.execPath, [`/release/dist/server/${mode}-worker.js`], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: {
        ...process.env,
        LOOM_PARTICIPATION_PROFILE: 'synthetic',
        LOOM_DATABASE_HOST: '127.0.0.1',
        LOOM_POSTGRES_PORT: '5432',
        LOOM_DATABASE_NAME: c.database,
        LOOM_DATABASE_USER: 'loom_app',
        LOOM_PG_APP_PASSWORD: c.appPassword,
        LOOM_FILE_STORAGE: JSON.stringify(storageConfig),
      },
    });
    process.once('SIGTERM', () => child.kill('SIGTERM'));
    process.once('SIGINT', () => child.kill('SIGINT'));
    child.once('error', () => {
      process.exitCode = 1;
    });
    child.once('close', (code) => {
      process.exitCode = code ?? 1;
    });
  } else if (mode === 'api') {
    phase = 'api';
    const database = new PostgresDatabase(databaseConfig),
      storage = new FileStorage(storageConfig);
    await storage.check();
    const app = await createApplication({
      database,
      logger: false,
      browserRoot: '/release/dist/web',
      tls: c.tls,
      participation: {
        cookieNamespace: c.instance,
        installationMode: 'local-pilot',
        database,
        authentication: new IdentityAuthentication(database, policy),
        administration: new IdentityAdministration(database, policy, {
          bootstrap: randomBytes(32).toString('hex'),
          recovery: randomBytes(32).toString('hex'),
        }),
        fileStorage: storage,
      },
    });
    let closing = false;
    const close = async () => {
      if (closing) return;
      closing = true;
      const deadline = setTimeout(() => process.exit(1), 25000).unref();
      try {
        await app.close();
        storage.client.destroy();
        clearTimeout(deadline);
      } catch {
        process.exitCode = 1;
      }
    };
    process.once('SIGTERM', () => void close()).once('SIGINT', () => void close());
    await app.listen({ host: '0.0.0.0', port: 3443 });
    process.stdout.write('{"event":"pilot_api_ready"}\n');
  } else throw new Error('mode');
} catch {
  process.stderr.write(JSON.stringify({ event: 'pilot_runtime_failed', phase }) + '\n');
  process.exit(1);
}
