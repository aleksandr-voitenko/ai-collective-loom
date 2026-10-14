import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import {
  IntentStore,
  invalidateIdentity,
  request,
} from "../../src/web/participation-client.js";

test("recovery storage survives a new client object and separates participant, instance and origin", async () => {
  const storage = new JSDOM("", { url: "https://loom.example" }).window
    .localStorage;
  const a = new IntentStore(
    "instance",
    "alice",
    storage,
    "https://loom.example",
  );
  let intent = a.create("reply:parent", "reply.create", "/api/v1/replies", {
    parent_id: "parent",
    content: {
      format: "loom-markdown-v1",
      text: "Exact\r\ntext",
      mentions: [],
    },
  });
  intent.state = "uncertain";
  intent = await a.save(intent);
  assert.deepEqual(
    new IntentStore("instance", "alice", storage, "https://loom.example").all(),
    [intent],
  );
  for (const [instance, participant, origin] of [
    ["other", "alice", "https://loom.example"],
    ["instance", "bob", "https://loom.example"],
    ["instance", "alice", "https://different.example"],
  ])
    assert.deepEqual(
      new IntentStore(instance!, participant!, storage, origin!).all(),
      [],
    );
  const bob = new IntentStore(
    "instance",
    "bob",
    storage,
    "https://loom.example",
  );
  await assert.rejects(bob.save(intent), /different account/);
  await bob.clear();
  assert.deepEqual(a.all(), [intent]);
});
test("full or unreadable recovery storage refuses writes without evicting unresolved intent", async () => {
  const storage = new JSDOM("", { url: "https://loom.example" }).window
      .localStorage,
    a = new IntentStore("instance", "alice", storage, "https://loom.example");
  for (let i = 0; i < 32; i++) {
    let intent = a.create("reply:" + i, "reply.create", "/api/v1/replies", {
      text: "recover",
    });
    intent.state = "uncertain";
    intent = await a.save(intent);
  }
  const before = a.all();
  await assert.rejects(
    a.save(a.create("next", "reply.create", "/api/v1/replies", {})),
    /full/,
  );
  assert.deepEqual(a.all(), before);
  storage.setItem(a.prefix + "broken", "{");
  assert.throws(() => a.all(), /unreadable/);
});
test("even an uncancellable successful HTTP response is discarded after identity changes", async (t) => {
  Object.defineProperty(globalThis, "window", {
    value: { dispatchEvent: () => true },
    configurable: true,
  });
  let release!: (response: Response) => void;
  const held = new Promise<Response>((resolve) => {
    release = resolve;
  });
  t.mock.method(globalThis, "fetch", () => held);
  const pending = request("/api/v1/resources/example");
  invalidateIdentity();
  release(new Response(JSON.stringify({ private: "old owner result" })));
  await assert.rejects(pending, { name: "AbortError" });
});

test("only definitive first-dispatch rejection permits a corrected identity", async () => {
  const { ApiError, isDefinitiveRejection } = await import(
    "../../src/web/participation-client.js"
  );
  for (const code of [
    "invalid_input",
    "invalid_request",
    "revision_conflict",
    "nickname_conflict",
    "credential_limit",
    "forbidden",
  ]) {
    assert.equal(
      isDefinitiveRejection(new ApiError(code, "rejected"), false),
      true,
    );
    assert.equal(
      isDefinitiveRejection(new ApiError(code, "rejected"), true),
      false,
    );
    assert.equal(
      isDefinitiveRejection(
        new ApiError(code, "unknown", undefined, "unknown"),
        false,
      ),
      false,
    );
  }
  for (const code of [
    "idempotency_conflict",
    "service_unavailable",
    "retryable",
    "unknown",
  ])
    assert.equal(
      isDefinitiveRejection(new ApiError(code, "uncertain"), false),
      false,
    );
  assert.equal(isDefinitiveRejection(new Error("timeout"), false), false);
  const storage = new JSDOM("", { url: "https://loom.example" }).window
    .localStorage;
  const store = new IntentStore(
    "instance",
    "alice",
    storage,
    "https://loom.example",
  );
  let intent = store.create(
    "setup",
    "community.setup",
    "/api/v1/community/setup",
    { community_name: "" },
  );
  intent.state = "uncertain";
  intent = await store.save(intent);
  await assert.rejects(store.correct(intent), /definitively rejected/);
  assert.deepEqual(store.all(), [intent]);
  intent.state = "rejected";
  intent = await store.save(intent);
  const before = store.all();
  await assert.rejects(
    store.correct({ ...intent, participant_id: "bob" }),
    /different account/,
  );
  assert.deepEqual(store.all(), before);
  const next = await store.correct(intent);
  assert.notEqual(next.key, intent.key);
  assert.equal(next.state, "draft");
  assert.deepEqual(next.body, { ...intent.body, idempotency_key: next.key });
  assert.deepEqual(store.all(), [next]);
});

