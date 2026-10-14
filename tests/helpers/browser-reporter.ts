import type { FullConfig, FullResult, Reporter, Suite, TestCase, TestResult, TestStep } from '@playwright/test/reporter';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, prepare, metadata, limits, testIdentity, captureName, emptyCapture, sourceFile, count,
  validCapture, validBundle, validRun, writeChecked } from '../../scripts/lib/browser-diagnostics.mjs';

type Step = { ms: number; duration_ms: number; category: string; action: string; file: string; line: number; failed: boolean };
export default class BrowserReporter implements Reporter {
  private readonly steps = new Map<string, { kept: Step[]; dropped: number }>();
  private selected = new Set<string>();
  private run!: { schema: string; metadata: ReturnType<typeof metadata>; state: string; status: string;
    planned: number; ended: number; omitted: number; tests: { test: ReturnType<typeof testIdentity>; status: string; duration_ms: number }[] };
  printsToStdio() { return true; }
  onBegin(_config: FullConfig, suite: Suite) {
    prepare();
    const tests = suite.allTests();
    this.selected = new Set(tests.slice(0, limits.tests).map(test => testIdentity(test).id));
    process.env.LOOM_DIAGNOSTIC_IDS = [...this.selected].join(',');
    this.run = { schema: 'loom-browser-run-1', metadata: metadata(), state: 'running', status: 'unknown',
      planned: count(tests.length), ended: 0, omitted: Math.max(0, tests.length - limits.tests), tests: [] };
    this.saveRun();
  }
  private saveRun() { writeChecked(join(root, 'candidate/run.json'), this.run, validRun); }
  onStepEnd(test: TestCase, result: TestResult, step: TestStep) {
    const identity = testIdentity({ ...test, retry: result.retry });
    if (!this.selected.has(identity.id)) return;
    const key = captureName(identity), record = this.steps.get(key) ?? { kept: [], dropped: 0 };
    // Titles include locators, URLs and argument values. Use only fixed operation
    // categories; failure source location points back to the reviewed test.
    const action = /^(page\.)?goto|^Navigate to |^Reload/.test(step.title) ? 'navigate'
      : step.category === 'expect' ? 'assert' : /^(locator\.)?click|^Click /.test(step.title) ? 'click'
      : /^(locator\.)?fill|^Fill /.test(step.title) ? 'fill' : /evaluate|Evaluate/.test(step.title) ? 'evaluate'
      : /close|Close/.test(step.title) ? 'close' : 'other';
    if (record.kept.length === limits.steps) {
      const index = record.kept.findIndex(item => !item.failed);
      record.kept.splice(index < 0 ? 0 : index, 1); record.dropped = count(record.dropped + 1);
    }
    record.kept.push({ ms: count(step.startTime.getTime() - result.startTime.getTime()), duration_ms: count(step.duration),
      category: ['expect', 'fixture', 'hook', 'pw:api', 'test.step'].includes(step.category) ? step.category : 'other',
      action, file: sourceFile(step.location?.file ?? ''), line: count(step.location?.line), failed: Boolean(step.error) });
    this.steps.set(key, record);
  }
  onTestEnd(test: TestCase, result: TestResult) {
    const identity = testIdentity({ ...test, retry: result.retry }), key = captureName(identity);
    this.run.ended = count(this.run.ended + 1);
    if (this.selected.has(identity.id) && this.run.tests.length < limits.tests) {
      this.run.tests.push({ test: identity, status: result.status, duration_ms: count(result.duration) });
      let capture = emptyCapture(identity);
      const path = join(root, 'capture', key);
      try {
        if (existsSync(path)) {
          const stat = lstatSync(path);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limits.bytes) throw new Error();
          const value = JSON.parse(readFileSync(path, 'utf8'));
          if (!validCapture(value) || captureName(value.test) !== key) throw new Error();
          capture = value;
          if (!capture.complete && !capture.issues.length) capture.issues.push('collector_unfinished');
        }
      } catch { capture.issues = ['capture_invalid']; }
      const steps = this.steps.get(key) ?? { kept: [], dropped: 0 };
      // Keep summaries for all tests; full bundles on failure or explicit bounded
      // investigation. No reporter attachments are copied, opened, or named.
      if (result.status !== 'passed' || !capture.complete || process.env.LOOM_DIAGNOSTICS_KEEP === 'all') {
        const bundle = { schema: 'loom-browser-diagnostic-1', metadata: this.run.metadata,
          result: { status: result.status, duration_ms: count(result.duration), errors: count(result.errors.length),
            attachments_omitted: count(result.attachments.length), steps: steps.kept, steps_dropped: steps.dropped }, capture };
        try { writeChecked(join(root, 'candidate', key), bundle, validBundle); }
        catch {
          // Safe fallback. A collector failure must not hide the original result.
          bundle.capture = { ...emptyCapture(identity), issues: ['byte_limit'] };
          writeChecked(join(root, 'candidate', key), bundle, validBundle);
        }
      }
    }
    this.steps.delete(key);
    this.saveRun();
    process.stdout.write(`BROWSER ${result.status} ${identity.file}:${identity.line} repeat=${identity.repeat}\n`);
  }
  onEnd(result: FullResult) {
    if (!this.run) return;
    this.run.state = 'completed'; this.run.status = result.status;
    this.saveRun();
  }
  // Deliberately omit arbitrary stdout/stderr, errors, titles and attachments.
  // The command wrapper also contains pre-reporter CLI failures.
}
