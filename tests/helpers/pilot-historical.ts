import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import {
  cpSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  readFileSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { pilotFixture, until } from './pilot.js';
const execute = promisify(execFile),
  root = fileURLToPath(new URL('../../', import.meta.url));
// Last actual release before the additive operational-health migration (0029).
// Compile its real source; only the new installation controller is transplanted.
export const previousPilotSource = 'bfc127ed20310c987325bb9eef030fe4b0d112a0';
export async function historicalPilot(onCreated: (fixture: any) => void) {
  const checkout = mkdtempSync(join(realpathSync(tmpdir()), 'loom-pilot-prior-source-'));
  try {
    await execute('git', ['clone', '--quiet', '--shared', '--no-checkout', root, checkout]);
    await execute('git', ['checkout', '--quiet', '--detach', previousPilotSource], {
      cwd: checkout,
    });
    assert.ok(
      readFileSync(join(root, 'package-lock.json')).equals(
        readFileSync(join(checkout, 'package-lock.json')),
      ),
      'historical build uses identical dependency lock',
    );
    for (const path of ['scripts', 'infra/pilot'])
      cpSync(join(root, path), join(checkout, path), { recursive: true });
    symlinkSync(join(root, 'node_modules'), join(checkout, 'node_modules'), 'dir');
    await execute(process.execPath, ['scripts/build-application.mjs'], {
      cwd: checkout,
      timeout: 120000,
      maxBuffer: 256 * 1024,
    });
    const f = await pilotFixture(onCreated, checkout);
    return { f, close: () => rmSync(checkout, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(checkout, { recursive: true, force: true });
    throw error;
  }
}
export async function interruptAfterBackup(path: string, options: Record<string, string>) {
  const child = spawn(
    process.execPath,
    [
      join(root, 'scripts/pilot.mjs'),
      'update',
      '--instance',
      path,
      ...Object.entries(options).flatMap(([k, v]) => ['--' + k, v]),
    ],
    { cwd: root, stdio: ['ignore', 'ignore', 'ignore'] },
  );
  const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    },
  );
  try {
    await until(() => {
      assert.equal(
        child.exitCode,
        null,
        'controller must still be running before interruption',
      );
      const journal = join(path, 'update.json');
      return (
        existsSync(journal) &&
        JSON.parse(readFileSync(journal, 'utf8')).phase === 'backup-complete'
      );
    }, 'observed completed backup before update selection');
    assert.equal(child.kill('SIGKILL'), true);
    assert.equal((await ended).signal, 'SIGKILL');
    assert.equal(
      JSON.parse(readFileSync(join(path, 'update.json'), 'utf8')).phase,
      'backup-complete',
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await ended;
    }
  }
}
