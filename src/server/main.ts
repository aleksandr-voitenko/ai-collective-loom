import { fileURLToPath, pathToFileURL } from 'node:url';
import { ConfigurationError, readConfiguration, readMode } from './config.js';
import { PostgresDatabase } from './db/postgres.js';
import { createApplication } from './http/app.js';
import { readFile } from 'node:fs/promises';
import { participationProfile } from './participation-profile.js';

export async function main(args = process.argv.slice(2)): Promise<void> {
  const configuration = readConfiguration();
  const mode = readMode(args);
  const database = new PostgresDatabase(configuration.database);
  let app: Awaited<ReturnType<typeof createApplication>> | undefined;
  let shutdown: Promise<void> | undefined;
  const close = () => {
    shutdown ??= app ? app.close() : database.close();
    return shutdown;
  };
  const signal = () => {
    const deadline = setTimeout(() => {
      process.stderr.write('{"event":"shutdown_deadline_exceeded"}\n');
      process.exit(1);
    }, 10_000).unref();
    void close().then(
      () => {
        clearTimeout(deadline);
        process.stdout.write('{"event":"application_stopped"}\n');
      },
      () => {
        clearTimeout(deadline);
        process.stderr.write('{"event":"shutdown_failed"}\n');
        process.exitCode = 1;
      },
    );
  };
  process.once('SIGINT', signal);
  process.once('SIGTERM', signal);
  try {
    const tlsKey = process.env.LOOM_TLS_KEY_FILE,
      tlsCertificate = process.env.LOOM_TLS_CERT_FILE;
    if (Boolean(tlsKey) !== Boolean(tlsCertificate))
      throw new ConfigurationError(
        'LOOM_TLS_KEY_FILE and LOOM_TLS_CERT_FILE must be supplied together.',
      );
    app = await createApplication({
      database,
      ...(mode === 'web'
        ? { browserRoot: fileURLToPath(new URL('../web/', import.meta.url)) }
        : {}),
      participation: participationProfile(database),
      ...(tlsKey && tlsCertificate
        ? {
            tls: {
              key: await readFile(tlsKey, 'utf8'),
              cert: await readFile(tlsCertificate, 'utf8'),
            },
          }
        : {}),
    });
    if (!(await database.isReady())) throw new Error('Database is not ready.');
    if (shutdown) return;
    const address = await app.listen({ host: configuration.host, port: configuration.port });
    process.stdout.write(JSON.stringify({ event: 'application_started', address, mode }) + '\n');
  } catch (error) {
    await close();
    process.removeListener('SIGINT', signal);
    process.removeListener('SIGTERM', signal);
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    process.stderr.write(
      JSON.stringify({
        event: 'startup_failed',
        message:
          error instanceof ConfigurationError
            ? error.message
            : 'Application could not start. Check configuration, database access, and built assets.',
      }) + '\n',
    );
    process.exitCode = 1;
  });
}
