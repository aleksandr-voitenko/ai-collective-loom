import type {
  AuthoredContent,
  ChangeAccountValue,
  NoteContent,
  ReferenceValue,
  RevisionView,
} from '../contracts/participation.js';
import type { FileSetValue, AttachmentSetValue, PublicationFileSet } from '../contracts/files.js';
import type { CoverageDeclarationValue } from '../contracts/summaries.js';
import type { Intent } from './participation-client.js';

type ProposalContext = { affected_area_id?: string; expected_settings_version: number | undefined };
type RevisionTarget = { resourceId: string; revisionId: string; title: string | null };
export type ComposerOperation =
  | { kind: 'discussion.create'; areaId: string; proposal?: ProposalContext }
  | { kind: 'artifact.create'; areaId: string }
  | { kind: 'reply.create'; discussionId: string; parentId: string }
  | { kind: 'summary.create'; discussionId: string }
  | ({ kind: 'revision.publish'; resourceKind: 'artifact' | 'contribution' } & RevisionTarget)
  | ({ kind: 'summary.revise'; discussionId: string } & RevisionTarget);

type TargetFields = {
  area_id?: string;
  discussion_id?: string;
  parent_id?: string;
  resource_id?: string;
  expected_revision_id?: string;
  title?: string | null;
  proposal_context?: ProposalContext;
};
type OperationDetails = {
  path: string;
  fixed: TargetFields;
  titleField: boolean;
  canFiles: boolean;
  canNote: boolean;
  summaryDiscussion: string | undefined;
};

export function composerOperation(operation: ComposerOperation): OperationDetails {
  switch (operation.kind) {
    case 'discussion.create':
      return {
        path: '/api/v1/discussions',
        fixed: {
          area_id: operation.areaId,
          ...(operation.proposal ? { proposal_context: operation.proposal } : {}),
        },
        titleField: true,
        canFiles: true,
        canNote: false,
        summaryDiscussion: undefined,
      };
    case 'artifact.create':
      return {
        path: '/api/v1/artifacts',
        fixed: { area_id: operation.areaId },
        titleField: true,
        canFiles: true,
        canNote: true,
        summaryDiscussion: undefined,
      };
    case 'reply.create':
      return {
        path: '/api/v1/replies',
        fixed: { discussion_id: operation.discussionId, parent_id: operation.parentId },
        titleField: false,
        canFiles: true,
        canNote: false,
        summaryDiscussion: undefined,
      };
    case 'summary.create':
      return {
        path: '/api/v1/summaries',
        fixed: { discussion_id: operation.discussionId },
        titleField: true,
        canFiles: false,
        canNote: true,
        summaryDiscussion: operation.discussionId,
      };
    case 'revision.publish':
      return {
        path: '/api/v1/revisions',
        fixed: {
          resource_id: operation.resourceId,
          expected_revision_id: operation.revisionId,
          title: operation.title,
        },
        titleField: operation.title !== null,
        canFiles: true,
        canNote: operation.resourceKind === 'artifact',
        summaryDiscussion: undefined,
      };
    case 'summary.revise':
      return {
        path: '/api/v1/summary-revisions',
        fixed: {
          resource_id: operation.resourceId,
          expected_revision_id: operation.revisionId,
          title: operation.title,
        },
        titleField: operation.title !== null,
        canFiles: false,
        canNote: true,
        summaryDiscussion: operation.discussionId,
      };
  }
}

export type DraftFields = {
  text: string;
  title: string;
  mentions: AuthoredContent['mentions'];
  format: AuthoredContent['format'];
  references: ReferenceValue[];
  // Journal bodies are deliberately opaque. Do not coerce a retained base while
  // constructing an editable draft or deciding which exact comparison to fetch.
  base: unknown;
  coverage: CoverageDeclarationValue | undefined;
  note: NoteContent | null;
  account: ChangeAccountValue | null;
  fileSet: PublicationFileSet | undefined;
};
export type DraftPatch = Partial<
  Pick<
    DraftFields,
    'text' | 'title' | 'mentions' | 'references' | 'coverage' | 'note' | 'account' | 'fileSet'
  >
