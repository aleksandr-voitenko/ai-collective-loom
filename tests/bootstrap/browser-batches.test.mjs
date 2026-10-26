import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { browserBatches, collectBrowserBatch, publishBrowserBatches } from '../../scripts/lib/browser-batches.mjs';
import { prepare, metadata, emptyCapture, captureName, writeChecked, validRun, validBundle, limits } from '../../scripts/lib/browser-diagnostics.mjs';

const identity = (id, file) => ({ id: id.repeat(64), file, line: 1, column: 1, repeat: 0, retry: 0 });
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'loom-batch-contract-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tests = [identity('a', 'participation.spec.ts'), identity('b', 'updates.spec.ts')];
  const plan = { schema: 'loom-browser-plan-1', metadata: metadata(), tests };
  function candidate(index, status = 'passed') {
    const directory = join(root, String(index)); prepare(directory);
    const result = { test: tests[index], status, duration_ms: 12 };
    const run = { schema: 'loom-browser-run-1', metadata: plan.metadata, state: 'completed', status,
      planned: 1, ended: 1, omitted: 0, tests: [result] };
    writeChecked(join(directory, 'candidate/run.json'), run, validRun);
    const capture = { ...emptyCapture(tests[index]), complete: true, issues: [] };
    const bundle = { schema: 'loom-browser-diagnostic-1', metadata: plan.metadata,
      result: { status, duration_ms: 12, errors: status === 'passed' ? 0 : 1, attachments_omitted: 0, steps: [], steps_dropped: 0 }, capture };
    writeChecked(join(directory, 'candidate', captureName(tests[index])), bundle, validBundle);
    return { directory, run, bundle, save: () => {
      writeChecked(join(directory, 'candidate/run.json'), run, validRun);
      writeChecked(join(directory, 'candidate', captureName(tests[index])), bundle, validBundle);
    } };
  }
  return { root, tests, plan, candidate };
}

test('batch discovery preserves all tests and file groups, refusing duplicates, unknown specs and overflow', t => {
  const { plan } = fixture(t);
  const third = identity('c', 'participation.spec.ts'); plan.tests.push(third);
  assert.deepEqual(browserBatches(plan), [[plan.tests[0], third], [plan.tests[1]]]);
  for (const tests of [[], [plan.tests[0], plan.tests[0]], [{ ...third, file: 'unknown' }],
    [{ ...third, retry: 1 }], Array(limits.tests + 1).fill(third)]) {
    assert.throws(() => browserBatches({ ...plan, tests }));
  }
});

test('combined diagnostics retain every batch and an earlier failure after later success', t => {
  const f = fixture(t), first = f.candidate(0, 'failed'), second = f.candidate(1);
  const batches = [collectBrowserBatch(first.directory, [f.tests[0]], f.plan.metadata, 1),
    collectBrowserBatch(second.directory, [f.tests[1]], f.plan.metadata, 0)];
  const output = join(f.root, 'combined');
  assert.equal(publishBrowserBatches(output, f.plan, batches), 1);
  const run = JSON.parse(readFileSync(join(output, 'approved/run.json')));
  assert.deepEqual(run, { schema: 'loom-browser-run-1', metadata: f.plan.metadata, state: 'completed', status: 'failed',
    planned: 2, ended: 2, omitted: 0, tests: [...first.run.tests, ...second.run.tests] });
  assert.deepEqual(readdirSync(join(output, 'approved')).sort(), ['approval.json', 'run.json', ...f.tests.map(captureName)].sort());
  assert.deepEqual(JSON.parse(readFileSync(join(output, 'approved', captureName(f.tests[0])))), first.bundle);
  batches[0].code = 0; assert.equal(publishBrowserBatches(output, f.plan, batches), 1, 'Failed reporter status also fails the union');
});

test('nonzero process exit cannot become a passing aggregate even with passed reporter results', t => {
  const f = fixture(t);
  const batches = f.tests.map((entry, index) => collectBrowserBatch(f.candidate(index).directory, [entry], f.plan.metadata, index ? 0 : 7));
  assert.equal(publishBrowserBatches(join(f.root, 'combined'), f.plan, batches), 1);
  batches[0].code = 0;
  assert.equal(publishBrowserBatches(join(f.root, 'combined'), f.plan, batches), 0);
});

