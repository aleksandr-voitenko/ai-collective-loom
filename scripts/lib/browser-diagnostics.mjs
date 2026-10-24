import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// This is a closed vocabulary, not a secret-pattern scrubber. Never add free text
// (including reporter titles/errors/attachments) to an approved document.
// Include three discussion-closure journeys in the complete browser inventory; retain
// both byte envelopes and every per-test collection bound.
export const limits = Object.freeze({ events: 256, pages: 16, contexts: 8, pending: 64,
  steps: 16, tests: 157, bytes: 131072, runBytes: 17 * 1024 * 1024 });
export const root = resolve('browser-diagnostics');
export const files = ['participation.spec.ts', 'saved-items.spec.ts', 'organization.spec.ts', 'search.spec.ts', 'references.spec.ts', 'summaries.spec.ts', 'changes.spec.ts', 'notifications.spec.ts', 'following.spec.ts', 'updates.spec.ts', 'reading.spec.ts', 'attention.spec.ts', 'moderation.spec.ts', 'files.spec.ts', 'files-text.spec.ts', 'reservations.spec.ts', 'notes.spec.ts', 'diagnostics.probe.ts', 'browser-fixtures.ts', 'browser-diagnostics.ts', 'unknown'];
export const issues = ['capture_failed', 'capture_timed_out', 'capture_invalid', 'checkpoint_failed',
  'collector_missing', 'collector_unfinished', 'page_closed_before_capture', 'page_limit', 'context_limit', 'pending_limit', 'byte_limit'];
export const details = ['none', 'default', 'persistent', 'explicit', 'dom_ready', 'load', 'closed',
  'network_changed', 'connection_failed', 'aborted', 'timed_out', 'other_transport', 'browser_exception', 'console_error',
  'server_starting', 'server_ready', 'server_closing', 'server_closed', 'context_closing', 'context_closed', 'collector_finished'];
export const controlNames = ['save_discussion', 'unsave_discussion', 'sign_in', 'create_passkey', 'reply',
  'check_saved_status', 'retry_saved_change', 'retry_collection', 'sign_out', 'confirm_move', 'save_topic', 'check_organization', 'retry_organization', 'search', 'refresh_search', 'add_reference', 'check_reference_target', 'refresh_references'];
export const controlLabels = ['Save discussion', 'Unsave discussion', 'Sign in with passkey', 'Create passkey', 'Reply',
  'Check saved status', 'Retry same change', 'Retry collection', 'Sign out', 'Confirm move', 'Save topic', 'Check organization status', 'Retry same organization change', 'Search shared text', 'Refresh search', 'Add reference', 'Check target', 'Refresh references'];
