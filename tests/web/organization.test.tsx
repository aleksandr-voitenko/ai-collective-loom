import assert from "node:assert/strict";
import { afterEach, test, type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { JSDOM } from "jsdom";
import { StrictMode } from "react";
import { createMemoryRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
import { OrganizationPage } from "../../src/web/Organization.js";
import { IntentStore, invalidateIdentity } from "../../src/web/participation-client.js";
import type { Context } from "../../src/web/participation-state.js";
import type { OrganizationResourceView, OrganizationResult } from "../../src/contracts/organization.js";
import { contractVersion, guideRevision, limits } from "../../src/contracts/participation.js";

const locks = navigator.locks;
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://loom.example/" });
for (const key of ["window", "document", "navigator", "HTMLElement", "MutationObserver", "location", "localStorage"] as const) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
}
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { value: true, configurable: true, writable: true });
const { render, screen, fireEvent, cleanup, act, waitFor } = await import("@testing-library/react");
afterEach(() => { cleanup(); localStorage.clear(); });

function form(t: TestContext) {
  const participant = randomUUID(), instance = randomUUID();
  const resource: OrganizationResourceView = {
    resource_id: randomUUID(), kind: "area", parent_id: null, version: 1, hierarchy_version: 1,
    title: "Original topic", description: "Original scope", metadata_version: 1,
    local_open: true, publication_open: true, can_organize: true, ancestors: [],
    contacts_url: "/api/v1/contacts", proposal_route_url: "/api/v1/areas/proposal-route",
  };
  const context: Context = {
    self: { participant_id: participant, credential_id: randomUUID(), nickname: "administrator", kind: "human", role: "administrator" },
    community: {
      instance_id: instance, contract_version: contractVersion, guide_revision: guideRevision,
      profile: "synthetic", community_name: "Synthetic community", settings_version: 1,
      overview: { state: "setup_incomplete" }, proposal_area: { state: "setup_incomplete" }, contacts: [],
      contacts_url: "/api/v1/contacts", guide_url: "/api/v1/guide", openapi_url: "/api/v1/openapi.json", limits,
      replay_retention: "retained_without_automatic_expiry; destructive_restore_unsupported", derived_effects: "disabled",
    },
    store: new IntentStore(instance, participant, localStorage, location.origin, locks),
    refreshCommunity: () => {},
  };
  let finish!: (response: Response) => void;
  const response = new Promise<Response>(resolve => { finish = resolve; });
  const requests: Record<string, unknown>[] = [];
  t.mock.method(globalThis, "fetch", async (path: string, options?: RequestInit) => {
    if (options?.method === "POST") {
      assert.equal(path, "/api/v1/organization/changes");
      requests.push(JSON.parse(String(options.body)));
      return response;
    }
    assert.equal(path, "/api/v1/organization/resources/" + resource.resource_id);
    return Response.json(resource);
  });
  const router = createMemoryRouter([
    { path: "/loom/organize", element: <OrganizationPage context={context} /> },
    { path: "/elsewhere", element: <h1>Another view</h1> },
  ], { initialEntries: ["/loom/organize?action=area.edit&target=" + resource.resource_id] });
  t.after(() => router.dispose());
  render(<StrictMode><RouterProvider router={router} /></StrictMode>);
  const committed: OrganizationResult = {
    operation_state: "committed", operation_id: randomUUID(), kind: "area.edit", idempotency: "created",
    outcome: { resource_id: resource.resource_id, parent_id: null, version: 2, hierarchy_version: 2, local_open: true },
    current: { ...resource, version: 2, hierarchy_version: 2, metadata_version: 2 },
  };
  return { context, router, requests, finish, committed };
}

async function submit(requests: Record<string, unknown>[]) {
  await screen.findByLabelText("Topic title");
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save topic" })); });
  await waitFor(() => assert.equal(requests.length, 1));
  assert.ok(screen.getByText("Waiting for confirmation…"));
}

test("StrictMode organization success leaves the busy state and shows the confirmed result", async t => {
  const { context, requests, finish, committed } = form(t);
  await submit(requests);
  await act(async () => { finish(Response.json(committed)); });
  await waitFor(() => assert.ok(!screen.queryByText("Waiting for confirmation…"), "The completed request must leave the busy state"));
  assert.ok(screen.getByText("Organization change confirmed."));
  assert.ok(screen.getByRole("link", { name: "View current location" }));
  assert.equal(context.store.all()[0]?.state, "committed");
});

test("StrictMode organization rejection leaves the busy state and permits explicit correction", async t => {
  const { context, requests, finish } = form(t);
  await submit(requests);
  await act(async () => { finish(Response.json({ error: { code: "organization_conflict", message: "Organization changed. Review the latest version." } }, { status: 409 })); });
  await waitFor(() => assert.ok(!screen.queryByText("Waiting for confirmation…"), "The completed request must leave the busy state"));
  assert.match(screen.getByRole("alert").textContent ?? "", /Organization changed/);
  assert.equal((screen.getByRole("button", { name: "Review latest organization and prepare correction" }) as HTMLButtonElement).disabled, false);
  assert.equal(context.store.all()[0]?.state, "rejected");
});

test("StrictMode organization completion after unmount settles only the retained intent", async t => {
  const { context, router, requests, finish, committed } = form(t);
  await submit(requests);
  await act(async () => { await router.navigate("/elsewhere"); });
  await act(async () => { finish(Response.json(committed)); });
  await waitFor(() => assert.equal(context.store.all()[0]?.state, "committed"));
  assert.ok(screen.getByRole("heading", { name: "Another view" }));
  assert.ok(!screen.queryByText("Organization change confirmed."));
});

test("StrictMode organization completion cannot update a different identity", async t => {
  const { context, requests, finish, committed } = form(t);
  await submit(requests);
  const retained = context.store.all();
  // Keep this view mounted to exercise generation ownership independently of cleanup.
  t.mock.method(window, "dispatchEvent", () => true);
  const other = new IntentStore(context.community.instance_id, randomUUID(), localStorage, location.origin, locks);
  await act(async () => { invalidateIdentity(); finish(Response.json(committed)); });
  assert.deepEqual(context.store.all(), retained);
  assert.deepEqual(other.all(), []);
  assert.ok(!screen.queryByText("Organization change confirmed."));
  assert.ok(!screen.queryByRole("alert"));
});
