// Intentionally failing children: the verifier harness and the opt-in hosted
// failure-upload check run these separately from the application suite.
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diagnosticTest, expect } from '../helpers/browser-fixtures.js';

export const canary = 'LOOM_DIAGNOSTIC_SECRET_CANARY_7jQv39';
const test = diagnosticTest.extend<{ probe: string }>({
  context: async ({ context, probe: _probe }, use) => { try { await use(context); } finally { await context.close(); } },
  probe: async ({ diagnostics }, use, info) => {
    diagnostics.phase('server_starting');
    const server = createServer((request, response) => {
      if (request.url?.startsWith('/api/v1/areas')) return; // pending until browser closes
      if (request.url?.startsWith('/api/v1/identity/self')) {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ secret: canary })); return;
      }
      response.writeHead(200, { 'content-type': 'text/html', 'set-cookie': `session=${canary}; SameSite=Lax`, 'x-secret': canary });
      response.end(`<main class="loom-app"><div class="account"></div><h1>Probe ${canary}</h1>
        <label>Issued secret<input aria-label="Issued secret" readonly value="${canary}"></label>
        <label>Note text<textarea>${canary}</textarea></label><label>Search private notes<input value="${canary}"></label>
        <button aria-label="Sign out">Sign out</button><p role="alert">${canary}</p>
        <script>localStorage.setItem('credential', '${canary}'); sessionStorage.setItem('ticket', '${canary}'); console.error('${canary}');</script></main>`);
    });
    diagnostics.observeServer(server);
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    diagnostics.setOrigin(origin); diagnostics.phase('server_ready');
    try { await use(origin); } finally {
      diagnostics.phase('server_closing');
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      if (info.title === 'teardown failure') throw new Error(canary);
      diagnostics.phase('server_closed');
    }
  },
});

test('missing control ' + canary, async ({ page, context, probe }, info) => {
  await page.goto(probe + '/loom?ticket=' + canary + '#' + canary);
  await page.request.get(probe + '/api/v1/identity/self?secret=' + canary, { headers: { authorization: 'Bearer ' + canary } });
  const other = await context.newPage();
  await other.goto(probe + '/loom/discussion/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa?secret=' + canary);
  await other.evaluate(async value => {
    await fetch('/api/v1/identity/self?challenge=' + value, { headers: { authorization: 'Bearer ' + value, 'x-loom-csrf': value } });
    await fetch('/api/v1/me/notes/query', {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({query:value})});
    localStorage.setItem('private-note-draft', JSON.stringify({title:value,body:value,links:[value]}));
    void fetch('/api/v1/areas?ticket=' + value);
  }, canary);
  await info.attach(canary, { body: Buffer.from(canary), contentType: 'text/plain' });
  try { await expect(other.getByRole('button', { name: 'Save discussion', exact: true })).toBeEnabled(); }
  finally { await other.close(); }
});

test('navigation failure', async ({ page, probe }) => {
  await page.route('**/loom?*', route => route.abort('connectionfailed'));
  await page.goto(probe + '/loom?credential=' + canary);
});

test('browser exception and one-time secret', async ({ page, probe }) => {
  await page.goto(probe + '/loom/admin');
  expect(await page.getByLabel('Issued secret').inputValue() === canary).toBe(true);
  const exception = page.waitForEvent('pageerror');
  await page.evaluate(value => { setTimeout(() => { throw new Error(value); }, 0); }, canary);
  await exception;
  throw new Error(canary);
});

test('capture failure', async ({ page, probe }) => {
  await page.goto(probe + '/loom');
  await page.evaluate(value => { document.querySelectorAll = () => { throw new Error(value); }; }, canary);
  throw new Error(canary);
});

test('bounded events', async ({ page, probe }) => {
  await page.goto(probe + '/loom');
  await page.evaluate(async value => {
    for (let i = 0; i < 160; i++) await fetch('/api/v1/identity/self?secret=' + value);
  }, canary);
  throw new Error(canary);
});

test('persistent context failure', async ({ diagnostics, probe }) => {
  const directory = await mkdtemp(join(tmpdir(), 'loom-diagnostic-browser-'));
  const context = await diagnostics.launchPersistentContext(directory, { headless: true });
  try {
    const page = await context.newPage(); await page.goto(probe + '/loom/saved');
    await expect(page.getByRole('button', { name: 'Save discussion', exact: true })).toBeEnabled();
  } finally { await context.close(); await rm(directory, { recursive: true, force: true }); }
});

test('teardown failure', async ({ page, probe }) => {
  await page.goto(probe + '/loom');
});

test('unexpected browser closure', async ({ browser, diagnostics, probe }) => {
  const context = diagnostics.track(await browser.newContext());
  const page = await context.newPage();
  await page.goto(probe + '/loom');
  // Bypass owned close deliberately to model an unavailable pre-close snapshot.
  await browser.close();
  throw new Error(canary);
});
