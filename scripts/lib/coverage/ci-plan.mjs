import assert from 'node:assert/strict';
import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { manifest, digest } from './inputs.mjs';
import { comparisonBase } from './policy.mjs';
import { browserBatches } from '../browser-batches.mjs';
import { buildInventory, keys, validateNode, expandBrowser, readEvidence } from './portable.mjs';
import { checked, validRun, captureName } from '../browser-diagnostics.mjs';

// Seconds observed in PR #28 and the local arm64 pilot acceptance run. Unknown
// suites are still included; these weights affect scheduling only, never selection.
const nativeSeconds = { migrations: 5, app: 12, publication: 4, identity: 105, participation: 52,
  'saved-items': 16, organization: 70, references: 105, summaries: 72, search: 58, changes: 63,
  notifications: 81, following: 109, updates: 127, attention: 191, reading: 69, moderation: 58,
  files: 242, reservations: 134, notes: 78, recovery: 100, pilot: 310 };
const browserSeconds = { administration: 23, attention: 215, changes: 50, 'files-text': 37, files: 99,
  following: 84, moderation: 57, notes: 50, notifications: 44, organization: 110, participation: 150,
  reading: 109, recovery: 33, references: 71, reservations: 40, 'saved-items': 88, search: 41, summaries: 60, updates: 75, pilot: 125 };
export function partition(items, weight, count = 4) {
  assert.ok(items.length >= count);
  const groups = Array.from({ length: count }, () => ({ weight: 0, items: [] }));
  for (const item of [...items].sort((a, b) => weight(b) - weight(a) || String(a).localeCompare(String(b)))) {
    const group = groups.reduce((a, b) => a.weight <= b.weight ? a : b);
    group.items.push(item); group.weight += weight(item);
  }
  return groups.map(group => group.items);
}
export function createPlan(repo, browser, base) {
  const packageJson = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
  const native = Object.keys(packageJson.scripts).filter(name => /^test:[a-z-]+:postgres$/.test(name));
  const specs = browserBatches(browser);
  return { schema: 'loom-ci-plan-1', inputs: manifest(repo), base: comparisonBase(repo, base),
    browser, build: buildInventory(repo),
    groups: [
      { id: 'checks', stages: ['check'] },
      ...partition(native, script => nativeSeconds[script.slice(5, -9)] ?? 60).map((stages, i) => ({ id: 'native-' + i, stages })),
      ...partition(specs.map(group => group[0].file), file => browserSeconds[file.replace('.spec.ts', '')] ?? specs.find(group => group[0].file === file).length * 8)
        .map((files, i) => ({ id: 'browser-' + i, files })),
    ], native };
}
export const planDigest = plan => digest(JSON.stringify(plan));
export function expectedTests(plan, group) {
  return plan.browser.tests.filter(test => group.files.includes(test.file));
}
export function validateBrowserRun(plan, group, run) {
  checked(run, validRun);
  assert.deepEqual(run.metadata, plan.browser.metadata, 'Browser metadata changed');
  assert.equal(run.state, 'completed'); assert.equal(run.status, 'passed'); assert.equal(run.omitted, 0);
  const tests = expectedTests(plan, group), order = values => [...values].sort((a, b) => captureName(a).localeCompare(captureName(b)));
  assert.equal(run.planned, tests.length); assert.equal(run.ended, tests.length);
  assert.ok(run.tests.every(item => item.status === 'passed'));
  assert.deepEqual(order(run.tests.map(item => item.test)), order(tests), 'Browser inventory changed');
}
export function requireJobs(results) {
  assert.deepEqual(Object.keys(results).sort(), ['browser', 'checks', 'native', 'storage']);
  assert.ok(Object.values(results).every(result => result === 'success'), 'Every required CI job must succeed');
}

export function validateEvidence(repo, plan, group, value, assets) {
  keys(value, ['schema', 'plan', 'group', 'stages', 'node', 'browser']);
  assert.equal(value.schema, 'loom-ci-evidence-1'); assert.equal(value.plan, planDigest(plan)); assert.equal(value.group, group.id);
  assert.deepEqual(value.stages, group.stages ?? []); validateNode(repo, plan, value.node);
  assert.equal(value.node.length, group.stages?.length ?? 1, 'Missing Node stage');
  if (!group.files) assert.equal(value.browser, null);
  else {
    keys(value.browser, ['run', 'pages', 'snapshots', 'ranges']); validateBrowserRun(plan, group, value.browser.run);
    for (const field of ['pages', 'snapshots']) assert.ok(Number.isSafeInteger(value.browser[field]) && value.browser[field] >= 0 && value.browser[field] <= 1_000_000);
    assert.ok(value.browser.pages <= value.browser.run.ended * 16 && value.browser.snapshots >= value.browser.pages);
    assert.ok(Array.isArray(value.browser.ranges));
    const expected = expectedTests(plan, group).map(test => plan.browser.tests.indexOf(test)).sort((a, b) => a - b);
    assert.deepEqual(value.browser.ranges.map(item => item.test).sort((a, b) => a - b), expected, 'Missing or duplicate browser measurements');
    for (const item of value.browser.ranges) { keys(item, ['test', 'entries']); expandBrowser(item.entries, assets); }
  }
}

export function readGroups(repo, plan, directory, assets) {
  const stat = lstatSync(directory); assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), 'Invalid evidence directory');
  assert.deepEqual(readdirSync(directory).sort(), ['plan.json', ...plan.groups.map(group => group.id + '.json')].sort(), 'Missing or foreign CI evidence');
  return plan.groups.map(group => {
    const value = readEvidence(join(directory, group.id + '.json'));
    validateEvidence(repo, plan, group, value, assets);
    return value;
  });
}

export function verifyPlan(plan, current) {
  // Validate the closed diagnostic vocabulary before normalizing its job label.
  browserBatches(plan.browser);
  const expected = structuredClone(current);
  expected.browser.metadata.job = plan.browser.metadata.job;
  assert.deepEqual(plan, expected, 'Execution plan no longer matches this checkout/run');
}
