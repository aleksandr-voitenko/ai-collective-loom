import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

function ratio(value) {
  assert.ok(Number.isSafeInteger(value?.covered) && Number.isSafeInteger(value?.total)
    && value.covered >= 0 && value.total > 0 && value.covered <= value.total, 'Invalid coverage ratio');
  return value;
}
export function atLeast(actual, required) {
  ratio(actual); ratio(required);
  return BigInt(actual.covered) * BigInt(required.total) >= BigInt(required.covered) * BigInt(actual.total);
}
export function validateBaseline(baseline, previous) {
  assert.equal(baseline.schema, 'loom-coverage-baseline-1');
  assert.equal(baseline.method, 'v8-exact-source-ranges-2');
  assert.equal(baseline.scope, 'application');
  assert.equal(baseline.minimumChangedLines, 90);
  assert.equal(baseline.minimumBranches, 85);
  ratio(baseline.lines); ratio(baseline.branches);
  if (previous) {
    validateBaseline(previous);
    assert.ok(atLeast(baseline.lines, previous.lines), 'Baseline line coverage must not be lowered');
    assert.ok(atLeast(baseline.branches, previous.branches), 'Baseline branch coverage must not be lowered');
  }
}
export function evaluateGates(application, changed, baseline) {
  validateBaseline(baseline);
  assert.ok(Number.isSafeInteger(changed.total) && changed.total >= 0
    && Number.isSafeInteger(changed.covered) && changed.covered >= 0 && changed.covered <= changed.total);
  return [
    { name: 'changed-lines', passed: changed.total === 0 || atLeast(changed, { covered: 90, total: 100 }), actual: changed, minimum: 90, applicable: changed.total > 0 },
    { name: 'branches', passed: atLeast(application.branches, { covered: 85, total: 100 }), actual: application.branches, minimum: 85, applicable: true },
    ...['lines', 'branches'].map(metric => ({ name: 'baseline-' + metric,
      passed: atLeast(application[metric], baseline[metric]), actual: application[metric], minimum: baseline[metric], applicable: true })),
  ];
}
export function git(repo, args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
export function comparisonBase(repo, requested = 'origin/main') {
  const reference = /^0+$/.test(requested) ? 'origin/main' : requested;
  const commit = git(repo, ['rev-parse', '--verify', '--end-of-options', reference + '^{commit}']).trim();
  assert.match(commit, /^[a-f0-9]{40}$/);
  return git(repo, ['merge-base', 'HEAD', commit]).trim();
}
export function changedLineCoverage(repo, base, files) {
  let total = 0, covered = 0;
  const details = [];
  const tracked = new Set(git(repo, ['ls-files', '-z']).split('\0'));
  for (const [name, file] of Object.entries(files)) {
    if (!name.startsWith('src/')) continue;
    const changed = new Set();
    if (!tracked.has(name)) for (const line of Object.keys(file.lines)) changed.add(Number(line));
    else {
      const diff = git(repo, ['diff', '--no-ext-diff', '--no-renames', '--unified=0', base, '--', name]);
      for (const match of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
        const start = Number(match[1]), count = match[2] === undefined ? 1 : Number(match[2]);
        for (let line = start; line < start + count; line++) changed.add(line);
      }
    }
    const reportable = [...changed].filter(line => Object.hasOwn(file.lines, line));
    const hits = reportable.filter(line => file.lines[line] > 0).length;
    total += reportable.length; covered += hits;
    if (reportable.length) details.push({ file: name, total: reportable.length, covered: hits });
  }
  return { total, covered, files: details };
}
