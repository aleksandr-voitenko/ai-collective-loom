import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { diagnosticTest as test, expect } from '../../helpers/browser-fixtures.js';
import { root } from '../../../scripts/lib/browser-diagnostics.mjs';

test('first batch retains its failure and contains raw output', async ({ diagnostics }, info) => {
  diagnostics.phase('server_ready');
  appendFileSync(process.env.LOOM_BATCH_PROBE_OUTPUT!, JSON.stringify({ batch: 1, pid: process.pid }) + '\n');
  const canary = 'LOOM_BATCH_SECRET_CANARY_7jQv39';
  console.log(canary); console.error(canary);
  await info.attach(canary, { body: Buffer.from(canary), contentType: 'text/plain' });
  if (process.env.LOOM_BATCH_PROBE_MODE === 'invalid') writeFileSync(join(root, 'candidate/attachment.txt'), canary);
  if (process.env.LOOM_BATCH_PROBE_MODE === 'interrupt') {
    await new Promise(() => {});
  }
  expect(process.env.LOOM_BATCH_PROBE_MODE, canary).not.toBe('failure');
});
