import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, test, type TestContext } from 'node:test';
import { JSDOM } from 'jsdom';
import { StrictMode, useRef } from 'react';
import type { DirectoryObservationView } from '../../src/contracts/organization.js';
import { AuthorizationBoundary } from '../../src/web/AuthorizationBoundary.js';
import { invalidateIdentity } from '../../src/web/participation-client.js';
import { useTopicDirectoryObservation } from '../../src/web/useTopicDirectoryObservation.js';
import { holdReads } from '../helpers/topic-directory-fixtures.js';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://loom.example/',
});
for (const key of ['window', 'document', 'navigator', 'location', 'Event'] as const)
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  value: true,
  configurable: true,
  writable: true,
});
const { act, render, cleanup, screen } = await import('@testing-library/react');
afterEach(() => {
  cleanup();
  invalidateIdentity();
});

function boundary(parent_id: string | null = null, version = 1): DirectoryObservationView {
  return {
    parent_id,
    directory_version: version,
    inherited_closure: false,
    hierarchy_version: version,
  };
}

type ViewerProps = {
  parent: string | null;
  baseline?: DirectoryObservationView;
  more?: boolean;
};
function Directory({ parent, baseline, more = false }: ViewerProps) {
  const section = useRef<HTMLElement>(null);
  const status = useTopicDirectoryObservation(parent, section, baseline, more);
  return (
    <section ref={section}>
      <output>
        {status.pending} {status.continuationStale && 'invalid cursor'}{' '}
        {status.failed && 'check failed'}
      </output>
    </section>
  );
}
function view(props: ViewerProps, owner = 'one') {
  return (
    <StrictMode>
      <AuthorizationBoundary key={owner}>
        {props.parent ? (
          <details>
            <summary>Subtopics</summary>
            <Directory key={props.parent} {...props} />
          </details>
        ) : (
          <Directory {...props} />
        )}
      </AuthorizationBoundary>
    </StrictMode>
  );
}
const status = () => screen.getByRole('status', { hidden: true }).textContent!.trim();
function setup(t: TestContext) {
  const control = { hidden: false, online: true };
  t.mock.getter(document, 'hidden', () => control.hidden);
  t.mock.getter(navigator, 'onLine', () => control.online);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const tick = async (delay = 15000) =>
    act(async () => {
      now += delay;
      t.mock.timers.tick(delay);
    });
  return { ...holdReads(t), control, tick };
}

const observePath = '/api/v1/organization/children/observation';
const failure = (code = 'service_unavailable', status = 503, headers?: Record<string, string>) =>
  Response.json(
    { error: { code, message: 'Synthetic directory failure.' } },
    { status, ...(headers ? { headers } : {}) },
  );

test('coalesced checks wait for accepted rows, distinguish invalidation, and accumulate direct and inherited changes', async (t) => {
  const { calls, tick, respond } = setup(t);
  const baseline = boundary();
  const host = render(view({ parent: null }));
  await tick();
  assert.equal(calls.length, 0);
  host.rerender(view({ parent: null, baseline, more: true }));
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url.pathname + calls[0]!.url.search, observePath);
  await respond(Response.json({ ...baseline, hierarchy_version: 2 }));
  assert.match(status(), /organization.*invalid cursor/);
  await tick();
  await respond(Response.json({ ...baseline, hierarchy_version: 2, inherited_closure: true }));
  assert.match(status(), /updated.*invalid cursor/);
  await tick();
  await respond(Response.json(baseline));
  assert.match(status(), /updated.*invalid cursor/);
  await tick();
  await respond(failure());
  assert.match(status(), /updated.*invalid cursor.*check failed/);
  const count = calls.length;
  await tick(29999);
  assert.equal(calls.length, count);
  await tick(1);
  await respond(Response.json(baseline));
  assert.doesNotMatch(status(), /failed/);
  host.rerender(view({ parent: null, baseline }));
  assert.equal(status(), 'updated');

  const replacement = boundary(null, 7);
  host.rerender(view({ parent: null, baseline: replacement }));
  assert.equal(status(), '');
  await tick();
  await respond(Response.json({ ...replacement, hierarchy_version: 8 }));
  assert.equal(status(), '', 'a complete traversal has no cursor to invalidate');
  await tick();
  await respond(Response.json({ ...replacement, directory_version: 9, hierarchy_version: 9 }));
  assert.equal(status(), 'updated', 'complete and empty directories still see new children');
});

