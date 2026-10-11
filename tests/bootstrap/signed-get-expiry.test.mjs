import assert from "node:assert/strict";
import { test } from "node:test";
import { SIGNED_GET_EXPIRY_SECONDS, verifySignedGetExpiry } from "../../scripts/lib/signed-get-expiry.mjs";

const signedAt = Date.parse("2026-01-01T00:00:00Z");
const signedUrl = "http://127.0.0.1:8333/fixture?X-Amz-Date=20260101T000000Z&X-Amz-Expires=5&X-Amz-Signature=bearer-canary";

function scenario(outcomes, schedulingDelay = 0) {
  let clock = signedAt;
  const observed = { waits: [], requests: [], logs: [], cancelled: 0 };
  const options = {
    now: () => clock,
    wait: async (ms) => { observed.waits.push(ms); clock += ms + schedulingDelay; },
    log: (message) => observed.logs.push(message),
    request: async (url, { signal }) => {
      assert.equal(url, signedUrl);
      assert.ok(signal instanceof AbortSignal);
      const outcome = outcomes[observed.requests.length];
      observed.requests.push(clock);
      if (outcome instanceof Error) throw outcome;
      assert.ok(Number.isInteger(outcome), "Probe exceeded the supplied request outcomes.");
      return { status: outcome, body: { cancel: async () => { observed.cancelled += 1; } } };
    },
  };
  return { observed, options };
}

test("expiry probe uses five seconds, a clear margin, and safe actual timestamps", async () => {
  const { observed, options } = scenario([403], 2_500);
  assert.equal(SIGNED_GET_EXPIRY_SECONDS, 5);
  await verifySignedGetExpiry(signedUrl, options);
  assert.deepEqual(observed.waits, [7_000]);
  assert.deepEqual(observed.requests, [signedAt + 9_500]);
  assert.equal(observed.cancelled, 1);
  const logs = observed.logs.join("\n");
  assert.match(logs, /signedAt=2026-01-01T00:00:00\.000Z/);
  assert.match(logs, /expiresAt=2026-01-01T00:00:05\.000Z/);
  assert.match(logs, /requestedAt=2026-01-01T00:00:09\.500Z/);
  assert.match(logs, /status=403/);
  assert.ok(!logs.includes(signedUrl) && !logs.includes("bearer-canary"));
});

test("expiry probe retries only a still-successful GET until expiry denial", async () => {
  for (const [outcomes, waits, requestOffsets] of [
    [[200, 403], [7_000, 1_000], [7_000, 8_000]],
    [[200, 200, 403], [7_000, 1_000, 1_000], [7_000, 8_000, 9_000]],
  ]) {
    const { observed, options } = scenario(outcomes);
    await verifySignedGetExpiry(signedUrl, options);
    assert.deepEqual(observed.waits, waits);
    assert.deepEqual(observed.requests, requestOffsets.map((offset) => signedAt + offset));
    assert.equal(observed.cancelled, outcomes.length);
  }
});

test("expiry probe fails after three still-successful GETs", async () => {
  const { observed, options } = scenario([200, 200, 200]);
  await assert.rejects(verifySignedGetExpiry(signedUrl, options), /remained usable after 3 attempts/);
  assert.deepEqual(observed.waits, [7_000, 1_000, 1_000]);
  assert.equal(observed.requests.length, 3);
  assert.equal(observed.cancelled, 3);
});

for (const status of [401, 404, 500]) test(`expiry probe does not retry HTTP ${status}`, async () => {
  const { observed, options } = scenario([status]);
  await assert.rejects(verifySignedGetExpiry(signedUrl, options), /Unexpected signed GET expiry status/);
  assert.deepEqual(observed.waits, [7_000]);
  assert.equal(observed.requests.length, 1);
  assert.equal(observed.cancelled, 1);
});

test("expiry probe fails transport errors without retries or bearer disclosure", async () => {
  const { observed, options } = scenario([new Error(`request failed for ${signedUrl}`)]);
  await assert.rejects(verifySignedGetExpiry(signedUrl, options), (error) => {
    assert.match(error.message, /Signed GET expiry request failed/);
    assert.ok(!error.message.includes("bearer-canary") && !error.message.includes(signedUrl));
    return true;
  });
  assert.deepEqual(observed.waits, [7_000]);
  assert.equal(observed.requests.length, 1);
  assert.ok(!observed.logs.join("\n").includes("bearer-canary"));
});

test("expiry probe rejects missing or unexpected signing metadata before waiting", async () => {
  for (const url of [
    "not a URL bearer-canary",
    signedUrl.replace("20260101T000000Z", "invalid"),
    signedUrl.replace("20260101T000000Z", "20260230T000000Z"),
    signedUrl.replace("&X-Amz-Expires=5", ""),
    signedUrl.replace("Expires=5", "Expires=1"),
  ]) {
    const { observed, options } = scenario([]);
    await assert.rejects(verifySignedGetExpiry(url, options), /Invalid signed GET expiry metadata/);
    assert.deepEqual(observed.waits, []);
    assert.deepEqual(observed.requests, []);
    assert.ok(!observed.logs.join("\n").includes("bearer-canary"));
  }
});
