import { open, stat } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

export async function lockJournal(journalPath) {
  // Earlier exclusive-create locks carry no verifiable owner. Never delete one
  // automatically: an older client may still be writing this journal.
  try {
    await stat(journalPath + '.lock');
    throw new Error(
      'Legacy journal lock exists. Stop older clients and remove it only after verifying no reader is active.',
    );
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  // SQLite uses OS-held locks, released even after SIGKILL. Keep the empty sidecar:
  // unlinking it could let contenders lock different inodes for the same journal.
  const file = await open(journalPath + '.lock.sqlite', 'a', 0o600);
  await file.close();
  const lock = new DatabaseSync(journalPath + '.lock.sqlite', { timeout: 0 });
  try {
    lock.exec('BEGIN EXCLUSIVE');
    return lock;
  } catch (error) {
    lock.close();
    if (error.errcode === 5 || error.errcode === 6) {
      throw new Error('Another reader holds this journal. Use an independent journal.');
    }
    throw error;
  }
}
