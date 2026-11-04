import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { gates } from './updates-gates.js';
import { bounded } from './search-races.js';

type ReaderPage = { items: unknown[]; limit: number; traversal: { id: string } };

export async function verifyNativeReaderLockRecovery<Page extends ReaderPage>({
  args,
  journal,
  gate,
}: {
  args: (action: string, journal?: string) => string[];
  journal: string;
  gate: ReturnType<typeof gates>;
}) {
  const run = async (action: string, file = journal) => JSON.parse(
    (await promisify(execFile)(process.execPath, args(action, file), { timeout: 20000 })).stdout,
  ) as Page;
  const displayed = await run('read');
  const saved = await readFile(journal, 'utf8');
  // The native client already owns its journal at its first authentication read.
  // Pause before SQL guards so a different journal can still authenticate/read.
  const authentication = (sql: string) => sql.includes('FROM loom.participant_credentials WHERE id = $1');
  const held = gate.pause(authentication, 'before');
  const child = spawn(process.execPath, args('next'), { stdio: 'ignore' });
  const exited = once(child, 'exit');
  try {
    await bounded(held.entered.promise);
    await assert.rejects(run('read'), /Another reader holds this journal/);
    assert.equal(await readFile(journal, 'utf8'), saved);
    assert.deepEqual((await run('read', journal + '.independent')).items, displayed.items);
    child.kill('SIGKILL');
    assert.deepEqual(await exited, [null, 'SIGKILL']);
  } finally {
    held.release.release();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  }
  assert.equal(await readFile(journal, 'utf8'), saved, 'an interrupted next must retain the exact saved page');
  const recovered = await run('read');
  assert.deepEqual(recovered.items, displayed.items);
  assert.equal(recovered.limit, displayed.limit);
  assert.deepEqual(recovered.traversal, displayed.traversal);
  assert.equal((await stat(journal)).mode & 0o777, 0o600);
  const sidecar = await stat(journal + '.lock.sqlite');
  assert.equal(sidecar.mode & 0o777, 0o600);

  const beforeFailure = await readFile(journal, 'utf8');
  const failed = gate.pause(authentication, 'before', true);
  failed.release.release();
  await assert.rejects(run('read'), /HTTP 503/);
  assert.equal(await readFile(journal, 'utf8'), beforeFailure);
  assert.deepEqual((await run('read')).items, displayed.items, 'a failed read must release ownership too');
  assert.equal((await stat(journal + '.lock.sqlite')).ino, sidecar.ino, 'lock ownership must keep one inode');

  const legacy = journal + '.legacy';
  const legacyBytes = 'Synthetic older reader with unverified ownership';
  await writeFile(legacy, saved, { mode: 0o600 });
  await writeFile(legacy + '.lock', legacyBytes, { mode: 0o600 });
  await assert.rejects(run('read', legacy), /Legacy journal lock exists/);
  assert.equal(await readFile(legacy, 'utf8'), saved);
  assert.equal(await readFile(legacy + '.lock', 'utf8'), legacyBytes);
  await assert.rejects(stat(legacy + '.lock.sqlite'), { code: 'ENOENT' });

  return { displayed, recovered, next: await run('next') };
}
