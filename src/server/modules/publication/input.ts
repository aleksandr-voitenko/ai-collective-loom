import { createHash } from 'node:crypto';
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { PublicationError } from './errors.js';

const closed = { additionalProperties: false };
const uuid = Type.String({ pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' });
export const PublishRevisionInput = Type.Object({
  resource_id: uuid,
  idempotency_key: uuid,
  expected_revision_id: Type.Union([uuid, Type.Null()]),
  content: Type.Object({ format: Type.Literal('text/plain'), text: Type.String({ minLength: 1 }) }, closed),
}, closed);
export type PublicationInput = Static<typeof PublishRevisionInput>;
export const operationKind = 'revision.publish';
export const semanticVersion = 'text-revision-v1';

export function canonicalAttemptKey(value: unknown): string {
  if (!Value.Check(uuid, value)) throw new PublicationError('invalid_input');
  return value.toLowerCase();
}

/** Pure preparation: no network/SQL, coercion, Unicode normalization or trimming. */
export function preparePublication(value: unknown) {
  if (!Value.Check(PublishRevisionInput, value) || value.content.text.includes('\0')
    || Buffer.from(value.content.text, 'utf8').toString('utf8') !== value.content.text) throw new PublicationError('invalid_input');
  const input: PublicationInput = Object.freeze({
    resource_id: value.resource_id.toLowerCase(), idempotency_key: canonicalAttemptKey(value.idempotency_key),
    expected_revision_id: value.expected_revision_id?.toLowerCase() ?? null,
    content: Object.freeze({ format: value.content.format, text: value.content.text }),
  });
  // Fixed field order is semantic canonicalization, not a hash of transport JSON.
  const canonical = JSON.stringify([semanticVersion, operationKind, input.resource_id,
    input.expected_revision_id, input.content.format, input.content.text]);
  return { input, digest: createHash('sha256').update(canonical, 'utf8').digest('hex') };
}
