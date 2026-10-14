import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import {
  IntentStore,
  invalidateIdentity,
  request,
} from "../../src/web/participation-client.js";

test("recovery storage survives a new client object and separates participant, instance and origin", () => {
  const storage = new JSDOM("", { url: "https://loom.example" }).window
    .localStorage;
  const a = new IntentStore(
    "instance",
    "alice",
    storage,
    "https://loom.example",
  );
  const intent = a.create("reply:parent", "reply.create", "/api/v1/replies", {
    parent_id: "parent",
    content: {
      format: "loom-markdown-v1",
      text: "Exact\r\ntext",
      mentions: [],
    },
  });
  intent.state = "uncertain";
  a.save(intent);
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
  assert.throws(() => bob.save(intent), /different account/);
  bob.clear();
  assert.deepEqual(a.all(), [intent]);
});
test("full or unreadable recovery storage refuses writes without evicting unresolved intent", () => {
  const storage = new JSDOM("", { url: "https://loom.example" }).window
      .localStorage,
    a = new IntentStore("instance", "alice", storage, "https://loom.example");
  for (let i = 0; i < 32; i++) {
    const intent = a.create("reply:" + i, "reply.create", "/api/v1/replies", {
      text: "recover",
    });
    intent.state = "uncertain";
    a.save(intent);
  }
  const before = a.all();
  assert.throws(
    () => a.save(a.create("next", "reply.create", "/api/v1/replies", {})),
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
  const intent = store.create(
    "setup",
    "community.setup",
    "/api/v1/community/setup",
    { community_name: "" },
  );
  intent.state = "uncertain";
  store.save(intent);
  assert.throws(() => store.correct(intent), /definitively rejected/);
  assert.deepEqual(store.all(), [intent]);
  intent.state = "rejected";
  store.save(intent);
  const before = store.all();
  assert.throws(
    () => store.correct({ ...intent, participant_id: "bob" }),
    /different account/,
  );
  assert.deepEqual(store.all(), before);
  const next = store.correct(intent);
  assert.notEqual(next.key, intent.key);
  assert.equal(next.state, "draft");
  assert.deepEqual(next.body, { ...intent.body, idempotency_key: next.key });
  assert.deepEqual(store.all(), [next]);
});

test("failed correction storage keeps the original rejected attempt", () => {
  const storage = new JSDOM("", { url: "https://loom.example" }).window
    .localStorage;
  const store = new IntentStore(
    "instance",
    "alice",
    storage,
    "https://loom.example",
  );
  const intent = store.create("edit", "revision.publish", "/api/v1/revisions", {
    text: "Keep rejected text",
  });
  intent.state = "rejected";
  store.save(intent);
  for (let i = 1; i < 32; i++)
    store.save(
      store.create("other" + i, "reply.create", "/api/v1/replies", {}),
    );
  const before = store.all();
  assert.throws(() => store.correct(intent), /full/);
  assert.deepEqual(store.all(), before);
});