for (const fault of ['missing', 'duplicate', 'foreign', 'unfinished', 'omitted', 'metadata', 'bundle-status', 'bundle-test', 'missing-failure', 'unknown-field', 'attachment']) {
  test('batch validation refuses ' + fault + ' evidence', t => {
    const f = fixture(t), c = f.candidate(0, 'failed');
    if (fault === 'missing') { c.run.tests = []; c.run.ended = 0; }
    if (fault === 'duplicate') c.run.tests.push(c.run.tests[0]);
    if (fault === 'foreign') c.run.tests[0].test = f.tests[1];
    if (fault === 'unfinished') c.run.state = 'running';
    if (fault === 'omitted') c.run.omitted = 1;
    if (fault === 'metadata') c.run.metadata = { ...c.run.metadata, node: 'unknown' };
    if (fault === 'bundle-status') c.bundle.result.status = 'passed';
    if (fault === 'bundle-test') c.bundle.capture.test = { ...c.bundle.capture.test, line: 9 };
    c.save();
    if (fault === 'missing-failure') rmSync(join(c.directory, 'candidate', captureName(f.tests[0])));
    if (fault === 'unknown-field') writeFileSync(join(c.directory, 'candidate/run.json'), JSON.stringify({ ...c.run, secret: 'synthetic-canary' }));
    if (fault === 'attachment') writeFileSync(join(c.directory, 'candidate/attachment.txt'), 'synthetic-canary');
    assert.throws(() => collectBrowserBatch(c.directory, [f.tests[0]], f.plan.metadata, 1));
  });
}

test('the aggregate refuses omitted batches or duplicated test identities', t => {
  const f = fixture(t);
  const batches = f.tests.map((entry, index) => collectBrowserBatch(f.candidate(index).directory, [entry], f.plan.metadata, 0));
  assert.throws(() => publishBrowserBatches(join(f.root, 'missing'), f.plan, batches.slice(1)), /Missing browser batch/);
  assert.throws(() => publishBrowserBatches(join(f.root, 'duplicate'), f.plan, [batches[0], batches[0]]), /inventory changed/);
});