test('native disclosure, hidden and offline lifetimes coalesce and retain pending changes and retry deadlines', async (t) => {
  const { calls, latest, respond, tick, control } = setup(t);
  const parent = randomUUID();
  const baseline = boundary(parent);
  render(view({ parent, baseline }));
  const disclosure = screen.getByText('Subtopics').closest('details')!;
  function toggle(open: boolean) {
    disclosure.open = open;
    disclosure.dispatchEvent(new Event('toggle'));
  }
  await tick(60000);
  assert.equal(calls.length, 0);
  toggle(true);
  window.dispatchEvent(new Event('focus'));
  window.dispatchEvent(new Event('online'));
  await tick(0);
  assert.equal(calls.length, 1);
  assert.equal(latest().url.searchParams.get('parent_id'), parent);
  await tick(60000);
  assert.equal(calls.length, 1, 'held check occupies the only background request slot');
  await respond(Response.json({ ...baseline, directory_version: 2 }));
  assert.equal(status(), 'updated');
  toggle(false);
  window.dispatchEvent(new Event('focus'));
  await tick(60000);
  assert.equal(calls.length, 1);
  assert.equal(status(), 'updated');

  control.hidden = true;
  toggle(true);
  await tick(60000);
  assert.equal(calls.length, 1);
  control.hidden = false;
  control.online = false;
  document.dispatchEvent(new Event('visibilitychange'));
  window.dispatchEvent(new Event('offline'));
  await tick(60000);
  assert.equal(calls.length, 1);
  control.online = true;
  window.dispatchEvent(new Event('online'));
  document.dispatchEvent(new Event('visibilitychange'));
  window.dispatchEvent(new Event('focus'));
  await tick(0);
  assert.equal(calls.length, 2);
  await respond(failure('temporarily_throttled', 429, { 'Retry-After': '42' }));
  assert.match(status(), /updated.*check failed/);
  toggle(false);
  toggle(true);
  await tick(41999);
  assert.equal(calls.length, 2);
  await tick(1);
  assert.equal(calls.length, 3);
});

test('same-owner throttling survives accepted replacement; stale positive evidence cannot acknowledge or update a newer list', async (t) => {
  const { calls, tick, respond } = setup(t);
  const host = render(view({ parent: null, baseline: boundary() }));
  await tick();
  const second = boundary(null, 2);
  host.rerender(view({ parent: null, baseline: second }));
  window.dispatchEvent(new Event('focus'));
  await tick();
  assert.equal(calls.length, 1);
  await respond(failure('temporarily_throttled', 429, { 'Retry-After': '42' }));
  assert.equal(status(), '', 'a superseded check does not add new-view failure feedback');
  window.dispatchEvent(new Event('focus'));
  await tick(41999);
  assert.equal(calls.length, 1);
  await tick(1);
  assert.equal(calls.length, 2);
  const third = boundary(null, 3);
  host.rerender(view({ parent: null, baseline: third }));
  await respond(Response.json(boundary(null, 4)));
  assert.equal(status(), '');
  await tick();
  await respond(Response.json({ ...third, directory_version: 4 }));
  assert.equal(status(), 'updated');
});

