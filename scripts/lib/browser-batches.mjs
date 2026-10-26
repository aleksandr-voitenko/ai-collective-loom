import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, lstatSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { root, limits, prepare, approve, checked, validPlan, validRun, validBundle,
  writeChecked, captureName } from './browser-diagnostics.mjs';

export function browserBatches(plan) {
  checked(plan, validPlan);
  assert.ok(plan.tests.length, 'Browser inventory is empty');
  const identities = new Set(), groups = new Map();
  for (const test of plan.tests) {
    const key = captureName(test);
    assert.ok(!identities.has(key), 'Duplicate planned browser test'); identities.add(key);
    assert.ok(test.file.endsWith('.spec.ts') || test.file === 'diagnostics.probe.ts', 'Unknown browser spec');
    assert.equal(test.retry, 0, 'Discovery must not contain retries');
    const group = groups.get(test.file) ?? [];
    group.push(test); groups.set(test.file, group);
  }
  // Keep the discovered order and entire files together, including serial groups/hooks.
  return [...groups.values()];
}

function readDocument(path) {
  const stat = lstatSync(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= limits.bytes, 'Invalid browser document');
  return JSON.parse(readFileSync(path, 'utf8'));
}
const ordered = tests => [...tests].sort((a, b) => captureName(a).localeCompare(captureName(b)));

export function collectBrowserBatch(directory, expected, metadata, code) {
  assert.ok(approve(directory), 'Invalid batch diagnostics');
  const approved = join(directory, 'approved'), run = readDocument(join(approved, 'run.json'));
  assert.deepEqual(run.metadata, metadata, 'Batch metadata changed');
  assert.equal(run.state, 'completed', 'Batch did not finish');
  assert.equal(run.omitted, 0, 'Batch omitted diagnostics');
  assert.equal(run.planned, expected.length, 'Batch selection changed');
  assert.equal(run.ended, expected.length, 'Batch did not end every test');
  assert.deepEqual(ordered(run.tests.map(entry => entry.test)), ordered(expected), 'Batch test identities changed');
  const results = new Map(run.tests.map(entry => [captureName(entry.test), entry]));
  const bundles = new Map();
  for (const name of readdirSync(approved)) {
    if (name === 'run.json' || name === 'approval.json') continue;
    const bundle = readDocument(join(approved, name)), result = results.get(name);
    assert.ok(result, 'Diagnostic has no matching test');
    assert.deepEqual(bundle.metadata, metadata, 'Diagnostic metadata changed');
    assert.deepEqual(bundle.capture.test, result.test, 'Diagnostic test changed');
    assert.equal(bundle.result.status, result.status, 'Diagnostic status changed');
    assert.equal(bundle.result.duration_ms, result.duration_ms, 'Diagnostic duration changed');
    bundles.set(name, bundle);
  }
  for (const [name, result] of results) {
    if (result.status !== 'passed') assert.ok(bundles.has(name), 'Missing failed-test diagnostic');
  }
  return { run, bundles, code };
}

export function publishBrowserBatches(directory, plan, batches) {
  const expected = browserBatches(plan);
  assert.equal(batches.length, expected.length, 'Missing browser batch');
  const tests = batches.flatMap(batch => batch.run.tests);
  assert.deepEqual(ordered(tests.map(entry => entry.test)), ordered(plan.tests), 'Combined browser inventory changed');
  const passed = batches.every(batch => batch.code === 0 && batch.run.status === 'passed');
  const run = { schema: 'loom-browser-run-1', metadata: plan.metadata, state: 'completed',
    status: passed ? 'passed' : 'failed', planned: plan.tests.length, ended: tests.length, omitted: 0, tests };
  // Every individual candidate was validated before retention; validate the complete
  // union again with the original document/count/byte bounds before approving it.
  prepare(directory);
  const names = new Set();
  for (const batch of batches) for (const [name, bundle] of batch.bundles) {
    assert.ok(!names.has(name), 'Duplicate browser diagnostic'); names.add(name);
    writeChecked(join(directory, 'candidate', name), bundle, validBundle);
  }
  // Completion is published only after all retained bundles have been written.
  writeChecked(join(directory, 'candidate/run.json'), run, validRun);
  assert.ok(approve(directory), 'Combined diagnostics rejected');
  return passed ? 0 : 1;
}