const routePatterns = [
  '/loom/notes', '/loom/notes/new', '/loom/notes/:id', '/api/v1/me/notes/create', '/api/v1/me/notes/update', '/api/v1/me/notes/delete', '/api/v1/me/notes/status', '/api/v1/me/notes/query', '/api/v1/me/notes/:id', '/api/v1/me/notes/:id/sources',
  '/loom/editing-intent', '/api/v1/editing-intent/announce', '/api/v1/editing-intent/renew', '/api/v1/editing-intent/release', '/api/v1/editing-intent/status', '/api/v1/editing-intent/resources/:id',
  '/loom/file/artifact/:id/:id/:id', '/loom/file/contribution/:id/:id/:id',
  '/api/v1/artifacts/:id/revisions/:id/files/:id/text', '/api/v1/artifacts/:id/revisions/:id/files/:id/text/status',
  '/api/v1/contributions/:id/revisions/:id/attachments/:id/text', '/api/v1/contributions/:id/revisions/:id/attachments/:id/text/status',
  '/api/v1/search/files', '/api/v1/search/files/status', '/api/v1/admin/file-text/health', '/api/v1/admin/file-text/retry', '/api/v1/admin/file-text/rebuild',
  '/loom/promote', '/api/v1/attachment-promotions', '/api/v1/contributions/:id/revisions/:id/attachments', '/api/v1/contributions/:id/revisions/:id/attachments/:id', '/api/v1/contributions/:id/revisions/:id/attachments/:id/download', '/api/v1/artifacts/:id/revisions/:id/provenance',
  '/api/v1/file-uploads', '/api/v1/file-uploads/status', '/api/v1/file-uploads/cleanup', '/api/v1/file-uploads/:id', '/api/v1/file-uploads/:id/bytes', '/api/v1/file-uploads/:id/finalize', '/api/v1/artifacts/:id/revisions/:id/files', '/api/v1/artifacts/:id/revisions/:id/files/:id/download',
  '/loom/moderation', '/api/v1/admin/moderation/state', '/api/v1/admin/moderation/status', '/api/v1/admin/moderation/targets', '/api/v1/admin/moderation/audit', '/api/v1/admin/moderation/resources/:id',
  '/loom/updates', '/api/v1/me/updates/query', '/api/v1/me/updates/members', '/api/v1/me/updates/reasons',
  '/loom/following', '/loom/changes', '/api/v1/me/following', '/api/v1/me/following/lookup', '/api/v1/me/following/state', '/api/v1/me/following/status',
  '/api/v1/me/following/private', '/api/v1/me/following/private/lookup', '/api/v1/me/following/private/state', '/api/v1/me/following/private/status',
  '/api/v1/me/attention/previews', '/api/v1/me/attention/private/mutes/lookup', '/api/v1/me/attention/private/mutes/state', '/api/v1/me/attention/private/dismissals/lookup', '/api/v1/me/attention/private/dismissals/state', '/api/v1/me/attention/private/status', '/api/v1/me/attention/private/list',
  '/loom/attention', '/api/v1/me/attention/mutes/lookup', '/api/v1/me/attention/mutes/state', '/api/v1/me/attention/dismissals/lookup', '/api/v1/me/attention/dismissals/state', '/api/v1/me/attention/status', '/api/v1/me/attention/list',
  '/api/v1/me/routine-updates/query', '/api/v1/me/routine-updates/members', '/api/v1/me/routine-updates/reasons', '/api/v1/me/routine-updates/selection',
  '/loom/reading', '/api/v1/me/reading/lookup', '/api/v1/me/reading/state', '/api/v1/me/reading/status',
  '/api/v1/shared-changes/query', '/api/v1/shared-changes/detail',
  '/loom/notifications', '/api/v1/me/notifications/query', '/api/v1/me/notifications/:id',
  '/api/v1/admin/notifications/health', '/api/v1/admin/notifications/failures', '/api/v1/admin/notifications/retry', '/api/v1/admin/notifications/reconcile',
  '/api/v1/changes', '/api/v1/resources/:id/revisions/:id/change-note', '/api/v1/resources/:id/revisions/:id/change-coverage',
  '/loom/summaries', '/api/v1/summaries', '/api/v1/summary-revisions', '/api/v1/summaries/status', '/api/v1/summaries/editors', '/api/v1/summaries/maintenance',
  '/api/v1/summary-preparations', '/api/v1/summary-preparations/cleanup', '/api/v1/summary-preparations/:id', '/api/v1/summary-preparations/:id/members',
  '/api/v1/discussions/:id/summary', '/api/v1/discussions/:id/summary-sources', '/api/v1/summaries/:id/revisions/:id/coverage', '/api/v1/summaries/:id/revisions/:id/members', '/api/v1/summaries/:id/revisions/:id/sources',
  '/loom', '/loom/saved', '/loom/admin', '/loom/help', '/loom/overview', '/loom/artifacts', '/loom/organize', '/loom/area/:id',
  '/loom/discussion/:id', '/loom/resource/:id', '/loom/resource/:id/:id',
  '/loom/search', '/api/v1/search', '/api/v1/search/status', '/api/v1/search/authors', '/api/v1/admin/search/health', '/api/v1/admin/search/failures', '/api/v1/admin/search/rebuild', '/api/v1/admin/search/retry',
  '/api/v1/runtime', '/api/v1/identity/self', '/api/v1/identity/register/start', '/api/v1/identity/register/finish',
  '/api/v1/identity/signin/start', '/api/v1/identity/signin/finish', '/api/v1/identity/logout',
  '/api/v1/identity/accounts', '/api/v1/identity/credentials', '/api/v1/identity/state', '/api/v1/identity/rename',
  '/api/v1/identity/revoke', '/api/v1/identity/reconcile', '/api/v1/identity/audit',
  '/api/v1/community', '/api/v1/community/setup', '/api/v1/community/settings', '/api/v1/areas',
  '/api/v1/guide', '/api/v1/participants', '/api/v1/contacts', '/api/v1/editors',
  '/api/v1/areas/:id', '/api/v1/areas/:id/discussions', '/api/v1/areas/:id/artifacts',
  '/api/v1/discussions', '/api/v1/discussions/:id', '/api/v1/replies', '/api/v1/artifacts',
  '/api/v1/resources/:id', '/api/v1/resources/:id/revisions/:id', '/api/v1/resources/:id/history',
  '/api/v1/resources/:id/editors', '/api/v1/revisions', '/api/v1/operations/status',
  '/api/v1/references/target', '/api/v1/references/incoming', '/api/v1/resources/:id/revisions/:id/references',
  '/api/v1/contributions/:id/children', '/api/v1/contributions/:id/ancestors', '/api/v1/contributions/:id/context',
  '/api/v1/me/saved-items', '/api/v1/me/saved-items/state', '/api/v1/me/saved-items/lookup', '/api/v1/me/saved-items/status',
  '/api/v1/organization/changes', '/api/v1/organization/status', '/api/v1/organization/resources/:id',
  '/api/v1/organization/children', '/api/v1/organization/destinations', '/api/v1/organization/audit',
  '/api/v1/areas/:id/proposal-route', '/api/v1/areas/:id/metadata-history',
];
export const routes = [...routePatterns, '/assets/:asset', 'blank', 'external', 'unknown'];
const matchers = routePatterns.map(route => [route, new RegExp('^' + route.replaceAll(':id', '[0-9a-fA-F-]{36}') + '$')]);
export function routeTemplate(value, origin) {
  if (value === 'about:blank') return 'blank';
  try {
    const url = new URL(value);
    if (!origin || url.origin !== origin) return 'external';
    return matchers.find(([, re]) => re.test(url.pathname))?.[0]
      ?? (/^\/assets\/[^/]+$/.test(url.pathname) ? '/assets/:asset' : 'unknown');
  } catch { return 'unknown'; }
}
export function count(value) { return Math.min(1_000_000, Math.max(0, Math.round(Number(value) || 0))); }
export function sourceFile(value) { return files.find(file => file !== 'unknown' && value.replaceAll('\\', '/').endsWith('/' + file)) ?? 'unknown'; }
export function testIdentity(info) {
  return { id: createHash('sha256').update(info.testId ?? info.id).digest('hex'), file: sourceFile(info.file ?? info.location.file),
    line: count(info.line ?? info.location.line), column: count(info.column ?? info.location.column),
    repeat: count(info.repeatEachIndex), retry: count(info.retry) };
}
export function captureName(test) { return `${test.id}-${test.repeat}-${test.retry}.json`; }
export function metadata() {
  let commit = 'unknown', dirty = true;
  try {
    commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    dirty = Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
  } catch { /* The validator accepts only the fixed unavailable marker. */ }
  return { commit: /^[a-f0-9]{40}$/.test(commit) ? commit : 'unknown', dirty,
    node: version(process.versions.node), playwright: version(JSON.parse(readFileSync('package.json', 'utf8')).devDependencies['@playwright/test']),
    platform: ['darwin', 'linux', 'win32'].includes(process.platform) ? process.platform : 'other',
    arch: ['arm64', 'x64'].includes(process.arch) ? process.arch : 'other',
    run: /^\d{1,20}$/.test(process.env.GITHUB_RUN_ID ?? '') ? process.env.GITHUB_RUN_ID : 'local',
    attempt: /^\d{1,6}$/.test(process.env.GITHUB_RUN_ATTEMPT ?? '') ? Number(process.env.GITHUB_RUN_ATTEMPT) : 0,
    job: process.env.GITHUB_JOB === 'local-integration' ? 'local-integration' : 'local' };
}
export function version(value) { return /^\d{1,4}(\.\d{1,6}){2,3}$/.test(value) ? value : 'unknown'; }
export function emptyCapture(test) {
  return { schema: 'loom-browser-capture-1', test, complete: false, chromium: 'unknown',
    issues: ['collector_missing'], events: [], events_dropped: 0, pages: [], pending: [], connections: 0 };
}

