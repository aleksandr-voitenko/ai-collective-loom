import { setTimeout as delay } from 'node:timers/promises';
import { readConfiguration, ConfigurationError } from './config.js';
import { PostgresDatabase } from './db/postgres.js';
import { FileStorage, type StorageConfiguration } from './modules/participation/file-storage.js';
import { FileTextWorker } from './modules/search/file-worker.js';

let database: PostgresDatabase | undefined,
  storage: FileStorage | undefined,
  stopping = false;
process.once('SIGINT', () => {
  stopping = true;
});
process.once('SIGTERM', () => {
  stopping = true;
});
try {
  if (process.env.LOOM_PARTICIPATION_PROFILE !== 'synthetic' || !process.env.LOOM_FILE_STORAGE)
    throw new ConfigurationError('The file worker requires isolated synthetic storage.');
  const args = process.argv.slice(2);
  if (args.length && !(args.length === 1 && args[0] === '--once'))
    throw new ConfigurationError('Use no arguments or --once.');
  storage = new FileStorage(JSON.parse(process.env.LOOM_FILE_STORAGE) as StorageConfiguration);
  await storage.check();
  database = new PostgresDatabase(readConfiguration().database);
  if (!(await database.isReady())) throw new ConfigurationError('Worker access is unavailable.');
  const worker = new FileTextWorker(database, storage);
  process.stdout.write('{"event":"file-text_worker_ready"}\n');
  do {
    try {
      await worker.tick();
      process.send?.({ event: 'file-text_worker_cycle' });
    } catch {
      process.stderr.write('{"event":"file_text_tick_failed"}\n');
      if (args.length) {
        process.exitCode = 1;
        break;
      }
    }
    if (args.length || stopping) break;
    await delay(250);
  } while (!stopping);
} catch {
  process.stderr.write('{"event":"file_text_worker_unavailable"}\n');
  process.exitCode = 1;
} finally {
  storage?.client.destroy();
  await database?.close();
}
