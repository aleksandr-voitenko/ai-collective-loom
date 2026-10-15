import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { PostgresDatabase } from '../../src/server/db/postgres.js';
import { actorFromVerifiedIdentity } from '../../src/server/modules/publication/actor.js';
import { localDockerEndpoint } from '../../scripts/lib/local-config.mjs';
import { migrationSql, readMigrations } from '../../scripts/lib/migrations.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
export async function isolatedPublicationPostgres(options: { throughMigration?: number } = {}) {
  const name = 'loom-publication-test-' + randomUUID();
  const passwords = {
    POSTGRES_PASSWORD: randomBytes(32).toString('hex'),
    LOOM_PG_MIGRATOR_PASSWORD: randomBytes(32).toString('hex'),
    LOOM_PG_APP_PASSWORD: randomBytes(32).toString('hex'),
  };
  const docker = (args: string[], input?: string) => {
    const result = spawnSync('docker', args, { encoding: 'utf8', input, timeout: 900_000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, ...passwords, PGPASSWORD: passwords.LOOM_PG_MIGRATOR_PASSWORD } });
    if (result.error || result.status !== 0) throw new Error(Object.values(passwords).reduce((text, password) => text.replaceAll(password, '[REDACTED]'), result.stderr || result.error?.message || 'Docker command failed.'));
    return result.stdout.trim();
  };
  const endpoint = () => docker(['context', 'inspect', ...(process.env.DOCKER_CONTEXT ? [process.env.DOCKER_CONTEXT] : []), '--format', '{{.Endpoints.docker.Host}}']);
  assert.ok(localDockerEndpoint(process.env.DOCKER_CONTEXT ? endpoint() : process.env.DOCKER_HOST || endpoint()), 'Publication tests require local Docker.');
  docker(['info', '--format', '{{.ServerVersion}}']);
  const image = /^    image: (postgres:\S+@sha256:[a-f0-9]{64})$/m.exec(await readFile(root + 'compose.yaml', 'utf8'))?.[1];
  assert.ok(image);
  let database: PostgresDatabase | undefined;
  let control: pg.Client | undefined;
  const close = async () => {
    await database?.close();
    await control?.end();
    const id = docker(['container', 'ls', '--all', '--filter', 'name=^/' + name + '$', '--format', '{{.ID}}']);
    if (id) docker(['rm', '--force', id]);
  };
  try {
    docker(['run', '--detach', '--name', name, '--tmpfs', '/var/lib/postgresql', '-p', '127.0.0.1::5432',
      '--mount', 'type=bind,src=' + root + 'infra/postgres,dst=/opt/loom/postgres,readonly', '--entrypoint', 'bash',
      '-e', 'POSTGRES_DB=loom_dev', '-e', 'POSTGRES_USER=postgres', '-e', 'POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256',
      ...Object.keys(passwords).flatMap(key => ['-e', key]), image, '/opt/loom/postgres/start.sh', 'postgres']);
    const port = Number(docker(['port', name, '5432/tcp']).split(':').at(-1));
    assert.ok(port > 0);
    const configuration = { host: '127.0.0.1', port, database: 'loom_dev', user: 'loom_app', password: passwords.LOOM_PG_APP_PASSWORD };
    database = new PostgresDatabase(configuration);
    const deadline = Date.now() + 90_000;
    while (!await database.isReady()) {
      if (Date.now() > deadline) throw new Error('Isolated publication database startup timed out.');
      await delay(100);
    }
    const migrate = async (through?:number) => {
      const migrations = await readMigrations(root + 'db/migrations');
      docker(['exec', '-i', '-e', 'PGPASSWORD', name, 'psql', '-X', '-q', '-h', '127.0.0.1', '-U', 'loom_migrator', '-d', 'loom_dev', '-v', 'ON_ERROR_STOP=1'], migrationSql(through === undefined ? migrations : migrations.slice(0,through)));
    };
    await migrate(options.throughMigration);
    // Superuser is exclusively a fault-injection/catalog observer. Publication,
    // fixtures and policy checks use actual loom_app connections.
    control = new pg.Client({ ...configuration, user: 'postgres', password: passwords.POSTGRES_PASSWORD });
    await control.connect();
    const db = database, observer = control;
    async function participant(role = 'participant') {
      const participantId = randomUUID(), credentialId = randomUUID();
      await db.transaction(async tx => {
        await tx.query('INSERT INTO loom.participants(id, state, role) VALUES ($1, $2, $3)', [participantId, 'active', role]);
        await tx.query('INSERT INTO loom.participant_credentials(id, participant_id, state) VALUES ($1, $2, $3)', [credentialId, participantId, 'active']);
      });
      return { participantId, credentialId, actor: actorFromVerifiedIdentity({ participantId, credentialId }) };
    }
    async function resource(authorId: string, kind: 'artifact' | 'contribution' | 'summary' = 'artifact') {
      const rootId = randomUUID(), areaId = randomUUID(), discussionId = randomUUID(), resourceId = randomUUID();
      await db.transaction(async tx => {
        await tx.query('INSERT INTO loom.resources(id, kind) VALUES ($1, $2)', [rootId, 'area']);
        await tx.query('INSERT INTO loom.resources(id, kind, owner_resource_id) VALUES ($1, $2, $3)', [areaId, 'area', rootId]);
        await tx.query('INSERT INTO loom.resources(id, kind, owner_resource_id, original_author_id) VALUES ($1, $2, $3, $4)', [discussionId, 'discussion', areaId, authorId]);
        await tx.query('INSERT INTO loom.resources(id, kind, owner_resource_id, original_author_id) VALUES ($1, $2, $3, $4)', [resourceId, kind, kind === 'artifact' ? areaId : discussionId, authorId]);
        if (kind !== 'contribution') await tx.query('INSERT INTO loom.resource_editors VALUES ($1, $2)', [resourceId, authorId]);
      });
      return { resourceId, rootId, areaId, discussionId };
    }
    return { database: db, observer, configuration, participant, resource, close, migrate };
  } catch (error) { await close(); throw error; }
}