// Full runs use this boundary. Focused CLI commands retain the original runner.
// Config is also used by the isolated runner regression fixtures.
export async function runBrowserBatches({ config, files, expectedPlan } = {}) {
  const scratch = mkdtempSync(join(tmpdir(), 'loom-browser-batches-'));
  const planPath = join(scratch, 'plan.json'), configArgs = config ? ['--config', config] : [];
  const batches = [];
  let active, interrupted = false, validated = false;
  const signal = name => { interrupted = true; active?.kill(name); };
  const interrupt = () => signal('SIGINT'), terminate = () => signal('SIGTERM');
  process.on('SIGINT', interrupt).on('SIGTERM', terminate);
  function execute(args, discovery = false) {
    if (interrupted) return Promise.resolve(1);
    return new Promise(resolveCode => {
      const child = active = spawn(process.execPath, args, {
        env: { ...process.env, LOOM_BROWSER_PLAN: planPath, PLAYWRIGHT_NO_COPY_PROMPT: '1' },
        stdio: ['ignore', discovery ? 'ignore' : 'pipe', 'ignore'],
      });
      // Only fixed progress from the containing runner is forwarded. Discovery and
      // raw CLI failures never reach the console or approved upload candidate.
      let pending = '', failed = false;
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', chunk => {
        pending = (pending + chunk).slice(-8192);
        const lines = pending.split('\n'); pending = lines.pop();
        for (const line of lines) if (/^BROWSER (passed|failed|timedOut|skipped|interrupted) [a-z-]+\.(spec|probe)\.ts:\d{1,7} repeat=\d{1,7}$/.test(line)) process.stdout.write(line + '\n');
      });
      child.on('error', () => { failed = true; });
      child.on('close', (code, childSignal) => {
        active = undefined;
        resolveCode(failed || childSignal || code === null ? 1 : code);
      });
    });
  }
  prepare();
  try {
    const discovered = await execute(['node_modules/@playwright/test/cli.js', 'test', ...configArgs,
      '--list', '--reporter', resolve('tests/helpers/browser-inventory-reporter.ts'), '--output', join(scratch, 'discovery')], true);
    assert.equal(discovered, 0, 'Browser discovery failed');
    const discoveredPlan = readDocument(planPath);
    if (expectedPlan) assert.deepEqual(discoveredPlan, expectedPlan, 'Browser discovery changed');
    if (files) {
      assert.equal(new Set(files).size, files.length, 'Duplicate selected spec');
      const known = new Set(browserBatches(discoveredPlan).map(group => group[0].file));
      assert.ok(files.length && files.every(file => known.has(file)), 'Unknown selected spec');
    }
    const plan = files ? { ...discoveredPlan, tests: discoveredPlan.tests.filter(test => files.includes(test.file)) } : discoveredPlan;
    const groups = browserBatches(plan);
    let invalid = false;
    for (const [index, expected] of groups.entries()) {
      if (interrupted) break;
      // The file filter is derived only from the closed, validated inventory.
      const file = expected[0].file.replaceAll('.', '\\.');
      const code = await execute(['scripts/browser-tests.mjs', ...configArgs, '(^|/)' + file + '$']);
      let accepted = false;
      try { batches.push(collectBrowserBatch(root, expected, plan.metadata, code)); accepted = true; }
      catch { invalid = true; }
      console.log(`Browser batch ${index + 1}/${groups.length}: tests=${expected.length}; diagnostics=${accepted ? 'validated' : 'withheld'}.`);
    }
    assert.ok(!interrupted && !invalid, 'Browser batches did not validate');
    const code = publishBrowserBatches(root, plan, batches);
    validated = true;
    return code;
  } catch {
    // A missing/invalid batch must never promote the last successful batch as the
    // complete run. Publish only the existing validated refusal document.
    rmSync(join(root, 'candidate'), { recursive: true, force: true });
    approve();
    return 1;
  } finally {
    process.off('SIGINT', interrupt).off('SIGTERM', terminate);
    rmSync(scratch, { recursive: true, force: true });
    rmSync(join(root, 'private-playwright'), { recursive: true, force: true });
    console.log(`Browser diagnostics: ${validated ? 'validated' : 'withheld'}; browser-diagnostics/approved`);
  }
}