// Reject unknown keys at every depth. Size checks apply before JSON parsing and
// again to the entire upload candidate; filenames and symlinks are not trusted.
const enumeration = values => value => values.includes(value);
const number = maximum => value => Number.isSafeInteger(value) && value >= 0 && value <= maximum;
const bool = value => typeof value === 'boolean';
const pattern = re => value => typeof value === 'string' && re.test(value);
const array = (check, maximum) => value => Array.isArray(value) && value.length <= maximum && value.every(check);
const object = shape => value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === Object.keys(shape).length && Object.entries(shape).every(([key, check]) => Object.hasOwn(value, key) && check(value[key]));
const n = number(1_000_000), ms = number(86_400_000), file = enumeration(files), route = enumeration(routes);
const test = object({ id: pattern(/^[a-f0-9]{64}$/), file, line: n, column: n, repeat: n, retry: n });
const meta = object({ commit: pattern(/^(unknown|[a-f0-9]{40})$/), dirty: bool, node: pattern(/^(unknown|\d{1,4}(\.\d{1,6}){2,3})$/),
  playwright: pattern(/^(unknown|\d{1,4}(\.\d{1,6}){2,3})$/), platform: enumeration(['darwin', 'linux', 'win32', 'other']),
  arch: enumeration(['arm64', 'x64', 'other']), run: pattern(/^(local|\d{1,20})$/), attempt: n, job: enumeration(['local', 'local-integration']) });
