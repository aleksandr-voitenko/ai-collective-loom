import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { BrowserContext, Page, TestInfo, CDPSession } from '@playwright/test';

// Coverage counters are separate from the approved browser-diagnostics schema.
// Persist no origins, request data, script text, function names or anonymous scripts.
function loadAssets(assetsRoot: string) { return new Map(readdirSync(assetsRoot).filter(name => name.endsWith('.js')).map(name => {
  const source = readFileSync(join(assetsRoot, name), 'utf8');
  return ['/assets/' + name, { name, source, hash: createHash('sha256').update(source).digest('hex') }] as const;
})); }
type Entry = { asset: string; sha256: string; functions: { functionName: string; isBlockCoverage: boolean; ranges: { startOffset: number; endOffset: number; count: number }[] }[] };
type State = { ready: Promise<void>; active: boolean; closed: boolean; captures: number; entries: Entry[]; kind: string; session?: CDPSession; scripts: Map<string, string> };

export class BrowserCoverage {
  private pages = new Map<Page, State>();
  private contexts = new Set<BrowserContext>();
  private issues = new Set<string>();
  private id: string;
  private assets: ReturnType<typeof loadAssets>;
  private output: string;
  constructor(info: TestInfo, options: { output: string; assetsRoot?: string }) {
    this.id = createHash('sha256').update(info.testId).digest('hex') + '-' + info.repeatEachIndex + '-' + info.retry;
    this.output = options.output;
    this.assets = loadAssets(options.assetsRoot ?? resolve('dist/web/assets'));
  }

  track(context: BrowserContext, kind = 'explicit') {
    if (this.contexts.has(context)) return context;
    this.contexts.add(context);
    const newPage = context.newPage.bind(context);
    context.newPage = async () => { const page = await newPage(); await this.start(page, kind); return page; };
    context.on('page', page => { void this.start(page, kind).catch(() => this.issues.add('start_failed')); });
    for (const page of context.pages()) void this.start(page, kind).catch(() => this.issues.add('start_failed'));
    const close = context.close.bind(context);
    context.close = async options => {
      try { for (const page of context.pages()) await this.captureBeforeClose(page); }
      finally { await close(options); }
    };
    return context;
  }

  private start(page: Page, kind: string): Promise<void> {
    const existing = this.pages.get(page); if (existing) return existing.ready;
    const state: State = { ready: Promise.resolve(), active: false, closed: false, captures: 0, entries: [], kind, scripts: new Map() };
    this.pages.set(page, state);
    state.ready = (async () => {
      const session = state.session = await page.context().newCDPSession(page);
      session.on('Debugger.scriptParsed', event => {
        let pathname: string;
        try { pathname = new URL(event.url).pathname; } catch { return; }
        const asset = this.assets.get(pathname); if (!asset) return;
        // Navigation may retire this script before getScriptSource can return.
        // Bind counters synchronously to Chromium's parsed-source SHA-256 and
        // exact UTF-16 range, never just its URL or a later network response.
        if (event.hash !== asset.hash || event.length !== asset.source.length || event.startLine !== 0 || event.startColumn !== 0) {
          this.issues.add('different_script_source'); return;
        }
        state.scripts.set(event.scriptId, pathname);
      });
      await session.send('Debugger.enable');
      await session.send('Profiler.enable');
      await session.send('Profiler.startPreciseCoverage', { callCount: true, detailed: true });
      state.active = true;
    })();
    page.on('close', () => { state.closed = true; if (state.active) this.issues.add('closed_before_capture'); });
    const close = page.close.bind(page);
    page.close = async options => { try { await this.captureBeforeClose(page); } finally { await close(options); } };
    // Explicit navigation methods are the full-document transitions in this suite.
    // The profiler stays enabled; sampling resets counters without a debugger restart.
    for (const method of ['goto', 'reload', 'goBack', 'goForward'] as const) {
      const original = page[method].bind(page) as (...args: any[]) => Promise<any>;
      (page as any)[method] = async (...args: any[]) => {
        await this.flush(page, false);
        return original(...args);
      };
    }
    return state.ready;
  }

  async flush(page: Page, final = true) {
    const state = this.pages.get(page); if (!state) return;
    await state.ready;
    if (!state.active) return;
    assert.ok(!page.isClosed(), 'Coverage page closed before collection');
    const { result: entries } = await state.session!.send('Profiler.takePreciseCoverage');
    state.captures++;
    for (const entry of entries) {
      let pathname: string;
      try { pathname = new URL(entry.url).pathname; } catch { continue; }
      const asset = this.assets.get(pathname); if (!asset) continue;
      assert.equal(state.scripts.get(entry.scriptId), pathname, 'Browser script must match the measured build exactly');
      const functions = entry.functions.map(fn => ({ functionName: '', isBlockCoverage: fn.isBlockCoverage,
        ranges: fn.ranges.map(range => {
          assert.ok(Number.isSafeInteger(range.count) && range.count >= 0);
          assert.ok(Number.isSafeInteger(range.startOffset) && Number.isSafeInteger(range.endOffset));
          assert.ok(range.startOffset >= 0 && range.endOffset <= asset.source.length && range.endOffset >= range.startOffset);
          return { startOffset: range.startOffset, endOffset: range.endOffset, count: range.count };
        }) }));
      state.entries.push({ asset: asset.name, sha256: asset.hash, functions });
    }
    if (final) {
      await state.session!.send('Profiler.stopPreciseCoverage');
      await state.session!.detach();
      state.active = false;
    }
  }

  async finish() {
    for (const page of this.pages.keys()) if (!page.isClosed()) await this.captureBeforeClose(page);
    const pages = [...this.pages.values()];
    writeFileSync(join(this.output, this.id + '.json'), JSON.stringify({
      schema: 'loom-coverage-1', id: this.id, issues: [...this.issues],
      pages: pages.map(p => ({ kind: p.kind, captures: p.captures, closed: p.closed, entries: p.entries })),
    }));
    assert.equal(this.issues.size, 0, 'Every page must complete coverage collection');
    assert.ok(pages.every(p => !p.active && p.captures > 0));
  }

  async captureBeforeClose(page: Page) {
    // A failed measurement must fail the coverage run, but still allow the
    // existing page/context/native-browser owner to finish resource disposal.
    try { await this.flush(page); } catch { this.issues.add('capture_failed'); }
  }
}
