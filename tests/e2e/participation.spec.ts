import {
  test as base,
  expect,
  chromium,
  type Page,
  type BrowserContext,
  type CDPSession,
} from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect as connectTls } from "node:tls";
import { once } from "node:events";
import { syntheticServer } from "../helpers/participation-server.js";
import { httpClient } from "../helpers/participation-http.js";

const test = base.extend<{
  server: Awaited<ReturnType<typeof syntheticServer>>;
}>({
  context: async ({ context, server: _server }, use) => {
    // The explicit server dependency orders this cleanup first. A speculative
    // TLS connection can otherwise keep server.close() waiting on a live client.
    try {
      await use(context);
    } finally {
      await context.close();
    }
  },
  server: async ({}, use) => {
    const server = await syntheticServer();
    try {
      await use(server);
    } finally {
      await server.close();
    }
  },
});
const authenticators = new WeakMap<Page, { cdp: CDPSession; id: string }>();
async function authenticator(page: Page, context: BrowserContext) {
  const previous = authenticators.get(page);
  if (previous)
    await previous.cdp.send("WebAuthn.removeVirtualAuthenticator", {
      authenticatorId: previous.id,
    });
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const result = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  authenticators.set(page, { cdp, id: result.authenticatorId });
  return cdp;
}
async function enter(
  page: Page,
  context: BrowserContext,
  origin: string,
  ticket: string,
) {
  await authenticator(page, context);
  await page.goto(origin + "/loom");
  await page.getByText("Set up an admitted account", { exact: true }).click();
  await page.getByLabel("Enrollment ticket", { exact: true }).fill(ticket);
  await page
    .getByRole("button", { name: "Create passkey", exact: true })
    .click();
  await expect(
    page.getByText("Your passkey is ready. Sign in to continue."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Sign in with passkey" }).click();
  await expect(
    page.getByRole("heading", { name: "Topics", exact: true }),
  ).toBeVisible();
}
async function setup(page: Page) {
  await page.getByRole("link", { name: "Administration", exact: true }).click();
  await page
    .getByRole("button", { name: "Initialize community", exact: true })
    .click();
  await expect(
    page.getByText("Community configuration", { exact: true }),
  ).toBeVisible();
}
async function createDiscussion(
  page: Page,
  title = "Reading the actual context",
) {
  await page.getByRole("link", { name: "Topics", exact: true }).first().click();
  await page.getByRole("link").filter({ hasText: "General" }).first().click();
  await page.getByRole("button", { name: "Start a discussion" }).click();
  await page.getByLabel("Title", { exact: true }).fill(title);
  await page
    .getByLabel("Text", { exact: true })
    .fill("A **shared question** with `<script>` as ordinary text.");
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(
    page.getByText("Your publication is saved.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Inspect exact revision" }).click();
  const path = new URL(page.url()).pathname.split("/");
  const resource = path[3]!,
    revision = path[4]!;
  await page.getByRole("link", { name: "Conversation", exact: true }).click();
  return {
    resource,
    revision,
    discussion: new URL(page.url()).pathname.split("/")[3]!,
  };
}
async function api(page: Page, path: string, body?: unknown) {
  const self = await (
    await page.request.get(new URL("/api/v1/identity/self", page.url()).href)
  ).json();
  return body === undefined
    ? page.request.get(new URL(path, page.url()).href)
    : page.request.post(new URL(path, page.url()).href, {
        data: body,
        headers: {
          origin: new URL(page.url()).origin,
          "x-loom-csrf": self.csrf,
        },
      });
}
async function agent(
  page: Page,
  server: Awaited<ReturnType<typeof syntheticServer>>,
) {
  const account = await (
    await api(page, "/api/v1/identity/accounts", {
      idempotency_key: randomUUID(),
      nickname: "external_agent",
      kind: "agent",
      role: "participant",
    })
  ).json();
  const issued = await (
    await api(page, "/api/v1/identity/credentials", {
      idempotency_key: randomUUID(),
      participant_id: account.participant_id,
      kind: "agent",
      purpose: null,
      label: "Direct HTTP browser test",
      replace_credential_id: null,
    })
  ).json();
  return {
    id: account.participant_id,
    client: httpClient(
      server.origin,
      await readFile(server.directory + "/cert.pem", "utf8"),
      issued.secret,
    ),
  };
}
const text = (value: string) => ({
  format: "loom-markdown-v1",
  text: value,
  mentions: [],
});

test("browser-owned TLS preconnection closes before server teardown", async ({
  context,
  server,
}) => {
  // Hold a real TLS connection without sending HTTP, with the browser context's
  // lifetime. This deterministically models a speculative browser connection;
  // Node's HTTP idle-connection cleanup does not close this socket.
  const connection = connectTls({
    host: "127.0.0.1",
    port: Number(new URL(server.origin).port),
    servername: "localhost",
    ca: await readFile(server.directory + "/cert.pem", "utf8"),
  });
  context.once("close", () => connection.destroy());
  await once(connection, "secureConnect");
  expect(connection.authorized).toBe(true);
  // Successful fixture teardown is the assertion: server-first cleanup deadlocks
  // until this context closes.
});

test("administrator setup/admission, human discussion, direct HTTP agent, nesting, revisions and responsive reading", async ({
  page,
  context,
  server,
}, testInfo) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await enter(page, context, server.origin, server.ticket);
  await setup(page);
  await page.getByLabel("Nickname", { exact: true }).fill("lyra");
  await page
    .getByRole("button", { name: "Create account", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Issue agent credential", exact: true })
    .click();
  const secret = await page.getByLabel("Issued secret").inputValue();
  expect(secret).toBeTruthy();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  const human = await (
    await api(page, "/api/v1/identity/accounts", {
      idempotency_key: randomUUID(),
      nickname: "maya",
      kind: "human",
      role: "participant",
    })
  ).json();
  const ticket = await (
    await api(page, "/api/v1/identity/credentials", {
      idempotency_key: randomUUID(),
      participant_id: human.participant_id,
      kind: "enrollment",
      purpose: "enroll",
      label: "Human browser",
      replace_credential_id: null,
    })
  ).json();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Sign in with passkey" }),
  ).toBeVisible();
  await enter(page, context, server.origin, ticket.secret);
  const discussion = await createDiscussion(page),
    client = httpClient(
      server.origin,
      await readFile(server.directory + "/cert.pem", "utf8"),
      secret,
    );
  const actual = await client.call("/api/v1/resources/" + discussion.resource);
  expect(actual.body.content.text).toContain("shared question");
  const reply = await client.call("/api/v1/replies", {
    idempotency_key: randomUUID(),
    discussion_id: discussion.discussion,
    parent_id: actual.body.resource_id,
    content: text("I retrieved the actual opening revision before answering."),
  });
  expect(reply.status).toBe(201);
  await page.reload();
  await expect(
    page.getByText("I retrieved the actual opening revision before answering."),
  ).toBeVisible();
  const agentPost = page.locator(
    `[data-resource-id="${reply.body.resource_id}"]`,
  );
  await agentPost.getByRole("button", { name: "Reply", exact: true }).click();
  await agentPost
    .getByLabel("Your reply", { exact: true })
    .fill("This reply belongs under Lyra.");
  await agentPost
    .getByRole("button", { name: "Post reply", exact: true })
    .click();
  await expect(
    page.getByText("Your reply was posted.", { exact: true }),
  ).toBeVisible();
  await expect(
    page
      .locator(".comment-tree .prose")
      .getByText("This reply belongs under Lyra.", { exact: true }),
  ).toBeVisible();
  const children = await client.call(
    `/api/v1/contributions/${reply.body.resource_id}/children`,
  );
  expect(children.body.items).toHaveLength(1);
  expect(children.body.items[0].parent_id).toBe(reply.body.resource_id);
  await agentPost
    .getByRole("button", { name: "Write another", exact: true })
    .click();
  await agentPost
    .getByLabel("Your reply", { exact: true })
    .fill("A second reply in the already open branch.");
  await agentPost
    .getByRole("button", { name: "Post reply", exact: true })
    .click();
  await expect(
    page
      .locator(".comment-tree .prose")
      .getByText("A second reply in the already open branch.", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("discussion-desktop.png"),
    fullPage: true,
  });
  await testInfo.attach("discussion desktop", {
    path: testInfo.outputPath("discussion-desktop.png"),
    contentType: "image/png",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("discussion-mobile.png"),
    fullPage: true,
  });
  await testInfo.attach("discussion mobile", {
    path: testInfo.outputPath("discussion-mobile.png"),
    contentType: "image/png",
  });
  await page.goto(
    server.origin +
      `/loom/resource/${discussion.resource}/${discussion.revision}?edit=1`,
  );
  await page
    .getByLabel("Text", { exact: true })
    .fill("My retained conflicting edit.");
  const competing = await api(page, "/api/v1/revisions", {
    idempotency_key: randomUUID(),
    resource_id: discussion.resource,
    expected_revision_id: discussion.revision,
    title: "Reading the actual context",
    content: text("A competing revision."),
  });
  expect(competing.status()).toBe(201);
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByText("Your draft is preserved.")).toBeVisible();
  await expect(page.getByLabel("Text", { exact: true })).toHaveValue(
    "My retained conflicting edit.",
  );
  await expect(
    page.getByText("A competing revision.", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Prepare corrected submission" })
    .click();
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(
    page.getByText("Your publication is saved.", { exact: true }),
  ).toBeVisible();
  const old = await client.call(
    `/api/v1/resources/${discussion.resource}/revisions/${discussion.revision}`,
  );
  expect(old.body.content.text).toContain("shared question");
  expect(pageErrors).toEqual([]);
});

test("a late committed publication cannot repopulate another identity or route after sign-out", async ({
  page,
  context,
  server,
}) => {
  await enter(page, context, server.origin, server.ticket);
  await setup(page);
  const d = await createDiscussion(page);
  const account = await (
    await api(page, "/api/v1/identity/accounts", {
      idempotency_key: randomUUID(),
      nickname: "new_owner",
      kind: "human",
      role: "participant",
    })
  ).json();
  const ticket = await (
    await api(page, "/api/v1/identity/credentials", {
      idempotency_key: randomUUID(),
      participant_id: account.participant_id,
      kind: "enrollment",
      purpose: "enroll",
      label: "Second identity",
      replace_credential_id: null,
    })
  ).json();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let key = "";
  await page.route("**/api/v1/replies", async (route) => {
    key = route.request().postDataJSON().idempotency_key;
    const records = await page.evaluate(() =>
      Object.entries(localStorage)
        .filter(([name]) => name.startsWith("loom.intent."))
        .map(([, value]) => JSON.parse(value)),
    );
    expect(
      records.some(
        (record) => record.key === key && record.state === "uncertain",
      ),
    ).toBe(true);
    const response = await route.fetch();
    expect(response.status()).toBe(201);
    started();
    await held;
    await route.fulfill({ response });
  });
  const opening = page.locator(`[data-resource-id="${d.resource}"]`);
  await opening.getByRole("button", { name: "Reply", exact: true }).click();
  await opening
    .getByLabel("Your reply")
    .fill("Late original-owner publication.");
  await opening.getByRole("button", { name: "Post reply" }).click();
  await ready;
  await page
    .getByRole("link", { name: "Artifacts", exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("heading", { name: "Artifacts", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Your reply was posted.", { exact: true }),
  ).not.toBeVisible();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page
    .getByRole("button", { name: "Clear local drafts and sign out" })
    .click();
  await expect(
    page.getByRole("button", { name: "Sign in with passkey" }),
  ).toBeVisible();
  await enter(page, context, server.origin, ticket.secret);
  release();
  await page.unrouteAll({ behavior: "wait" });
  await expect(page.locator(".sidebar .account strong")).toHaveText(
    "new_owner",
  );
  await expect(
    page.getByText("Your reply was posted.", { exact: true }),
  ).not.toBeVisible();
  expect(
    await page.evaluate(() =>
      Object.keys(localStorage).filter((key) => key.startsWith("loom.intent.")),
    ),
  ).toEqual([]);
  expect(
    (
      await server.observer.query(
        "SELECT count(*) FROM loom.idempotency_records WHERE idempotency_key=$1",
        [key],
      )
    ).rows[0].count,
  ).toBe("1");
});

test("lost committed response survives actual browser process restart and exact retry without duplication", async ({
  server,
}, testInfo) => {
  const directory = await mkdtemp(join(tmpdir(), "loom-browser-restart-"));
  let context = await chromium.launchPersistentContext(directory, {
    ignoreHTTPSErrors: true,
    headless: true,
    viewport: { width: 1440, height: 1000 },
  });
  try {
    let page = await context.newPage();
    await enter(page, context, server.origin, server.ticket);
    await setup(page);
    const d = await createDiscussion(page);
    const opening = page.locator(`[data-resource-id="${d.resource}"]`);
    await opening.getByRole("button", { name: "Reply", exact: true }).click();
    await opening
      .getByLabel("Your reply")
      .fill("Recover this exact reply after a crash.");
    let posted: Record<string, unknown> | undefined, completed!: () => void;
    const aborted = new Promise<void>((resolve) => {
      completed = resolve;
    });
    await page.route("**/api/v1/replies", async (route) => {
      posted = route.request().postDataJSON();
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      await route.abort("connectionfailed");
      completed();
    });
    await opening.getByRole("button", { name: "Post reply" }).click();
    await expect(
      page.getByText("We couldn’t confirm whether your reply was posted."),
    ).toBeVisible();
    await aborted;
    const original = posted!;
    expect(original.idempotency_key).toBeTruthy();
    await context.close();
    context = await chromium.launchPersistentContext(directory, {
      ignoreHTTPSErrors: true,
      headless: true,
      viewport: { width: 1440, height: 1000 },
    });
    page = await context.newPage();
    await page.goto(server.origin + "/loom/discussion/" + d.discussion);
    await expect(
      page.getByText("We couldn’t confirm whether your reply was posted."),
    ).toBeVisible();
    await expect(page.getByLabel("Your reply")).toHaveValue(
      "Recover this exact reply after a crash.",
    );
    let retry: unknown;
    page.on("request", (request) => {
      if (request.url().endsWith("/api/v1/replies"))
        retry = request.postDataJSON();
    });
    await page.getByRole("button", { name: "Retry same reply" }).click();
    await expect(
      page.getByText("Your reply was posted.", { exact: true }),
    ).toBeVisible();
    expect(retry).toEqual(original);
    const count = await server.observer.query(
      "SELECT count(*) FROM loom.idempotency_records WHERE operation_kind=$1 AND idempotency_key=$2",
      ["reply.create", original.idempotency_key],
    );
    expect(count.rows[0].count).toBe("1");
    await page.screenshot({
      path: testInfo.outputPath("recovered-reply.png"),
      fullPage: true,
    });
    await testInfo.attach("recovered reply", {
      path: testInfo.outputPath("recovered-reply.png"),
      contentType: "image/png",
    });
  } finally {
    await context.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("late reads preserve navigation/account ownership; older-page failure and revoked rights preserve draft", async ({
  page,
  context,
  server,
}) => {
  await enter(page, context, server.origin, server.ticket);
  await setup(page);
  const d = await createDiscussion(page),
    external = await agent(page, server);
  for (let i = 1; i <= 8; i++)
    expect(
      (
        await external.client.call("/api/v1/replies", {
          idempotency_key: randomUUID(),
          discussion_id: d.discussion,
          parent_id: d.resource,
          content: text("Bounded reply " + i),
        })
      ).status,
    ).toBe(201);
  await page.reload();
  await expect(
    page.getByText("Bounded reply 1", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Bounded reply 7", { exact: true }),
  ).not.toBeVisible();
  let failPage = true;
  await page.route("**/api/v1/contributions/*/children?*", async (route) => {
    if (failPage && new URL(route.request().url()).searchParams.has("cursor")) {
      failPage = false;
      await route.abort("connectionfailed");
    } else await route.continue();
  });
  await page.getByRole("button", { name: "Next replies" }).click();
  await expect(
    page.getByRole("button", { name: "Retry replies" }),
  ).toBeVisible();
  await expect(
    page.getByText("Bounded reply 1", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Retry replies" }).click();
  await expect(
    page.getByText("Bounded reply 7", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Bounded reply 1", { exact: true }),
  ).not.toBeVisible();
  await page.unrouteAll({ behavior: "wait" });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route("**/api/v1/resources/" + d.resource, async (route) => {
    const response = await route.fetch();
    started();
    await held;
    await route.fulfill({ response });
  });
  await page.goto(server.origin + "/loom/resource/" + d.resource);
  await ready;
  await page
    .getByRole("link", { name: "Artifacts", exact: true })
    .first()
    .click();
  release();
  await expect(
    page.getByRole("heading", { name: "Artifacts", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("A shared question", { exact: false }),
  ).not.toBeVisible();
  await page.unrouteAll({ behavior: "wait" });
  // A normal admitted human is enrolled with real browser WebAuthn, not a role header.
  const account = await (
    await api(page, "/api/v1/identity/accounts", {
      idempotency_key: randomUUID(),
      nickname: "second_human",
      kind: "human",
      role: "participant",
    })
  ).json();
  const ticket = await (
    await api(page, "/api/v1/identity/credentials", {
      idempotency_key: randomUUID(),
      participant_id: account.participant_id,
      kind: "enrollment",
      purpose: "enroll",
      label: "Second browser",
      replace_credential_id: null,
    })
  ).json();
  let releaseOld!: () => void;
  const holdOld = new Promise<void>((resolve) => {
    releaseOld = resolve;
  });
  let oldReady!: () => void;
  const oldStarted = new Promise<void>((resolve) => {
    oldReady = resolve;
  });
  await page.route("**/api/v1/resources/" + d.resource, async (route) => {
    const response = await route.fetch();
    oldReady();
    await holdOld;
    await route.fulfill({ response });
  });
  await page.goto(server.origin + "/loom/resource/" + d.resource);
  await oldStarted;
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  if (
    await page
      .getByRole("button", { name: "Clear local drafts and sign out" })
      .isVisible()
  )
    await page
      .getByRole("button", { name: "Clear local drafts and sign out" })
      .click();
  await expect(
    page.getByRole("button", { name: "Sign in with passkey" }),
  ).toBeVisible();
  releaseOld();
  await page.unrouteAll({ behavior: "wait" });
  // A fresh virtual authenticator ensures the browser selects the second identity.
  await enter(page, context, server.origin, ticket.secret);
  await expect(page.locator(".sidebar .account strong")).toHaveText(
    "second_human",
  );
  await page.goto(server.origin + "/loom/discussion/" + d.discussion);
  const opening = page.locator(`[data-resource-id="${d.resource}"]`);
  await opening.getByRole("button", { name: "Reply", exact: true }).click();
  await opening
    .getByLabel("Your reply")
    .fill("Preserve this draft when permission changes.");
  await server.observer.query(
    "UPDATE loom.resources SET publication_open=false WHERE id=$1",
    [d.discussion],
  );
  await opening.getByRole("button", { name: "Post reply" }).click();
  await expect(page.getByText("Your draft is preserved.")).toBeVisible();
  await expect(page.getByLabel("Your reply")).toHaveValue(
    "Preserve this draft when permission changes.",
  );
  const denied = await external.client.call("/api/v1/replies", {
    idempotency_key: randomUUID(),
    discussion_id: d.discussion,
    parent_id: d.resource,
    content: text("same denial"),
  });
  expect(denied.status).toBe(403);
  await expect(page.locator(".sidebar .account strong")).toHaveText(
    "second_human",
  );
});

test("overview uses ordinary artifact history/editors; text-artifact drafts survive navigation", async ({
  page,
  context,
  server,
}, testInfo) => {
  await enter(page, context, server.origin, server.ticket);
  await setup(page);
  await page
    .getByRole("link", { name: /Research commons — Community overview/ })
    .first()
    .click();
  await expect(
    page.getByRole("heading", { name: "Community overview", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Welcome to our shared workspace.", { exact: true }),
  ).toBeVisible();
  await page.getByText("Editors", { exact: true }).click();
  await page.getByRole("button", { name: "Manage editors" }).click();
  await expect(
    page.getByRole("checkbox", { name: "synthetic_admin" }),
  ).toBeChecked();
  await page.getByRole("button", { name: "Save editor list" }).click();
  await page.getByRole("button", { name: "Revision history" }).click();
  await expect(
    page.getByRole("link").filter({ hasText: "Revision 1" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Topics", exact: true }).first().click();
  await page.getByRole("link").filter({ hasText: "General" }).first().click();
  await page.getByRole("button", { name: "Artifacts", exact: true }).click();
  await page.getByRole("button", { name: "New text artifact" }).click();
  await page
    .getByLabel("Title", { exact: true })
    .fill("A retained working note");
  await page
    .getByLabel("Text", { exact: true })
    .fill("Keep this unsent draft through navigation.");
  await page
    .getByRole("link", { name: "Participation guide", exact: true })
    .first()
    .click();
  await page
    .getByRole("link")
    .filter({ hasText: "artifact.create · draft" })
    .click();
  await expect(page.getByLabel("Text", { exact: true })).toHaveValue(
    "Keep this unsent draft through navigation.",
  );
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(
    page.getByText("Your publication is saved.", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("link", { name: "Artifacts", exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("link").filter({ hasText: "A retained working note" }),
  ).toContainText("General");
  await page.screenshot({
    path: testInfo.outputPath("artifacts-desktop.png"),
    fullPage: true,
  });
  await testInfo.attach("artifacts desktop", {
    path: testInfo.outputPath("artifacts-desktop.png"),
    contentType: "image/png",
  });
  await page.getByRole("link", { name: "Topics", exact: true }).first().click();
  await page.getByRole("link").filter({ hasText: "General" }).first().click();
  await page.getByText("About this topic", { exact: true }).click();
  await page
    .getByRole("button", { name: "Suggest an organizational change" })
    .click();
  await page
    .getByLabel("Title", { exact: true })
    .fill("Propose a reading topic");
  await page
    .getByLabel("Text", { exact: true })
    .fill("Preserve this proposal with its configured destination.");
  await page
    .getByRole("link", { name: "Participation guide", exact: true })
    .first()
    .click();
  await page
    .getByRole("link")
    .filter({ hasText: "discussion.create · draft" })
    .click();
  await expect(page.getByLabel("Text", { exact: true })).toHaveValue(
    "Preserve this proposal with its configured destination.",
  );
});
