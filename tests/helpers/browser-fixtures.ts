import { test as base, expect } from '@playwright/test';
import { BrowserDiagnostics } from './browser-diagnostics.js';
import { syntheticServer } from './participation-server.js';

export const diagnosticTest = base.extend<{ diagnostics: BrowserDiagnostics }>({
  diagnostics: [async ({}, use, info) => {
    const diagnostics = new BrowserDiagnostics(info);
    try { await use(diagnostics); } finally { diagnostics.finish(); }
  }, { auto: true }],
  context: async ({ context, diagnostics }, use) => {
    diagnostics.track(context, 'default');
    try { await use(context); } finally { await context.close(); }
  },
});

export const test = diagnosticTest.extend<{ server: Awaited<ReturnType<typeof syntheticServer>> }>({
  context: async ({ context, server: _server }, use) => {
    // Preserve LC-20261014-WZF5: browser-owned speculative TLS sockets must
    // disappear before graceful HTTPS/server/database teardown begins.
    try { await use(context); } finally { await context.close(); }
  },
  server: async ({ diagnostics }, use) => {
    diagnostics.phase('server_starting');
    const server = await syntheticServer();
    diagnostics.setOrigin(server.origin);
    diagnostics.observeServer(server.app.server);
    diagnostics.phase('server_ready');
    try { await use(server); } finally {
      diagnostics.phase('server_closing');
      await server.close();
      diagnostics.phase('server_closed');
    }
  },
});
export { expect };
