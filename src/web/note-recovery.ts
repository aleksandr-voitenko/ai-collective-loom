import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import * as N from '../contracts/notes.js';
import { UUID, closed } from '../contracts/participation.js';
import { validUnicode } from '../contracts/authored.js';
import type { Intent } from './participation-client.js';
const draftLink = Type.Object(
  {
    kind: Type.Union(
      ['discussion', 'contribution', 'summary', 'artifact'].map((k) => Type.Literal(k)),
    ),
    resource_id: Type.String({ maxLength: 36 }),
    revision_id: Type.Optional(Type.String({ maxLength: 36 })),
  },
  closed,
);
export const NoteDraft = Type.Object(
  {
    idempotency_key: UUID,
    note_id: UUID,
    expected_version: Type.Optional(Type.Integer({ minimum: 1 })),
    title: Type.String({ maxLength: 256 }),
    body: Type.String({ maxLength: 16384 }),
    links: Type.Array(draftLink, { maxItems: 8 }),
  },
  closed,
);
export function noteAction(record: Intent) {
  return record.kind.slice(6) as N.NoteActionValue;
}
export function validNoteRecord(record: Intent) {
  const action = noteAction(record),
    schema = N.noteCommands[action];
  return (
    !!schema &&
    record.path === '/api/v1/me/notes/' + action &&
    Value.Check(
      record.state === 'draft' && action !== 'delete' ? NoteDraft : schema,
      record.body,
    ) &&
    (record.note_receipt === undefined ||
      (Value.Check(N.NoteResult, record.note_receipt) &&
        record.note_receipt.action === action &&
        record.note_receipt.outcome.note_id === String(record.body.note_id).toLowerCase()))
  );
}
export function validateNoteCommand(action: N.NoteActionValue, body: Record<string, unknown>) {
  if (!Value.Check(N.noteCommands[action], body))
    throw new Error(
      'Review the note fields and complete resource/revision IDs. Your draft is retained.',
    );
  if (action !== 'delete') {
    const input = body as unknown as N.NoteCreateInput;
    if (
      !input.body.trim() ||
      [input.title, input.body].some((text) => !validUnicode(text) || text.includes('\0')) ||
      new TextEncoder().encode(input.title).length > N.noteLimits.titleBytes ||
      new TextEncoder().encode(input.body).length > N.noteLimits.bodyBytes
    )
      throw new Error(
        'Use a nonblank note body, at most 16 KiB of UTF-8, and a title at most 256 UTF-8 bytes. Your draft is retained.',
      );
    const links = input.links.map((link) =>
      JSON.stringify([
        link.kind,
        link.resource_id.toLowerCase(),
        link.revision_id?.toLowerCase() ?? null,
      ]),
    );
    if (
      new Set(links).size !== links.length ||
      input.links.some((link) => link.kind === 'discussion' && link.revision_id)
    )
      throw new Error(
        'Remove duplicate links. A discussion has no revision; select its opening contribution for an exact link.',
      );
  }
}
export function terminalNote(record: Intent, terminal: N.NoteDeletedView) {
  return (
    record.kind.startsWith('notes.') &&
    Value.Check(N.NoteDeleted, terminal) &&
    Number.isFinite(Date.parse(terminal.deleted_at)) &&
    terminal.note_id === String(record.body.note_id).toLowerCase() &&
    terminal.version > Number(record.body.expected_version ?? 0)
  );
}
