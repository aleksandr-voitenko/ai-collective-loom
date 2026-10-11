import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

export const SIGNED_GET_EXPIRY_SECONDS = 5;
const EXPIRY_MARGIN_MS = 2_000;
const RETRY_DELAY_MS = 1_000;
const MAX_ATTEMPTS = 3;

/** Probe new-request expiry; never log a bearer URL or retry unrelated failures. */
export async function verifySignedGetExpiry(signedUrl, {
  request = fetch, wait = delay, now = Date.now, log = console.log,
} = {}) {
  let parameters;
  try { parameters = new URL(signedUrl).searchParams; }
  catch { throw new Error("Invalid signed GET expiry metadata."); }
  const stamp = parameters.get("X-Amz-Date") ?? "";
  const pattern = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;
  if (!pattern.test(stamp) || parameters.get("X-Amz-Expires") !== String(SIGNED_GET_EXPIRY_SECONDS)) {
    throw new Error("Invalid signed GET expiry metadata.");
  }
  const signedAtText = stamp.replace(pattern, "$1-$2-$3T$4:$5:$6.000Z");
  const signedAt = Date.parse(signedAtText);
  if (!Number.isFinite(signedAt) || new Date(signedAt).toISOString() !== signedAtText) {
    throw new Error("Invalid signed GET expiry metadata.");
  }
  const expiresAt = new Date(signedAt + SIGNED_GET_EXPIRY_SECONDS * 1_000).toISOString();
  const initialWaitMs = SIGNED_GET_EXPIRY_SECONDS * 1_000 + EXPIRY_MARGIN_MS;
  log(`Signed GET expiry: signedAt=${signedAtText} expiresAt=${expiresAt} initialWaitMs=${initialWaitMs}.`);
  // Start the full relative wait after presigning returns. Delayed scheduling only
  // adds margin; host/signing clock offsets cannot shorten this timer.
  await wait(initialWaitMs);
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const requestedAt = new Date(now()).toISOString();
    let response;
    try {
      response = await request(signedUrl, { signal: AbortSignal.timeout(10_000) });
      log(`Signed GET expiry: attempt=${attempt}/${MAX_ATTEMPTS} requestedAt=${requestedAt} status=${response.status}.`);
      await response.body?.cancel();
    } catch {
      // Client errors can contain the full URL; expose timing without that cause.
      throw new Error(`Signed GET expiry request failed: attempt=${attempt}/${MAX_ATTEMPTS} requestedAt=${requestedAt}.`);
    }
    if (response.status === 403) return;
    assert.equal(response.status, 200, "Unexpected signed GET expiry status; only HTTP 200 may retry.");
    assert.ok(attempt < MAX_ATTEMPTS, `Signed GET remained usable after ${MAX_ATTEMPTS} attempts beyond the expiry margin.`);
    await wait(RETRY_DELAY_MS);
  }
}
