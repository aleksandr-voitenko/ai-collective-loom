import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { SearchError } from './search.js';

/** Instance-local custody, separate from authored search and other continuations. */
export class FileTokens {
  private readonly key = randomBytes(32);
  encode(binding: string, boundary: string, offset: number, expires: number) {
    const nonce = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    const body = Buffer.concat([
      cipher.update(JSON.stringify({ binding, boundary, offset, expires })),
      cipher.final(),
    ]);
    return Buffer.concat([nonce, cipher.getAuthTag(), body]).toString('base64url');
  }
  decode(value: string, binding: string, boundary: string, maximum: number) {
    try {
      if (value.length > 2048) throw new Error();
      const bytes = Buffer.from(value, 'base64url'),
        cipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
      cipher.setAuthTag(bytes.subarray(12, 28));
      const token = JSON.parse(
        Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString(),
      );
      if (
        token.binding !== binding ||
        token.boundary !== boundary ||
        !Number.isSafeInteger(token.offset) ||
        token.offset < 0 ||
        token.offset >= maximum ||
        !Number.isFinite(token.expires) ||
        token.expires <= Date.now()
      )
        throw new Error();
      return token as { offset: number; expires: number };
    } catch {
      throw new SearchError('search_changed');
    }
  }
}
