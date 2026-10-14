import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { limits, root, validRun, validBundle, validCapture, prepare, approve, routeTemplate } from '../../scripts/lib/browser-diagnostics.mjs';

const canary = 'LOOM_DIAGNOSTIC_SECRET_CANARY_7jQv39';
const result = spawnSync(process.execPath, ['scripts/browser-tests.mjs', '--config', 'tests/diagnostics/playwright.config.ts'], {
  env: { ...process.env, LOOM_DIAGNOSTICS_KEEP: 'all' }, encoding: 'utf8', timeout: 180_000, maxBuffer: 1024 * 1024,
});
// Do not print a child's potentially unsafe output on assertion failure.
assert.equal(result.error === undefined, true, 'Controlled browser child must complete');
assert.equal(result.status, 1, 'Intentional failures must preserve the nonzero browser result');
assert.equal(result.stdout.includes(canary) || result.stderr.includes(canary), false, 'Runner output must omit canaries');
const approved = join(root, 'approved'), names = readdirSync(approved);
assert.equal(names.length, 10, 'Eight failed bundles, run summary and approval record');
let bytes = 0;
const bundles: any[] = [];
for (const name of names) {
  assert.match(name, /^(?:run|approval|[a-f0-9]{64}-\d+-\d+)\.json$/);
  const data = readFileSync(join(approved, name), 'utf8'); bytes += Buffer.byteLength(data);
  assert.ok(Buffer.byteLength(data) <= limits.bytes);
  assert.equal(data.includes(canary), false, 'Complete upload candidate must omit the canary');
  assert.equal(/"(?:cookies|authorization|csrf|ticket|secret|storageState|localStorage|sessionStorage|headers|body|stack|message|attachments|title)"\s*:/.test(data), false);
  assert.equal(data.includes('http://') || data.includes('https://') || data.includes('?secret=') || data.includes('#' + canary), false);
  const document = JSON.parse(data);
  if (name === 'run.json') {
    assert.ok(validRun(document)); assert.equal(document.state, 'completed'); assert.equal(document.status, 'failed');
    assert.equal(document.tests.length, 8); assert.equal(document.ended, 8);
    assert.ok(document.tests.every((test: any) => test.status === 'failed'));
  } else if (name === 'approval.json') assert.equal(document.status, 'validated');
  else { assert.ok(validBundle(document)); bundles.push(document); }
}
assert.ok(bytes <= limits.runBytes);
assert.ok(bundles.every(bundle => bundle.result.errors === 1), 'Capture must not add or replace the test error');
assert.equal(existsSync(join(root, 'private-playwright')), false, 'Raw reporter output/attachments must be removed');
const missing = bundles.find(bundle => bundle.capture.pages.some((page: any) => page.route === '/loom/discussion/:id'));
assert.ok(missing, 'Additional tab must be captured before explicit close');
assert.equal(missing.capture.complete, true);
assert.ok(missing.result.attachments_omitted >= 1);
assert.ok(missing.result.steps.some((step: any) => step.failed && step.category === 'expect' && step.line > 0));
assert.ok(missing.capture.events.some((event: any) => event.route === '/api/v1/identity/self' && event.status === 401));
assert.ok(missing.capture.events.some((event: any) => event.page === 0 && event.route === '/api/v1/identity/self' && event.status === 401));
assert.ok(missing.capture.pending.some((event: any) => event.route === '/api/v1/areas'));
assert.ok(missing.capture.pages.some((page: any) => page.page === 2 && page.route === '/loom/discussion/:id'
  && page.controls.some((control: any) => control.name === 'save_discussion' && control.visible === 0)));
assert.ok(missing.capture.events.findIndex((event: any) => event.detail === 'context_closed')
  < missing.capture.events.findIndex((event: any) => event.detail === 'server_closing'));