const event = object({ ms, kind: enumeration(['request', 'response', 'request_finished', 'request_failed', 'navigation', 'page', 'exception', 'console', 'fixture']),
  context: number(limits.contexts), page: number(limits.pages), navigation: n, request: n, route,
  method: enumeration(['GET', 'POST', 'other', 'none']), status: number(599), detail: enumeration(details) });
const page = object({ ms, context: number(limits.contexts), page: number(limits.pages), navigation: n, route,
  state: enumeration(['captured', 'failed', 'timed_out', 'closed']), ready: enumeration(['loading', 'interactive', 'complete', 'unknown']),
  online: bool, shell: bool, signed_in: bool, sign_in: bool, alerts: number(32), statuses: number(32),
  controls: array(object({ name: enumeration(controlNames), visible: number(32), enabled: number(32) }), controlNames.length), controls_truncated: bool });
export const validCapture = object({ schema: enumeration(['loom-browser-capture-1']), test, complete: bool,
  chromium: pattern(/^(unknown|\d{1,4}(\.\d{1,6}){2,3})$/), issues: array(enumeration(issues), issues.length),
  events: array(event, limits.events), events_dropped: n, pages: array(page, limits.pages),
  pending: array(event, limits.pending), connections: n });
const step = object({ ms, duration_ms: ms, category: enumeration(['expect', 'fixture', 'hook', 'pw:api', 'test.step', 'other']),
  action: enumeration(['navigate', 'assert', 'click', 'fill', 'evaluate', 'close', 'other']), file, line: n, failed: bool });
