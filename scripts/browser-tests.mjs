import './check-runtime.mjs';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { root, prepare, approve } from './lib/browser-diagnostics.mjs';

prepare();
const privateOutput = join(root, 'private-playwright');
mkdirSync(privateOutput, { recursive: true, mode: 0o700 });
const child = spawn(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', ...process.argv.slice(2), '--output', privateOutput], {
  // Playwright 1.64 still writes error-context even with tracing disabled. Keep
  // all raw reporter output private and ephemeral, never part of the candidate.
  env: { ...process.env, PLAYWRIGHT_NO_COPY_PROMPT: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
});
let line = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', chunk => {
  // Only our bounded progress vocabulary is forwarded; arbitrary test/CLI
  // output (including failed assertions with input values) is not persisted.
  line = (line + chunk).slice(-8192);
  const lines = line.split('\n'); line = lines.pop();
  for (const value of lines) if (/^BROWSER (passed|failed|timedOut|skipped|interrupted) (participation\.spec\.ts|saved-items\.spec\.ts|organization\.spec\.ts|search\.spec\.ts|diagnostics\.probe\.ts|unknown):\d{1,7} repeat=\d{1,7}$/.test(value)) process.stdout.write(value + '\n');
});
child.stderr.resume();
let spawnFailed = false;
child.on('error', () => { spawnFailed = true; });
const forward = signal => child.kill(signal);
const interrupt = () => forward('SIGINT'), terminate = () => forward('SIGTERM');
process.on('SIGINT', interrupt).on('SIGTERM', terminate);
child.on('close', (code, signal) => {
  process.off('SIGINT', interrupt).off('SIGTERM', terminate);
  rmSync(privateOutput, { recursive: true, force: true });
  const approved = approve();
  process.stdout.write(`Browser diagnostics: ${approved ? 'validated' : 'withheld'}; browser-diagnostics/approved\n`);
  // Never turn an original browser failure or signal into success.
  process.exitCode = code && code !== 0 ? code : signal || spawnFailed ? 1 : approved ? 0 : 1;
});