assert.ok(bundles.some(bundle => bundle.capture.events.some((event: any) => event.kind === 'request_failed' && event.route === '/loom' && event.detail === 'connection_failed')));
assert.ok(bundles.some(bundle => bundle.capture.events.some((event: any) => event.kind === 'exception')
  && bundle.capture.pages.some((page: any) => page.route === '/loom/admin' && page.state === 'captured')));
assert.ok(bundles.some(bundle => !bundle.capture.complete && bundle.capture.issues.includes('capture_failed')));
assert.ok(bundles.some(bundle => !bundle.capture.complete && bundle.capture.issues.includes('page_closed_before_capture')
  && bundle.capture.events.some((event: any) => event.detail === 'explicit')));
assert.ok(bundles.some(bundle => bundle.capture.events_dropped > 0 && bundle.capture.events.length === limits.events));
assert.ok(bundles.some(bundle => bundle.capture.complete && bundle.capture.events.some((event: any) => event.detail === 'persistent')));
assert.ok(bundles.some(bundle => !bundle.capture.complete && bundle.capture.events.some((event: any) => event.detail === 'server_closing')
  && !bundle.capture.events.some((event: any) => event.detail === 'server_closed')));
assert.equal(routeTemplate('https://user:' + canary + '@example.test/loom?secret=' + canary + '#' + canary, 'https://example.test'), '/loom');
assert.equal(routeTemplate('https://example.test/' + canary, 'https://example.test'), 'unknown');

const large = structuredClone(missing.capture);
large.events = Array.from({ length: limits.events }, () => ({ ...large.events[0], ms: 86_400_000,
  kind: 'request_finished', context: 8, page: 16, request: 1_000_000, navigation: 1_000_000,
  route: '/api/v1/resources/:id/revisions/:id', detail: 'connection_failed', method: 'other', status: 599 }));
large.pages = Array.from({ length: limits.pages }, () => ({ ...large.pages[0], ms: 86_400_000, context: 8, page: 16, navigation: 1_000_000,
  controls: large.pages[0].controls.map((control: any) => ({ ...control, visible: 32, enabled: 32 })) }));
large.pending = Array.from({ length: limits.pending }, () => large.events[0]);
assert.ok(validCapture(large));
// Maximum collection dimensions still fit the capture envelope. Independently
// test oversized file rejection below; do not invent invalid extra event fields
// just to force a byte overflow that the closed schema already prevents.
assert.ok(Buffer.byteLength(JSON.stringify(large, null, 2)) <= limits.bytes - 8192);

// Validate complete candidates, not a hand-picked JSON. Refuse unknown files,
// metadata/attachment injection, oversized data and symlinks without copying any.
const directory = mkdtempSync(join(tmpdir(), 'loom-diagnostic-validation-'));
try {
  prepare(directory);
  assert.equal(approve(directory), true);
  assert.equal(JSON.parse(readFileSync(join(directory, 'approved/run.json'), 'utf8')).state, 'not_started');
  for (const fault of ['field', 'attachment', 'oversize', 'symlink']) {
    prepare(directory);
    const path = join(directory, 'candidate/run.json');
    if (fault === 'field') {
      const value = JSON.parse(readFileSync(path, 'utf8')); value.secret = canary; writeFileSync(path, JSON.stringify(value));
    } else if (fault === 'attachment') writeFileSync(join(directory, 'candidate/attachment.txt'), canary);
    else if (fault === 'oversize') writeFileSync(path, ' '.repeat(limits.bytes + 1));
    else { rmSync(path); symlinkSync(join(root, 'candidate/run.json'), path); }
    assert.equal(approve(directory), false);
    assert.deepEqual(readdirSync(join(directory, 'approved')), ['approval.json']);
    const text = readFileSync(join(directory, 'approved/approval.json'), 'utf8');
    assert.equal(text.includes(canary), false); assert.equal(JSON.parse(text).status, 'withheld');
  }
} finally { rmSync(directory, { recursive: true, force: true }); }
console.log('Browser diagnostics verified: 8 controlled failures, full upload-candidate canaries/bounds, lifecycle and 4 fail-closed validation cases.');