>;
export type DraftBody = Omit<TargetFields, 'expected_revision_id'> & {
  expected_revision_id?: unknown;
  coverage?: CoverageDeclarationValue;
  file_set?: FileSetValue;
  attachment_set?: AttachmentSetValue;
  change_note?: NoteContent | null;
  change_account?: ChangeAccountValue | null;
  content: AuthoredContent;
};

export function buildDraftBody({
  operation,
  fields,
  patch = {},
}: {
  operation: ComposerOperation;
  fields: DraftFields;
  patch?: DraftPatch;
}): DraftBody {
  const { fixed, titleField } = composerOperation(operation);
  // Undefined keeps the previous field, matching the original positional
  // defaults. Null deliberately clears a note/account; empty strings/arrays stay.
  const {
    text = fields.text,
    title = fields.title,
    mentions = fields.mentions,
    references = fields.references,
    coverage = fields.coverage,
    note = fields.note,
    account = fields.account,
    fileSet = fields.fileSet,
  } = patch;
  const fileReferences =
    fields.format === 'loom-markdown-v4' ||
    note?.format === 'loom-markdown-v4' ||
    references.some((ref) => !!ref.target.file_id);
  const changes =
    fileReferences || fields.format === 'loom-markdown-v3' || !!note || !!account || !!fileSet;
  return {
    ...fixed,
    ...(fields.base ? { expected_revision_id: fields.base } : {}),
    ...(titleField ? { title } : {}),
    ...(coverage ? { coverage } : {}),
    ...(fileSet
      ? fileSet.version === 'artifact-files-v1'
        ? { file_set: fileSet as FileSetValue }
        : { attachment_set: fileSet as AttachmentSetValue }
      : {}),
    ...(changes ? { change_note: note, change_account: account } : {}),
    content: {
      ...(fileReferences
        ? { format: 'loom-markdown-v4' as const, references }
        : changes
          ? { format: 'loom-markdown-v3' as const, references }
          : fields.format === 'loom-markdown-v2' || references.length
            ? { format: 'loom-markdown-v2' as const, references }
            : { format: 'loom-markdown-v1' as const }),
      text,
      mentions,
    },
  };
}

type CorrectionRecord = Pick<Intent, 'body' | 'state' | 'conflict_revision_id' | 'required_format'>;
type ComparisonRevision = Pick<
  RevisionView,
  'revision_id' | 'content' | 'change_account' | 'file_set' | 'attachment_set'
>;
type CorrectionInput = {
  operation: ComposerOperation;
  record: CorrectionRecord | undefined;
  comparison: ComparisonRevision | undefined;
};

export function draftCorrection({ operation, record, comparison }: CorrectionInput) {
  const original = record?.body.content as AuthoredContent | undefined;
  const legacyFileCorrection =
    record?.state === 'rejected' &&
    operation.kind === 'revision.publish' &&
    !record.body.file_set &&
    !record.body.attachment_set;
  const legacyCorrection =
    record?.state === 'rejected' &&
    (operation.kind === 'revision.publish' || operation.kind === 'summary.revise') &&
    (original?.format === 'loom-markdown-v1' ||
      original?.format === 'loom-markdown-v2' ||
      (original?.format === 'loom-markdown-v3' &&
        (!!record.conflict_revision_id || record.required_format === 'loom-markdown-v4')));
  // Format refusals have no conflict ID. Their retained expected revision is
  // still the exact comparison base, never a newer fetched current revision.
  const comparisonRevision =
    record?.conflict_revision_id ??
    ((legacyCorrection || legacyFileCorrection) &&
    typeof record.body.expected_revision_id === 'string'
      ? record.body.expected_revision_id
      : undefined);
  const comparisonReady = !!comparison && comparison.revision_id === comparisonRevision;
  const adoptsBaseReferences =
    legacyCorrection &&
    comparisonReady &&
    original?.format === 'loom-markdown-v1' &&
    comparison.content.format !== 'loom-markdown-v1';
  const adoptsFileReferences =
    // A missing manifest is checked before authored-format compatibility. Its
    // correction must preserve the v4 citations too, even without that refusal marker.
    (legacyCorrection || legacyFileCorrection) &&
    comparisonReady &&
    (original?.format === 'loom-markdown-v2' || original?.format === 'loom-markdown-v3') &&
    comparison.content.format === 'loom-markdown-v4';
  const requiresComparison =
    legacyCorrection ||
    legacyFileCorrection ||
    (!!composerOperation(operation).summaryDiscussion && !!comparisonRevision);
  return {
    comparisonRevision,
    comparisonReady,
    adoptsBaseReferences,
    adoptsFileReferences,
    requiresComparison,
    legacyCorrection,
    legacyFileCorrection,
  };
}