test('a coalesced reopen waits for a superseded check, then checks the accepted replacement', async (t) => {
  const { calls, tick, respond } = setup(t);
  const parent = randomUUID();
  const host = render(view({ parent, baseline: boundary(parent) }));
  const disclosure = screen.getByText('Subtopics').closest('details')!;
  function toggle(open: boolean) {
    disclosure.open = open;
    disclosure.dispatchEvent(new Event('toggle'));
  }
  toggle(true);
  await tick(0);
  assert.equal(calls.length, 1);
  toggle(false);
  host.rerender(view({ parent, baseline: boundary(parent, 2) }));
  toggle(true);
  window.dispatchEvent(new Event('focus'));
  window.dispatchEvent(new Event('online'));
  await tick(1000);
  assert.equal(calls.length, 1, 'the old check still occupies the request slot');
  await respond(Response.json(boundary(parent, 4)));
  assert.equal(status(), '', 'a stale check cannot publish findings for the replacement');
  await tick(0);
  assert.equal(calls.length, 2, 'the discarded response cannot satisfy the reopen');
  await respond(Response.json(boundary(parent, 3)));
  assert.equal(status(), 'updated');
  await tick(14999);
  assert.equal(calls.length, 2);
});

test('a replacement acknowledges only the scoped and hierarchy revisions included in its rows', async (t) => {
  const { tick, respond } = setup(t);
  const first = boundary();
  const host = render(view({ parent: null, baseline: first, more: true }));
  await tick();
  await respond(Response.json({ ...first, directory_version: 3, hierarchy_version: 5 }));
  assert.match(status(), /updated.*invalid cursor/);
  host.rerender(view({ parent: null, baseline: boundary(null, 2), more: true }));
  assert.match(status(), /updated.*invalid cursor/, 'the replacement is behind on both revisions');
  host.rerender(view({ parent: null, baseline: boundary(null, 3), more: true }));
  assert.match(status(), /organization.*invalid cursor/, 'only the continuation is still stale');
  host.rerender(view({ parent: null, baseline: boundary(null, 3) }));
  assert.equal(status(), '', 'an exhausted traversal has no continuation to invalidate');
  host.rerender(view({ parent: null, baseline: boundary(null, 5), more: true }));
  assert.equal(status(), '', 'the replacement covers all observed changes');
});

test('stale parent, instance and identity responses cannot restore a departed directory', async (t) => {
  const { tick, latest, respond, calls } = setup(t);
  const host = render(view({ parent: null, baseline: boundary() }));
  await tick();
  const root = latest();
  const parent = randomUUID();
  host.rerender(view({ parent, baseline: boundary(parent) }));
  assert.equal(root.signal.aborted, true);
  await respond(Response.json(boundary(null, 2)), root);
  assert.equal(status(), '');
  const details = screen.getByText('Subtopics').closest('details')!;
  details.open = true;
  details.dispatchEvent(new Event('toggle'));
  await tick(0);
  const child = latest();
  host.rerender(view({ parent: null, baseline: boundary() }, 'two'));
  assert.equal(child.signal.aborted, true);
  await respond(Response.json(boundary(parent, 2)), child);
  assert.equal(status(), '');
  await tick();
  await act(async () => invalidateIdentity());
  await respond(Response.json(boundary(null, 2)));
  assert.ok(screen.getByRole('alert'));
  assert.equal(screen.queryByRole('status'), null);
  await tick(60000);
  assert.equal(calls.length, 3);
});

test('unavailable scope withdraws even a replacement that superseded the requesting traversal', async (t) => {
  const { tick, respond } = setup(t);
  const host = render(view({ parent: null, baseline: boundary() }));
  await tick();
  await respond(Response.json(boundary(randomUUID(), 2)));
  assert.equal(status(), 'check failed', 'reject evidence belonging to another directory');
  await tick(30000);
  host.rerender(view({ parent: null, baseline: boundary(null, 2) }));
  await respond(failure('unavailable', 404));
  assert.ok(screen.getByRole('alert').textContent?.includes('protected view was withdrawn'));
  assert.equal(screen.queryByRole('status'), null);
});
