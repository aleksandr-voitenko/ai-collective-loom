import { chromium, type BrowserContext, type Page, type Request, type TestInfo } from '@playwright/test';
import type { Server } from 'node:net';
import { join } from 'node:path';
import { setTimeout, clearTimeout } from 'node:timers';
import {
  limits, root, count, controlNames, controlLabels, routeTemplate, testIdentity, captureName,
  validCapture, writeChecked, version,
} from '../../scripts/lib/browser-diagnostics.mjs';

type Event = { ms: number; kind: string; context: number; page: number; navigation: number;
  request: number; route: string; method: string; status: number; detail: string };
type View = { ready: string; online: boolean; shell: boolean; signed_in: boolean; sign_in: boolean;
  alerts: number; statuses: number; controls: { name: string; visible: number; enabled: number }[]; controls_truncated: boolean };
type Snapshot = View & { ms: number; context: number; page: number; navigation: number; route: string; state: string };
type PageState = { context: number; page: number; navigation: number };

const noView: View = { ready: 'unknown', online: false, shell: false, signed_in: false, sign_in: false,
  alerts: 0, statuses: 0, controls: [], controls_truncated: false };

// Only fixed booleans/counts cross this browser boundary. Labels are compared in
// the browser; no text, input values, URLs, DOM, or storage are returned.
function selectedView(labels: string[], names: string[]): View {
  const buttons = document.querySelectorAll('button'), subset = Array.from(buttons).slice(0, 128);
  return {
    ready: document.readyState, online: navigator.onLine, shell: Boolean(document.querySelector('.loom-app')),
    signed_in: Boolean(document.querySelector('.account')), sign_in: Boolean(document.querySelector('.signin')),
    alerts: Math.min(32, document.querySelectorAll('[role="alert"]').length),
    statuses: Math.min(32, document.querySelectorAll('[role="status"]').length),
    controls: labels.map((label, index) => {
      const matches = subset.filter(button => (button.getAttribute('aria-label') ?? button.textContent?.trim()) === label
        && button.getClientRects().length > 0 && getComputedStyle(button).visibility !== 'hidden');
      return { name: names[index]!, visible: Math.min(32, matches.length), enabled: Math.min(32, matches.filter(button => !button.disabled).length) };
    }),
    controls_truncated: buttons.length > 128,
  };
}

export class BrowserDiagnostics {
  readonly identity;
  private readonly started = performance.now();
  private readonly events: Event[] = [];
  private readonly pages = new Map<Page, PageState>();
  private readonly contexts = new Set<BrowserContext>();
  private readonly snapshots = new Map<number, Snapshot>();
  private readonly requests = new WeakMap<Request, Event>();
  private readonly pending = new Map<number, Event>();
  private readonly pendingAtCapture = new Map<number, Event>();
  private readonly problems = new Set<string>();
  private readonly detach: (() => void)[] = [];
  private dropped = 0;
  private requestId = 0;
  private pageId = 0;
  private contextId = 0;
  private connections = 0;
  private browserVersion = 'unknown';
  private origin = '';
  private complete = false;
  private serverActive = false;
  private readonly enabled: boolean;