const status = enumeration(['passed', 'failed', 'timedOut', 'skipped', 'interrupted', 'unknown']);
const result = object({ status, duration_ms: ms, errors: n, attachments_omitted: n, steps: array(step, limits.steps), steps_dropped: n });
export const validBundle = object({ schema: enumeration(['loom-browser-diagnostic-1']), metadata: meta, result, capture: validCapture });
export const validRun = object({ schema: enumeration(['loom-browser-run-1']), metadata: meta,
  state: enumeration(['not_started', 'running', 'completed']), status, planned: n, ended: n,
  omitted: n, tests: array(object({ test, status, duration_ms: ms }), limits.tests) });
// Private discovery input for sequential runs; never an upload candidate.
export const validPlan = object({ schema: enumeration(['loom-browser-plan-1']), metadata: meta,
  tests: array(test, limits.tests) });
const validApproval = object({ schema: enumeration(['loom-browser-approval-1']), status: enumeration(['validated', 'withheld']),
  reason: enumeration(['none', 'invalid_candidate', 'unavailable']), files: number(limits.tests + 1) });
export function checked(value, check) {
  // Compact encoding leaves the existing byte envelope for evidence as the
  // closed control vocabulary grows; no capture or validation bound is raised.
  const encoded = JSON.stringify(value) + '\n';
  if (Buffer.byteLength(encoded) > limits.bytes || !check(value)) throw new Error('Diagnostic contract rejected');
  return encoded;
}
export function writeChecked(path, value, check) {
  const encoded = checked(value, check);
  mkdirSync(resolve(path, '..'), { recursive: true, mode: 0o700 });
  writeFileSync(path + '.tmp', encoded, { mode: 0o600 });
  renameSync(path + '.tmp', path);
}
export function prepare(directory = root) {
  // This directory contains disposable test output only, never development data.
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(join(directory, 'candidate'), { recursive: true, mode: 0o700 });
  writeChecked(join(directory, 'candidate/run.json'), { schema: 'loom-browser-run-1', metadata: metadata(),
    state: 'not_started', status: 'unknown', planned: 0, ended: 0, omitted: 0, tests: [] }, validRun);
}
export function approve(directory = root) {
  const approved = join(directory, 'approved'), candidate = join(directory, 'candidate');
  rmSync(approved, { recursive: true, force: true });
  mkdirSync(approved, { recursive: true, mode: 0o700 });
  let documents = [];
  try {
    if (lstatSync(candidate).isSymbolicLink()) throw new Error('Invalid candidate');
    const names = readdirSync(candidate);
    if (!names.includes('run.json') || names.length > limits.tests + 1) throw new Error('Invalid candidate');
    let bytes = 0;
    documents = names.map(name => {
      if (name !== 'run.json' && !/^[a-f0-9]{64}-\d{1,7}-\d{1,7}\.json$/.test(name)) throw new Error('Invalid candidate');
      const path = join(candidate, name), stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limits.bytes) throw new Error('Invalid candidate');
      bytes += stat.size;
      if (bytes > limits.runBytes) throw new Error('Invalid candidate');
      const value = JSON.parse(readFileSync(path, 'utf8')), check = name === 'run.json' ? validRun : validBundle;
      const encoded = checked(value, check);
      if (name !== 'run.json' && captureName(value.capture.test) !== name) throw new Error('Invalid candidate');
      return { name, encoded };
    });
    for (const { name, encoded } of documents) writeFileSync(join(approved, name), encoded, { mode: 0o600 });
    writeChecked(join(approved, 'approval.json'), { schema: 'loom-browser-approval-1', status: 'validated', reason: 'none', files: documents.length }, validApproval);
    return true;
  } catch {
    // All-or-nothing: no partly validated input, filenames or exception messages
    // reach the upload directory, including on I/O or parsing failure.
    rmSync(approved, { recursive: true, force: true });
    mkdirSync(approved, { recursive: true, mode: 0o700 });
    writeChecked(join(approved, 'approval.json'), { schema: 'loom-browser-approval-1', status: 'withheld',
      reason: existsSync(candidate) ? 'invalid_candidate' : 'unavailable', files: 0 }, validApproval);
    return false;
  }
}