test("failed correction storage keeps the original rejected attempt", async () => {
  const storage = new JSDOM("", { url: "https://loom.example" }).window
    .localStorage;
  const store = new IntentStore(
    "instance",
    "alice",
    storage,
    "https://loom.example",
  );
  let intent = store.create("edit", "revision.publish", "/api/v1/revisions", {
    text: "Keep rejected text",
  });
  intent.state = "rejected";
  intent = await store.save(intent);
  for (let i = 1; i < 32; i++)
    await store.save(
      store.create("other" + i, "reply.create", "/api/v1/replies", {}),
    );
  const before = store.all();
  await assert.rejects(store.correct(intent), /full/);
  assert.deepEqual(store.all(), before);
});

test("journal versions fence stale dispatch, removal and late outcomes across clients", async () => {
  const storage = new JSDOM("", { url: "https://loom.example" }).window
    .localStorage;
  const a = new IntentStore(
    "instance",
    "alice",
    storage,
    "https://loom.example",
  );
  const b = new IntentStore(
    "instance",
    "alice",
    storage,
    "https://loom.example",
  );
  const draft = await a.save(
    a.create("reply", "reply.create", "/api/v1/replies", { text: "original" }),
  );
  const [sent, stale] = await Promise.allSettled([
    a.save({ ...draft, state: "uncertain" }),
    b.save({ ...draft, body: { ...draft.body, text: "changed" } }),
  ]);
  assert.equal(sent.status, "fulfilled");
  assert.equal(stale.status, "rejected");
  const dispatched = a.all()[0]!;
  await assert.rejects(b.remove(draft), /changed in another view/);
  await assert.rejects(
    b.save({ ...draft, state: "uncertain" }),
    /changed in another view/,
  );
  const separate = await b.saveDraft(draft, { ...draft.body, text: "unsent" });
  assert.equal(separate.blocked_by, draft.key);
  assert.notEqual(separate.key, draft.key);
  assert.equal(separate.body.text, "unsent");
  assert.deepEqual(
    a.all().find((r) => r.key === draft.key),
    dispatched,
  );
  await assert.rejects(
    b.save({ ...separate, state: "uncertain" }),
    /Review the separately saved/,
  );
  const retry = await b.save(dispatched);
  // The first request's refusal is no longer proof of failure after a retry.
  assert.deepEqual(await a.settle(dispatched, { state: "rejected" }), retry);
  const committed = await b.settle(retry, { state: "committed" });
  assert.deepEqual(
    await a.settle(dispatched, { state: "rejected" }),
    committed,
  );
  await a.clear();
  await assert.rejects(
    b.settle(retry, { state: "committed" }),
    /changed in another view/,
  );
  assert.deepEqual(a.all(), []);
});

test("serialized journal quota preserves existing recovery records under concurrent creation", async () => {
  const storage = new JSDOM("", { url: "https://loom.example" }).window
    .localStorage;
  const store = new IntentStore(
    "instance",
    "alice",
    storage,
    "https://loom.example",
  );
  for (let i = 0; i < 31; i++)
    await store.save(
      store.create(String(i), "reply.create", "/api/v1/replies", {}),
    );
  const before = store.all();
  const results = await Promise.allSettled(
    [0, 1].map((i) =>
      store.save(
        store.create("new" + i, "reply.create", "/api/v1/replies", {}),
      ),
    ),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(store.all().length, 32);
  for (const record of before)
    assert.deepEqual(
      store.all().find((r) => r.key === record.key),
      record,
    );
});

test("legacy unresolved records retain exact request identity when adopting journal versions", async () => {
  const storage = new JSDOM("", { url: "https://loom.example" }).window
    .localStorage;
  const store = new IntentStore(
    "instance",
    "alice",
    storage,
    "https://loom.example",
  );
  const { sequence: _, ...legacy } = store.create(
    "reply",
    "reply.create",
    "/api/v1/replies",
    { text: "legacy exact body" },
  );
  legacy.state = "uncertain";
  storage.setItem(store.prefix + legacy.key, JSON.stringify(legacy));
  const saved = await store.save(store.all()[0]!);
  assert.deepEqual(saved.body, legacy.body);
  assert.equal(saved.key, legacy.key);
  assert.equal(saved.state, "uncertain");
  await assert.rejects(
    store.save({ ...saved, state: "draft" }),
    /changed in another view/,
  );
  await assert.rejects(
    store.save({ ...saved, body: { ...saved.body, text: "different" } }),
    /changed in another view/,
  );
});