  constructor(info: TestInfo) {
    this.identity = testIdentity(info);
    this.enabled = (process.env.LOOM_DIAGNOSTIC_IDS ?? '').split(',').includes(this.identity.id);
    this.checkpoint();
  }
  setOrigin(origin: string) { this.origin = new URL(origin).origin; }
  private now() { return Math.min(86_400_000, count(performance.now() - this.started)); }
  private event(fields: Partial<Event>) {
    if (!this.enabled) return;
    const event = { ms: this.now(), kind: 'fixture', context: 0, page: 0, navigation: 0,
      request: 0, route: 'unknown', method: 'none', status: 0, detail: 'none', ...fields };
    if (this.events.length === limits.events) { this.events.shift(); this.dropped = count(this.dropped + 1); }
    this.events.push(event);
  }
  private problem(problem: string) { this.problems.add(problem); }
  phase(detail: string) {
    if (detail === 'server_starting') this.serverActive = true;
    if (detail === 'server_closed') {
      this.serverActive = false;
      // Node can deliver a socket's close listener after the server's completed
      // close callback. That callback establishes closure; a queued counter event
      // must not falsely label successful fixture disposal as incomplete.
      this.connections = 0;
    }
    this.event({ detail }); this.checkpoint();
  }
  observeServer(server: Server) {
    const onConnection = (socket: import('node:net').Socket) => {
      this.connections = count(this.connections + 1);
      socket.once('close', () => { this.connections = Math.max(0, this.connections - 1); });
    };
    server.on('connection', onConnection);
    this.detach.push(() => server.off('connection', onConnection));
  }
  async launchPersistentContext(...args: Parameters<typeof chromium.launchPersistentContext>) {
    return this.track(await chromium.launchPersistentContext(...args), 'persistent');
  }
  track(context: BrowserContext, kind: 'default' | 'persistent' | 'explicit' = 'explicit') {
    if (!this.enabled || this.contexts.has(context)) return context;
    if (this.contextId === limits.contexts) { this.problem('context_limit'); return context; }
    this.contexts.add(context);
    const contextId = ++this.contextId;
    this.browserVersion = version(context.browser()?.version() ?? 'unknown');
    this.event({ context: contextId, detail: kind });
    const onPage = (page: Page) => this.trackPage(page, contextId);
    const onRequest = (request: Request) => {
      let state: PageState | undefined;
      try { state = this.pages.get(request.frame().page()); } catch { /* Service worker/closed frame. */ }
      const event: Event = { ms: this.now(), kind: 'request', context: contextId, page: state?.page ?? 0,
        navigation: state?.navigation ?? 0, request: this.requestId = count(this.requestId + 1),
        route: String(routeTemplate(request.url(), this.origin)), method: ['GET', 'POST'].includes(request.method()) ? request.method() : 'other',
        status: 0, detail: 'none' };
      this.requests.set(request, event);
      if (this.pending.size < limits.pending) this.pending.set(event.request, event);
      else this.problem('pending_limit');
      this.event(event);
    };
    const onResponse = (response: import('@playwright/test').Response) => {
      const event = this.requests.get(response.request());
      if (event) this.event({ ...event, ms: this.now(), kind: 'response', status: response.status() });
    };
    const finish = (request: Request, failed: boolean) => {
      const event = this.requests.get(request);
      if (!event) return;
      const code = failed ? request.failure()?.errorText : '';
      const detail = code === 'net::ERR_NETWORK_CHANGED' ? 'network_changed'
        : code === 'net::ERR_CONNECTION_FAILED' || code === 'net::ERR_CONNECTION_REFUSED' ? 'connection_failed'
        : code === 'net::ERR_ABORTED' ? 'aborted' : code === 'net::ERR_TIMED_OUT' ? 'timed_out'
        : failed ? 'other_transport' : 'none';
      this.event({ ...event, ms: this.now(), kind: failed ? 'request_failed' : 'request_finished', detail });
      this.pending.delete(event.request);
    };
    const onFinished = (request: Request) => finish(request, false), onFailed = (request: Request) => finish(request, true);
    const restoreRequests: (() => void)[] = [];
    // Existing setup helpers use context.request as well as page fetch. These
    // requests have page=0; observe only method/template/status, never options.
    for (const method of ['get', 'post'] as const) {
      const original = context.request[method].bind(context.request);
      context.request[method] = async (url, options) => {
        const event: Event = { ms: this.now(), kind: 'request', context: contextId, page: 0, navigation: 0,
          request: this.requestId = count(this.requestId + 1), route: String(routeTemplate(url, this.origin)),
          method: method.toUpperCase(), status: 0, detail: 'none' };
        this.event(event);
        if (this.pending.size < limits.pending) this.pending.set(event.request, event); else this.problem('pending_limit');
        try {
          const response = await original(url, options);
          this.event({ ...event, ms: this.now(), kind: 'response', status: response.status() });
          this.event({ ...event, ms: this.now(), kind: 'request_finished' });
          return response;
        } catch (error) {
          this.event({ ...event, ms: this.now(), kind: 'request_failed', detail: 'other_transport' });
          throw error;
        } finally { this.pending.delete(event.request); }
      };
      restoreRequests.push(() => { context.request[method] = original; });
    }
    context.on('page', onPage).on('request', onRequest).on('response', onResponse)
      .on('requestfinished', onFinished).on('requestfailed', onFailed);
    const remove = () => {
      context.off('page', onPage).off('request', onRequest).off('response', onResponse)
        .off('requestfinished', onFinished).off('requestfailed', onFailed);
      this.contexts.delete(context);
      for (const restore of restoreRequests) restore();
    };
    this.detach.push(remove);
    for (const page of context.pages()) onPage(page);
    const close = context.close.bind(context);
    let closed = false;
    context.close = async options => {
      if (closed) return close(options);
      // Explicit/persistent closes can precede Playwright's failure notification.
      // Snapshot unconditionally, before closing, without changing close errors.
      await Promise.all(context.pages().map(page => this.snapshot(page)));
      this.phase('context_closing');
      try { await close(options); closed = true; this.phase('context_closed'); } finally { remove(); }
    };
    return context;
  }
  private trackPage(page: Page, contextId: number) {
    if (this.pages.has(page)) return;
    if (this.pageId === limits.pages) { this.problem('page_limit'); return; }
    const state = { context: contextId, page: ++this.pageId, navigation: 0 };
    this.pages.set(page, state);
    const pageEvent = (kind: string, detail = 'none') => this.event({ ...state, kind, detail, route: String(routeTemplate(page.url(), this.origin)) });
    const navigate = (frame: import('@playwright/test').Frame) => {
      if (frame !== page.mainFrame()) return;
      state.navigation = count(state.navigation + 1); pageEvent('navigation');
    };
    const dom = () => pageEvent('page', 'dom_ready'), load = () => pageEvent('page', 'load');
    const exception = () => pageEvent('exception', 'browser_exception');
    const consoleError = (message: import('@playwright/test').ConsoleMessage) => {
      if (message.type() === 'error') pageEvent('console', 'console_error');
    };
    const remove = () => {
      page.off('framenavigated', navigate).off('domcontentloaded', dom).off('load', load)
        .off('pageerror', exception).off('console', consoleError);
      this.pages.delete(page);
    };
    page.on('framenavigated', navigate).on('domcontentloaded', dom).on('load', load).on('pageerror', exception).on('console', consoleError);
    page.once('close', () => {
      if (!this.snapshots.has(state.page)) this.problem('page_closed_before_capture');
      pageEvent('page', 'closed'); remove();
    });
    this.detach.push(remove);
    const close = page.close.bind(page);
    page.close = async options => { await this.snapshot(page); return close(options); };
    pageEvent('page');
  }
  async snapshot(page: Page) {
    const state = this.pages.get(page);
    if (!state) return;
    for (const [id, event] of this.pending) {
      if (this.pendingAtCapture.size < limits.pending) this.pendingAtCapture.set(id, event);
      else this.problem('pending_limit');
    }
    let session: import('@playwright/test').CDPSession | undefined, timer: NodeJS.Timeout | undefined;
    const snapshot: Snapshot = { ...noView, ...state, ms: this.now(), route: String(routeTemplate(page.url(), this.origin)), state: 'closed' };
    if (!page.isClosed()) {
      try {
        // Runtime.evaluate has a Chromium execution deadline as well as the host
        // deadline. No polling, request routing, storage access or retained handle.
        const work = async () => {
          session = await page.context().newCDPSession(page);
          return session.send('Runtime.evaluate', { expression: `(${selectedView.toString()})(${JSON.stringify(controlLabels)},${JSON.stringify(controlNames)})`,
            returnByValue: true, timeout: 200, awaitPromise: false });
        };
        const result = await Promise.race([work(), new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 400); })]);
        if (!result) { snapshot.state = 'timed_out'; this.problem('capture_timed_out'); }
        else if (result.exceptionDetails || !result.result.value) { snapshot.state = 'failed'; this.problem('capture_failed'); }
        else {
          const candidate = { ...snapshot, ...result.result.value, state: 'captured' };
          // Check browser-supplied data before retaining it even in staging.
          if (!validCapture({ ...this.document(), pages: [candidate] })) { snapshot.state = 'failed'; this.problem('capture_invalid'); }
          else Object.assign(snapshot, candidate);
        }
      } catch { snapshot.state = 'failed'; this.problem('capture_failed'); }
      finally {
        clearTimeout(timer);
        // Detach without waiting on a dead transport. Closing the owned context
        // remains the caller's responsibility and is never postponed by diagnostics.
        void session?.detach().catch(() => {});
      }
    }
    this.snapshots.set(state.page, snapshot);
    this.checkpoint();
  }
  private document() {
    return { schema: 'loom-browser-capture-1', test: this.identity, complete: this.complete && this.problems.size === 0 && !this.serverActive && !this.contexts.size && !this.connections,
      chromium: this.browserVersion, issues: [...this.problems], events: this.events, events_dropped: this.dropped,
      pages: [...this.snapshots.values()], pending: [...this.pendingAtCapture.values()], connections: this.connections };
  }
  private checkpoint() {
    if (!this.enabled) return;
    try { writeChecked(join(root, 'capture', captureName(this.identity)), this.document(), validCapture); }
    catch { this.problem('checkpoint_failed'); }
  }
  finish() {
    this.event({ detail: 'collector_finished' });
    this.complete = true;
    this.checkpoint();
    for (const detach of this.detach) detach();
    this.pages.clear(); this.contexts.clear(); this.pending.clear();
  }
}
