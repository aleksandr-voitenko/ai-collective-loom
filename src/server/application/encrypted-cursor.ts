import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// Ordinary browsing cursors have no associated data; protocol-bound tokens keep
// their own authenticated envelope.
// Wire layout is nonce (12 bytes), authentication tag (16 bytes), then UTF-8 JSON.
// Evaluate payloads after cipher creation so caller-owned expiry timestamps retain
// their original ordering. Callers retain keys, validation, bounds and error policy.
export function encryptCursor(key: Buffer, value: () => object): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const bytes = Buffer.concat([cipher.update(JSON.stringify(value()), 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), bytes]).toString('base64url');
}

export function decryptCursor(key: Buffer, value: string): unknown {
  const bytes = Buffer.from(value, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return JSON.parse(
    Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'),
  );
}
