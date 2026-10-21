// Native discovery COMMIT barriers for disposable recovery tests only.
import { PostgresDatabase, type Transactions } from '../../src/server/db/postgres.js';
import { readConfiguration } from '../../src/server/config.js';
import { SearchWorker } from '../../src/server/modules/search/worker.js';
import type { QueryResultRow } from 'pg';

const database = new PostgresDatabase(readConfiguration().database), phase = process.argv[2];
const wait = () => new Promise<void>(resolve => process.once('message', () => resolve()));
const wrapped: Transactions = { transaction: work => database.transaction(tx => work({
  query: async <Row extends QueryResultRow>(sql: string, values: readonly unknown[]) => {
    const result = await tx.query<Row>(sql, values);
    if (phase === 'before_commit' && sql.startsWith('UPDATE loom.search_state SET source_after=')) {
      process.send?.({ stage: 'before_commit' }); await wait();
    }
    return result;
  },
})) };
try {
  if (!['before_commit', 'after_commit'].includes(phase ?? '')) throw new Error();
  await new SearchWorker(wrapped).discover();
  process.send?.({ stage: 'after_commit' }); await wait();
} catch { process.send?.({ stage: 'failed' }); process.exitCode = 1; }
finally { await database.close(); process.disconnect?.(); }
