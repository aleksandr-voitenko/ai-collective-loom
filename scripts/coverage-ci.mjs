import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, mkdtempSync, rmSync, lstatSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireRepositoryRuntime } from './check-runtime.mjs';
import { metadata, checked, validPlan, validRun, captureName } from './lib/browser-diagnostics.mjs';
import { runBrowserBatches } from './lib/browser-batches.mjs';
import { nodeCoverage, verifyManifest } from './lib/coverage/inputs.mjs';
import { readCaptures } from './lib/coverage/browser.mjs';
import { mappedBrowserCoverage, reportCoverage } from './lib/coverage/report.mjs';
import { readEvidence, writeEvidence, exportNode, importNode, compactBrowser, expandBrowser, buildInventory } from './lib/coverage/portable.mjs';
import { createPlan, planDigest, validateBrowserRun, requireJobs, validateEvidence, readGroups, verifyPlan } from './lib/coverage/ci-plan.mjs';

requireRepositoryRuntime();
const repo = fileURLToPath(new URL('../', import.meta.url)); process.chdir(repo);
const [mode, id, ...extra] = process.argv.slice(2), base = process.env.COVERAGE_BASE_SHA ?? 'origin/main';
const incoming = join(repo, 'coverage/ci-input'), outgoing = join(repo, 'coverage/ci-export'), output = join(repo, 'coverage/approved');
let phase = 'arguments', safeOutput = false;
async function command(args, environment = {}, silent = false) {
  const env = { ...process.env }; delete env.NODE_V8_COVERAGE; delete env.LOOM_COVERAGE_OUTPUT;
  await new Promise((done, reject) => {
    const child = spawn(args[0], args.slice(1), { cwd: repo, env: { ...env, ...environment }, stdio: silent ? 'ignore' : 'inherit' });
    const interrupt = () => child.kill('SIGINT'), terminate = () => child.kill('SIGTERM');
    process.on('SIGINT', interrupt).on('SIGTERM', terminate);
    child.once('error', reject);
    child.once('close', (code, signal) => {
      process.off('SIGINT', interrupt).off('SIGTERM', terminate);
      if (code === 0 && !signal) done(); else reject(new Error('Required process failed'));
    });
  });
}
const npm = name => ['npm', 'run', name];
async function build() {
  await command(npm('app:build'));
  await command([process.execPath, 'node_modules/vite/bin/vite.js', 'build', '--sourcemap', 'hidden']);
}
async function discover(scratch) {
  const path = join(scratch, 'browser-plan.json');
  await command([process.execPath, 'node_modules/@playwright/test/cli.js', 'test', '--list', '--reporter',
    join(repo, 'tests/helpers/browser-inventory-reporter.ts'), '--output', join(scratch, 'discovery')], { LOOM_BROWSER_PLAN: path }, true);
  const plan = readEvidence(path, 128 * 1024); checked(plan, validPlan); return plan;
}
function browserAssets(plan) {
  return new Map(Object.entries(plan.build).filter(([name]) => /^dist\/web\/assets\/.*\.js$/.test(name))
    .map(([name, sha256]) => [name.slice('dist/web/assets/'.length), { sha256, length: readFileSync(join(repo, name), 'utf8').length }]));
}
async function validatePlan(scratch) {
  const plan = readEvidence(join(incoming, 'plan.json'), 2 * 1024 * 1024);
  const current = createPlan(repo, await discover(scratch), base);
  // Job names are a diagnostic label, not an authority or evidence identity.
  // The tested commit, run attempt, runtime, complete inputs and builds must match.
  verifyPlan(plan, current);
  return plan;
}
async function measured(script, scratch, browser = false) {
  const raw = join(scratch, 'raw', script.replaceAll(':', '-')); mkdirSync(raw, { recursive: true });
  const environment = { NODE_V8_COVERAGE: raw, NODE_OPTIONS: [process.env.NODE_OPTIONS, '--enable-source-maps'].filter(Boolean).join(' ') };
  if (browser) environment.LOOM_COVERAGE_OUTPUT = join(scratch, 'browser');
  await command(browser ? [process.execPath, 'scripts/coverage-ci.mjs', 'browser-child', script] : npm(script), environment);
  return raw;
}
function envelope(plan, group, node, browser = null) {
  return { schema: 'loom-ci-evidence-1', plan: planDigest(plan), group: group.id,
    stages: group.stages ?? [], node, browser };
}