for (const mode of ['success', 'failure', 'invalid', 'interrupt']) {
  test('real sequential runner preserves process lifetime and ' + mode + ' outcome', { timeout: 60_000 }, async t => {
    const f = fixture(t), journal = join(f.root, 'workers.jsonl');
    const environment = { ...process.env, LOOM_DIAGNOSTICS_KEEP: 'all', LOOM_BATCH_PROBE_MODE: mode, LOOM_BATCH_PROBE_OUTPUT: journal };
    delete environment.LOOM_COVERAGE_OUTPUT;
    // All intentional failure probes use a separate compiler/counter collection;
    // inheriting the Node suite's directory mixes Playwright and tsx source maps.
    environment.NODE_V8_COVERAGE = join(f.root, 'raw-coverage');
    const child = spawn(process.execPath, ['--input-type=module', '-e',
      "import {runBrowserBatches} from './scripts/lib/browser-batches.mjs'; process.exitCode=await runBrowserBatches({config:'tests/diagnostics/batches/playwright.config.ts'});"],
    { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', value => { output += value; }); child.stderr.on('data', value => { output += value; });
    const completed = new Promise((resolveExit, reject) => {
      child.once('error', reject); child.once('close', (code, signal) => resolveExit({ code, signal }));
    });
    if (mode === 'interrupt') {
      const deadline = Date.now() + 30_000;
      while (!existsSync(journal) && child.exitCode === null && Date.now() < deadline) await delay(25);
      const started = existsSync(journal);
      child.kill('SIGTERM');
      await completed;
      assert.ok(started, 'Interrupt probe must reach the first test body');
    }
    const exit = await completed;
    assert.deepEqual(exit, { code: mode === 'success' ? 0 : 1, signal: null });
    assert.equal(output.includes('LOOM_BATCH_SECRET_CANARY_7jQv39'), false, 'No child canary reaches runner output');
    const workers = readFileSync(journal, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(workers.map(worker => worker.batch), mode === 'interrupt' ? [1] : [1, 2]);
    assert.equal(new Set(workers.map(worker => worker.pid)).size, workers.length);
    const raw = join(f.root, 'raw-coverage');
    assert.ok(existsSync(raw), 'Every diagnostic child must collect separately from the enclosing Node suite');
    const scripts = readdirSync(raw).flatMap(file => JSON.parse(readFileSync(join(raw, file))).result);
    assert.ok(scripts.some(script => script.url.endsWith('/scripts/lib/browser-batches.mjs')
      && script.functions.some(fn => fn.ranges.some(range => range.count > 0))), 'The containing runner must flush even after failure or interruption');
    if (mode !== 'interrupt') {
      for (const file of ['participation.spec.ts', 'updates.spec.ts']) {
        assert.ok(scripts.some(script => script.url.endsWith('/tests/diagnostics/batches/' + file)
          && script.functions.some(fn => fn.ranges.some(range => range.count > 0))), 'Every batch must flush its executed Node coverage');
      }
    }
    const approved = resolve('browser-diagnostics/approved');
    const approval = JSON.parse(readFileSync(join(approved, 'approval.json')));
    if (mode === 'invalid' || mode === 'interrupt') {
      assert.equal(approval.status, 'withheld');
      assert.deepEqual(readdirSync(approved), ['approval.json']);
    } else {
      assert.equal(approval.status, 'validated');
      const run = JSON.parse(readFileSync(join(approved, 'run.json')));
      assert.equal(run.status, mode === 'success' ? 'passed' : 'failed');
      assert.equal(run.planned, 2); assert.equal(run.ended, 2); assert.equal(run.omitted, 0);
      assert.deepEqual(run.tests.map(entry => entry.test.file), ['participation.spec.ts', 'updates.spec.ts']);
      assert.deepEqual(run.tests.map(entry => entry.status), [mode === 'success' ? 'passed' : 'failed', 'passed']);
      assert.equal(readdirSync(approved).length, 4);
    }
    for (const file of readdirSync(approved)) assert.equal(readFileSync(join(approved, file), 'utf8').includes('LOOM_BATCH_SECRET_CANARY_7jQv39'), false);
    assert.equal(existsSync(resolve('browser-diagnostics/private-playwright')), false);
  });
}

test('a CI group runs complete selected files in fresh processes and rejects changed discovery', { timeout: 60_000 }, async t => {
  const f = fixture(t), journal = join(f.root, 'selected.jsonl');
  for (const mismatch of [false, true]) {
    const environment = { ...process.env, LOOM_DIAGNOSTICS_KEEP: 'all', LOOM_BATCH_PROBE_MODE: 'success', LOOM_BATCH_PROBE_OUTPUT: journal,
      NODE_V8_COVERAGE: join(f.root, 'selected-coverage-' + mismatch) };
    delete environment.LOOM_COVERAGE_OUTPUT;
    const args = { config: 'tests/diagnostics/batches/playwright.config.ts', files: ['participation.spec.ts'], ...(mismatch ? { expectedPlan: f.plan } : {}) };
    const child = spawn(process.execPath, ['--input-type=module', '-e',
      "import {runBrowserBatches} from './scripts/lib/browser-batches.mjs'; process.exitCode=await runBrowserBatches(" + JSON.stringify(args) + ');'],
    { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', value => { output += value; }); child.stderr.on('data', value => { output += value; });
    const code = await new Promise((done, reject) => { child.once('error', reject); child.once('close', done); });
    assert.equal(code, mismatch ? 1 : 0); assert.equal(output.includes('LOOM_BATCH_SECRET_CANARY_7jQv39'), false);
    assert.deepEqual(readFileSync(journal, 'utf8').trim().split('\n').map(line => JSON.parse(line).batch), [1], 'Mismatched discovery must not execute another test');
    if (!mismatch) {
      const run = JSON.parse(readFileSync(resolve('browser-diagnostics/approved/run.json')));
      assert.equal(run.planned, 1); assert.equal(run.tests[0].test.file, 'participation.spec.ts');
    }
  }
});
