import assert from 'node:assert/strict';
import { createDecipheriv } from 'node:crypto';
import test from 'node:test';
import { decryptCursor, encryptCursor } from '../../src/server/application/encrypted-cursor.js';

const key = Buffer.alloc(32, 7);
const payload = {
  binding: 'owner/query',
  after: 'a3e21072-3829-4c0a-8b51-bc254b37598c',
  label: '雪',
};
// Captured from the previous nonce/tag/ciphertext writer with a fixed nonce.
const legacy =
  'AwMDAwMDAwMDAwMDPHGOb0YI1P_zqOZHJ3EVcF7cwWo0TDcsHWJ5foQgkWmfE5Ga0eftUgP85teXgDKai4UcEf7JlHD5umY2tfzeaBNHI6Wkul9CHQVMwAwZvArE1A5Bl8VWPWuK1uWx--YJ30NS3yge';

test('opens a retained cursor with the unchanged UTF-8 JSON wire format', () => {
  assert.deepEqual(decryptCursor(key, legacy), payload);
  assert.deepEqual(decryptCursor(key, legacy + '='), payload);
});

test('new cursors retain the old layout and use independent random nonces', () => {
  const first = encryptCursor(key, () => payload),
    second = encryptCursor(key, () => payload);
  assert.notEqual(first, second);
  for (const token of [first, second]) {
    const bytes = Buffer.from(token, 'base64url');
    const oldReader = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    oldReader.setAuthTag(bytes.subarray(12, 28));
    assert.deepEqual(
      JSON.parse(
        Buffer.concat([oldReader.update(bytes.subarray(28)), oldReader.final()]).toString('utf8'),
      ),
      payload,
    );
  }
});

test('rejects changed nonce, tag, ciphertext, truncation and unrelated keys', () => {
  for (const offset of [0, 12, 28]) {
    const changed = Buffer.from(legacy, 'base64url');
    changed[offset] = changed[offset]! ^ 1;
    assert.throws(() => decryptCursor(key, changed.toString('base64url')));
  }
  for (const token of ['', 'invalid', legacy.slice(0, -4)])
    assert.throws(() => decryptCursor(key, token));
  assert.throws(() => decryptCursor(Buffer.alloc(32, 8), legacy));
});

test('moderation timestamps expiry after nonce and cipher creation', async (t) => {
  const { default: crypto } = await import('node:crypto');
  const { syncBuiltinESMExports } = await import('node:module');
  const { SharedModeration } = await import('../../src/server/modules/participation/moderation.js');
  const reader = new SharedModeration({
    transaction: async () => {
      throw new Error('Unexpected SQL');
    },
  }) as unknown as {
    cursor(binding: string, after: string): string;
    cursorKey: Buffer;
  };
  const trace: string[] = [];
  const nonce = crypto.randomBytes,
    cipher = crypto.createCipheriv;
  t.mock.method(crypto, 'randomBytes', ((size: number) => {
    trace.push('nonce');
    return nonce(size);
  }) as typeof crypto.randomBytes);
  t.mock.method(crypto, 'createCipheriv', ((...args: Parameters<typeof crypto.createCipheriv>) => {
    trace.push('cipher');
    return cipher(...args);
  }) as typeof crypto.createCipheriv);
  t.mock.method(Date, 'now', () => {
    trace.push('expiry');
    return 1000;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const token = reader.cursor(payload.binding, payload.after);
  assert.deepEqual(trace, ['nonce', 'cipher', 'expiry']);
  assert.deepEqual(decryptCursor(reader.cursorKey, token), {
    binding: payload.binding,
    after: payload.after,
    expires: 301000,
  });
});