try {
  assert.equal(extra.length, 0);
  assert.ok((mode === 'prepare' || mode === 'report') ? id === undefined : ['collect', 'browser-child'].includes(mode) && /^(native|browser)-[0-3]$/.test(id));
  if (mode === 'browser-child') {
    const plan = readEvidence(join(incoming, 'plan.json'), 2 * 1024 * 1024), group = plan.groups.find(group => group.id === id);
    assert.ok(group?.files);
    const expectedPlan = { ...plan.browser, metadata: { ...plan.browser.metadata, job: metadata().job } };
    process.exitCode = await runBrowserBatches({ files: group.files, expectedPlan });
  } else {
    phase = 'paths';
    for (const path of [join(repo, 'coverage'), incoming, outgoing, output]) assert.ok(!existsSync(path) || !lstatSync(path).isSymbolicLink(), 'Evidence paths must not be links');
    safeOutput = true;
    mkdirSync(join(repo, 'coverage'), { recursive: true });
    const scratch = mkdtempSync(join(repo, 'coverage/ci-run-'));
    if (mode !== 'report') { rmSync(outgoing, { recursive: true, force: true }); mkdirSync(outgoing); }
    if (mode === 'prepare') {
      phase = 'probes'; await command(npm('test:coverage'));
      phase = 'checks'; const before = (await import('./lib/coverage/inputs.mjs')).manifest(repo);
      const raw = await measured('check', scratch);
      await command([process.execPath, 'node_modules/vite/bin/vite.js', 'build', '--sourcemap', 'hidden']);
      phase = 'plan'; const plan = createPlan(repo, await discover(scratch), base); verifyManifest(repo, before);
      const value = envelope(plan, plan.groups[0], await exportNode(repo, plan, [raw], join(scratch, 'normalized')));
      validateEvidence(repo, plan, plan.groups[0], value, browserAssets(plan)); verifyManifest(repo, plan.inputs); assert.deepEqual(buildInventory(repo), plan.build, 'Build changed during collection');
      writeEvidence(join(outgoing, 'checks.json'), value); writeEvidence(join(outgoing, 'plan.json'), plan);
      console.log('Validated complete CI plan and checks evidence.');
    } else {
      if (mode === 'report') { phase = 'jobs'; requireJobs(JSON.parse(process.env.LOOM_CI_RESULTS ?? '{}')); }
      phase = 'build'; await build();
      phase = 'plan'; const plan = await validatePlan(scratch), assets = browserAssets(plan);
      if (mode === 'collect') {
        const group = plan.groups.find(group => group.id === id); assert.ok(group);
        const directories = []; let browser = null;
        phase = 'collection';
        if (group.stages) for (const script of group.stages) directories.push(await measured(script, scratch));
        else {
          mkdirSync(join(scratch, 'browser'));
          directories.push(await measured(id, scratch, true));
          const run = readEvidence(join(repo, 'browser-diagnostics/approved/run.json'), 128 * 1024);
          run.metadata.job = plan.browser.metadata.job; validateBrowserRun(plan, group, run);
          const captures = readCaptures(join(scratch, 'browser'), run, assets), pages = captures.flatMap(c => c.pages);
          browser = { run, pages: pages.length, snapshots: pages.reduce((sum, page) => sum + page.captures, 0),
            ranges: captures.map(capture => ({ test: plan.browser.tests.findIndex(test => captureName(test) === capture.id + '.json'),
              entries: compactBrowser(capture.pages.flatMap(page => page.entries), assets) })) };
        }
        phase = 'export'; const value = envelope(plan, group, await exportNode(repo, plan, directories, join(scratch, 'normalized')), browser);
        validateEvidence(repo, plan, group, value, assets); verifyManifest(repo, plan.inputs); assert.deepEqual(buildInventory(repo), plan.build, 'Build changed during collection');
        writeEvidence(join(outgoing, id + '.json'), value); console.log('Validated CI group: ' + id);
      } else {
        phase = 'jobs'; requireJobs(JSON.parse(process.env.LOOM_CI_RESULTS ?? '{}'));
        phase = 'aggregate';
        const values = readGroups(repo, plan, incoming, assets);
        const native = values.filter(value => value.browser === null), browsers = values.filter(value => value.browser !== null);
        const nativeRaw = join(scratch, 'native-import'), browserRaw = join(scratch, 'browser-import');
        const nativeStages = ['check', ...plan.native].map(name => {
          const value = native.find(value => value.stages.includes(name));
          return [value.node[value.stages.indexOf(name)]];
        });
        const nativeDirectories = importNode(repo, plan, nativeStages, nativeRaw);
        const browserDirectories = importNode(repo, plan, [browsers.flatMap(value => value.node)], browserRaw);
        const node = await nodeCoverage(repo, plan.inputs.sources, nativeDirectories, join(scratch, 'native-normalized'), true);
        const browserNode = await nodeCoverage(repo, plan.inputs.sources, browserDirectories, join(scratch, 'browser-normalized'), false);
        const fullRun = { schema: 'loom-browser-run-1', metadata: plan.browser.metadata, state: 'completed', status: 'passed',
          planned: plan.browser.tests.length, ended: plan.browser.tests.length, omitted: 0, tests: browsers.flatMap(value => value.browser.run.tests) };
        checked(fullRun, validRun); validateBrowserRun(plan, { files: [...new Set(plan.browser.tests.map(test => test.file))] }, fullRun);
        const record = { inputs: plan.inputs, base: plan.base, stages: ['check', ...plan.native, 'chromium'].map(name => ({ name, code: 0 })) };
        const { browser, mappedSources } = await mappedBrowserCoverage(repo, record, browsers.flatMap(value => value.browser.ranges)
          .sort((a, b) => captureName(plan.browser.tests[a.test]).localeCompare(captureName(plan.browser.tests[b.test])))
          .flatMap(item => expandBrowser(item.entries, assets)), assets);
        rmSync(output, { recursive: true, force: true }); mkdirSync(output);
        const summary = reportCoverage(repo, record, output, [node, browserNode, browser], {
          tests: fullRun.ended, pages: browsers.reduce((n, value) => n + value.browser.pages, 0),
          snapshots: browsers.reduce((n, value) => n + value.browser.snapshots, 0), mappedSources: mappedSources.size });
        for (const gate of summary.gates) console.log((gate.passed ? 'PASS ' : 'FAIL ') + gate.name);
        process.exitCode = summary.status === 'passed' ? 0 : 1;
      }
    }
  }
} catch {
  // Never echo an assertion's foreign evidence values or a raw capture failure.
  console.error('Parallel coverage failed at ' + phase + '.'); process.exitCode = 1;
  if (mode === 'report' && safeOutput) {
    rmSync(output, { recursive: true, force: true }); mkdirSync(output, { recursive: true });
    writeFileSync(join(output, 'status.json'), JSON.stringify({ schema: 'loom-coverage-status-1', status: 'incomplete', phase }) + '\n');
  } else if (mode !== 'browser-child' && safeOutput) rmSync(outgoing, { recursive: true, force: true });
} finally {
  if (mode === 'report' && safeOutput && process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, 'ready=true\n');
}