export function correctDraft(input: CorrectionInput & { fields: DraftFields }) {
  const { operation, record, comparison, fields } = input;
  const correction = draftCorrection(input);
  if (
    record?.state !== 'rejected' ||
    (correction.requiresComparison && !correction.comparisonReady)
  )
    return undefined;
  const body = buildDraftBody({ operation, fields });
  const summary = !!composerOperation(operation).summaryDiscussion;
  // A correction never enlarges a summary's source claim. The declaration must
  // be chosen again after inspecting the exact comparison revision.
  if (summary) delete body.coverage;
  // Older clients cannot express file declarations. Explicit correction copies
  // those declarations without replacing supported attempted edits/withdrawals.
  // If a concurrent revision changed the same assertion to a file, retain its
  // identity and copy the older attempted declaration with a new identity.
  const comparisonFileReferences =
    comparison?.content.format === 'loom-markdown-v4'
      ? comparison.content.references.filter((ref) => ref.target.file_id)
      : [];
  const adopted =
    correction.adoptsBaseReferences && comparison?.content.format !== 'loom-markdown-v1'
      ? comparison?.content.references
      : correction.adoptsFileReferences && comparison?.content.format === 'loom-markdown-v4'
        ? [
            ...fields.references.map((ref) =>
              comparisonFileReferences.some(
                (base) => base.target.file_id && base.reference_id === ref.reference_id,
              )
                ? { ...ref, reference_id: crypto.randomUUID() }
                : ref,
            ),
            ...comparisonFileReferences,
          ]
        : undefined;
  const account =
    !['loom-markdown-v3', 'loom-markdown-v4'].includes(fields.format) &&
    ['loom-markdown-v3', 'loom-markdown-v4'].includes(comparison?.content.format ?? '')
      ? comparison?.change_account?.state === 'declared'
        ? { carry_forward_revision_id: comparison!.revision_id }
        : null
      : fields.account;
  const comparisonFiles = comparison?.file_set ?? comparison?.attachment_set;
  const fileSet =
    correction.legacyFileCorrection && comparisonFiles
      ? { version: comparisonFiles.version, files: comparisonFiles.files }
      : fields.fileSet;
  const format =
    comparison?.content.format === 'loom-markdown-v4' || fields.format === 'loom-markdown-v4'
      ? 'loom-markdown-v4'
      : fileSet
        ? 'loom-markdown-v3'
        : comparison?.content.format === 'loom-markdown-v3' || fields.format === 'loom-markdown-v3'
          ? 'loom-markdown-v3'
          : adopted
            ? 'loom-markdown-v2'
            : fields.format;
  return {
    fields: {
      ...fields,
      base: correction.comparisonRevision || fields.base,
      coverage: summary ? undefined : fields.coverage,
      format,
      account,
      fileSet,
      references: adopted ?? fields.references,
    } satisfies DraftFields,
    body: {
      ...body,
      ...(fileSet
        ? fileSet.version === 'artifact-files-v1'
          ? { file_set: fileSet as FileSetValue }
          : { attachment_set: fileSet as AttachmentSetValue }
        : {}),
      ...(correction.comparisonRevision
        ? { expected_revision_id: correction.comparisonRevision }
        : {}),
      ...(adopted || ['loom-markdown-v3', 'loom-markdown-v4'].includes(format)
        ? { content: { ...body.content, format, references: adopted ?? fields.references } }
        : {}),
      ...(['loom-markdown-v3', 'loom-markdown-v4'].includes(format)
        ? { change_note: fields.note, change_account: account }
        : {}),
    } satisfies DraftBody,
  };
}
