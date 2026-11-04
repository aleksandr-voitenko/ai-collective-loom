import { createHash } from 'node:crypto';
import { Value } from '@sinclair/typebox/value';
import type { Static, TSchema } from '@sinclair/typebox';
import { normalizeFileSet } from '../../../contracts/files.js';
import {
  DiscussionInput,
  ReplyInput,
  ArtifactInput,
  RevisionInput,
  SetupInput,
} from '../../../contracts/participation.js';
import {
  parseAuthored,
  validUnicode,
  validateChangeFields,
  canonicalReferenceTarget,
} from '../../../contracts/authored.js';
import { SummaryCreateInput, SummaryRevisionInput } from '../../../contracts/summaries.js';
import { PublicationError } from '../publication/errors.js';

export const schemas = {
  'discussion.create': DiscussionInput,
  'reply.create': ReplyInput,
  'artifact.create': ArtifactInput,
  'revision.publish': RevisionInput,
  'community.setup': SetupInput,
  'summary.create': SummaryCreateInput,
  'summary.revise': SummaryRevisionInput,
} satisfies Record<string, TSchema>;
export type PublicationKind = keyof typeof schemas;
export const participationSemanticVersion = 'participation-text-v1';
type Inputs = {
  [Kind in PublicationKind]: Static<(typeof schemas)[Kind]>;
};
type InputField = { [Kind in PublicationKind]: keyof Inputs[Kind] }[PublicationKind];
// Absent fields can be read by shared preparation but cannot be supplied. Each
// operation retains the required/optional fields of its actual runtime schema.
export type PublicationRequest = {
  [Kind in PublicationKind]: {
    kind: Kind;
    input: Inputs[Kind] & {
      [Field in Exclude<InputField, keyof Inputs[Kind]>]?: never;
    };
  };
}[PublicationKind];

function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, ordered(item)]),
    );
  return value;
}
export function digestRequest(
  kind: string,
  value: unknown,
  version = participationSemanticVersion,
) {
  return createHash('sha256')
    .update(JSON.stringify([version, kind, ordered(value)]))
    .digest('hex');
}
export function preparePublicationRequest(kind: PublicationKind, value: unknown) {
  const schema = schemas[kind];
  if (!schema || !Value.Check(schema, value)) throw new PublicationError('invalid_input');
  // Validation selects the schema by this same kind; keep that correlation
  // outside the body so it cannot enter the retained semantic digest.
  const request = { kind, input: structuredClone(value) } as PublicationRequest;
  const { input } = request;
  for (const [key, field] of Object.entries(input))
    if ((key.endsWith('_id') || key === 'idempotency_key') && typeof field === 'string')
      (input as Record<string, unknown>)[key] = field.toLowerCase();
  const content =
    request.kind === 'community.setup' ? request.input.overview : request.input.content;
  if (input.coverage)
    for (const key of Object.keys(input.coverage)) {
      const coverage = input.coverage as Record<string, string>;
      coverage[key] = coverage[key]!.toLowerCase();
    }
  if (input.proposal_context?.affected_area_id)
    input.proposal_context.affected_area_id = input.proposal_context.affected_area_id.toLowerCase();
  for (const field of [content, ...(input.change_note ? [input.change_note] : [])]) {
    field.mentions.forEach((entity) => {
      entity.participant_id = entity.participant_id.toLowerCase();
    });
    // Entity order is not semantic. Text, token spelling, line endings and spaces are.
    field.mentions.sort((a, b) => (a.token < b.token ? -1 : a.token > b.token ? 1 : 0));
    if (field.format !== 'loom-markdown-v1') {
      field.references = field.references
        .map((ref) => ({
          reference_id: ref.reference_id.toLowerCase(),
          target: (() => {
            try {
              return canonicalReferenceTarget(ref.target);
            } catch {
              throw new PublicationError('invalid_input');
            }
          })(),
          relationship: ref.relationship,
          rationale: ref.rationale,
        }))
        .sort((a, b) => a.reference_id.localeCompare(b.reference_id));
    }
  }
  if (input.change_account) {
    if ('carry_forward_revision_id' in input.change_account)
      input.change_account.carry_forward_revision_id =
        input.change_account.carry_forward_revision_id.toLowerCase();
    else
      input.change_account.revisions = input.change_account.revisions
        .map((target) => ({
          ...target,
          resource_id: target.resource_id.toLowerCase(),
          revision_id: target.revision_id.toLowerCase(),
        }))
        .sort(
          (a, b) =>
            a.resource_id.localeCompare(b.resource_id) ||
            a.revision_id.localeCompare(b.revision_id),
        );
  }
  try {
    if (input.file_set && input.attachment_set) throw new Error();
    if (input.file_set) input.file_set = normalizeFileSet(input.file_set);
    if (input.attachment_set) input.attachment_set = normalizeFileSet(input.attachment_set);
    if (
      !content.text.length &&
      (!input.file_set?.files.length || !['artifact.create', 'revision.publish'].includes(kind))
    )
      throw new Error('Empty text requires artifact files.');
    parseAuthored(content);
    validateChangeFields(content, input);
  } catch {
    throw new PublicationError('invalid_input');
  }
  for (const text of [
    input.title,
    input.community_name,
    input.ordinary_area_name,
    input.proposal_area_name,
  ]) {
    if (text && (text.includes('\0') || !validUnicode(text) || !text.trim()))
      throw new PublicationError('invalid_input');
  }
  const { idempotency_key: _key, ...semantic } = input;
  const version =
    content.format === 'loom-markdown-v4'
      ? kind.startsWith('summary.')
        ? 'discussion-summary-v3'
        : 'participation-text-v4'
      : input.attachment_set
        ? 'contribution-attachments-v1'
        : input.file_set
          ? 'artifact-files-v1'
          : content.format === 'loom-markdown-v3'
            ? kind.startsWith('summary.')
              ? 'discussion-summary-v2'
              : 'participation-text-v3'
            : kind.startsWith('summary.')
              ? 'discussion-summary-v1'
              : content.format === 'loom-markdown-v2'
                ? 'participation-text-v2'
                : participationSemanticVersion;
  return { ...request, content, version, digest: digestRequest(kind, semantic, version) };
}

export type PreparedPublication = ReturnType<typeof preparePublicationRequest>;
