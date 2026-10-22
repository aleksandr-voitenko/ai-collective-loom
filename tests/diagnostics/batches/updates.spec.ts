import { appendFileSync, readFileSync } from 'node:fs';
import { diagnosticTest as test, expect } from '../../helpers/browser-fixtures.js';

test('second batch starts only after the previous worker has exited', async ({ diagnostics }) => {
  diagnostics.phase('server_ready');
  const previous = JSON.parse(readFileSync(process.env.LOOM_BATCH_PROBE_OUTPUT!, 'utf8').trim());
  expect(previous.batch).toBe(1);
  expect(previous.pid).not.toBe(process.pid);
  let previousExited = false;
  try { process.kill(previous.pid, 0); } catch (error) { previousExited = (error as NodeJS.ErrnoException).code === 'ESRCH'; }
  expect(previousExited).toBe(true);
  appendFileSync(process.env.LOOM_BATCH_PROBE_OUTPUT!, JSON.stringify({ batch: 2, pid: process.pid }) + '\n');
});
