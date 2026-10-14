import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { randomUUID } from "node:crypto";
import { JSDOM } from "jsdom";
import { createMemoryRouter, type LoaderFunction, type RouteObject } from "react-router";
import { RouterProvider } from "react-router/dom";
import { applicationRoutes } from "../../src/web/routes.js";
import { loadServiceStatus, ServiceError } from "../../src/web/api.js";
import { runtime } from "../../src/contracts/v1.js";

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: "http://localhost/" });
for (const key of ["window", "document", "navigator", "HTMLElement", "MutationObserver"] as const) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
}
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { value: true, configurable: true, writable: true });
const { render, screen, fireEvent, cleanup, act } = await import("@testing-library/react");
afterEach(cleanup);

function routesWithLoader(loader: LoaderFunction): RouteObject[] {
  return applicationRoutes.map((route) => {
    if (route.index || !route.children) return route;
    return { ...route, children: route.children.map((child) => child.path === "status" ? { ...child, loader } : child) };
  });
}

test("initial data loading exposes a real pending state", async () => {
  let finish!: (value: typeof runtime) => void;
  const deferred = new Promise<typeof runtime>((resolve) => { finish = resolve; });
  const router = createMemoryRouter(routesWithLoader(async () => deferred), { initialEntries: ["/status"] });
  render(<RouterProvider router={router} />);
  assert.equal(screen.getByRole("status").textContent, "Checking the service…");
  await act(async () => { finish(runtime); });
  assert.ok(await screen.findByRole("heading", { name: "The service is ready" }));
  assert.ok(screen.getByText(/Participant access remains unavailable/));
  router.dispose();
});

test("navigation keeps the page visible while the status loader is pending", async () => {
  let finish!: (value: typeof runtime) => void;
  const deferred = new Promise<typeof runtime>((resolve) => { finish = resolve; });
  const router = createMemoryRouter(routesWithLoader(async () => deferred), { initialEntries: ["/"] });
  render(<RouterProvider router={router} />);
  await act(async () => { fireEvent.click(screen.getByRole("link", { name: "Service status" })); });
  assert.equal(screen.getByRole("status").textContent, "Checking the service…");
  assert.ok(screen.getByRole("heading", { name: "Shared knowledge. Lasting context." }));
  await act(async () => { finish(runtime); });
  assert.ok(await screen.findByRole("heading", { name: "The service is ready" }));
  router.dispose();
});

test("a failed data loader displays safe failure and can recover on retry", async () => {
  let attempts = 0;
  const id = randomUUID();
  const router = createMemoryRouter(routesWithLoader(async () => {
    attempts += 1;
    if (attempts === 1) throw new ServiceError("The service is unavailable right now. Please try again.", id);
    return runtime;
  }), { initialEntries: ["/status"] });
  render(<RouterProvider router={router} />);
  assert.ok(await screen.findByRole("heading", { name: "Unable to check the service" }));
  assert.match(screen.getByRole("alert").textContent ?? "", /unavailable/);
  assert.ok(screen.getByText(`Request reference: ${id}`));
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Try again" })); });
  assert.ok(await screen.findByRole("heading", { name: "The service is ready" }));
  assert.equal(attempts, 2);
  router.dispose();
});

test("unexpected loader exceptions are not displayed as private diagnostics", async () => {
  const router = createMemoryRouter(routesWithLoader(async () => { throw new Error("private-database-password"); }), { initialEntries: ["/status"] });
  render(<RouterProvider router={router} />);
  await screen.findByRole("alert");
  assert.ok(!document.body.textContent?.includes("private-database-password"));
  router.dispose();
});

test("browser API loading validates responses and preserves cancellation and safe errors", async (t) => {
  const request = new Request("http://localhost/status");
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (path: string) => {
    calls += 1;
    return new Response(JSON.stringify(path === "/api/v1/runtime" ? runtime : { status: "ready" }));
  });
  assert.deepEqual(await loadServiceStatus({ request }), runtime);
  assert.equal(calls, 2);
  t.mock.restoreAll();
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ ...runtime, audience: "private" })));
  await assert.rejects(loadServiceStatus({ request }), /unexpected response/);
  t.mock.restoreAll();
  const id = randomUUID();
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ error: { code: "service_unavailable", message: "private-diagnostics", request_id: id } }), { status: 503 }));
  await assert.rejects(loadServiceStatus({ request }), (error: unknown) => error instanceof ServiceError && error.requestId === id && !error.message.includes("private"));
  t.mock.restoreAll();
  const controller = new AbortController();
  controller.abort();
  const abort = new DOMException("Aborted", "AbortError");
  t.mock.method(globalThis, "fetch", async () => { throw abort; });
  await assert.rejects(loadServiceStatus({ request: new Request("http://localhost/status", { signal: controller.signal }) }), { name: "AbortError" });
});
