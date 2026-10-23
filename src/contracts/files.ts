import { Type, type Static } from '@sinclair/typebox';

// Kept independent of participation.ts so its publication schemas can embed this
// envelope without a runtime import cycle.
const closed = { additionalProperties: false };
const id = Type.String({
  pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
});
export const fileLimits = Object.freeze({
  fileBytes: 4 * 1024 * 1024,
  entries: 16,
  packageBytes: 32 * 1024 * 1024,
  manifestBytes: 16384,
  pathBytes: 512,
  depth: 8,
  active: 4,
  ownerSessions: 128,
  sessions: 4096,
  ownerBytes: 64 * 1024 * 1024,
  communityBytes: 256 * 1024 * 1024,
  transferMs: 15000,
  leaseSeconds: 120,
  uploadSeconds: 3600,
  preparedSeconds: 86400,
  cleanupItems: 8,
  versions: 8,
  ownerPublications: 2048,
  publications: 8192,
  ownerContexts: 8192,
  contexts: 65536,
});
export const FilePath = Type.String({ minLength: 1, maxLength: fileLimits.pathBytes });
export const FileMember = Type.Object(
  {
    path: FilePath,
    source: Type.Union([
      Type.Object({ upload_id: id }, closed),
      Type.Object({ revision_id: id, file_id: id }, closed),
    ]),
  },
  closed,
);
export const FileSet = Type.Object(
  {
    version: Type.Literal('artifact-files-v1'),
    files: Type.Array(FileMember, { maxItems: fileLimits.entries }),
  },
  closed,
);
export type FileSetValue = Static<typeof FileSet>;
export const AttachmentSet = Type.Object(
  { ...FileSet.properties, version: Type.Literal('contribution-attachments-v1') },
  closed,
);
export type AttachmentSetValue = Static<typeof AttachmentSet>;
export type PublicationFileSet = FileSetValue | AttachmentSetValue;
export type FileMemberValue = Static<typeof FileMember>;
export const UploadInput = Type.Object(
  {
    idempotency_key: id,
    target: Type.Object(
      {
        kind: Type.Union(
          ['area', 'artifact', 'opening', 'reply', 'contribution'].map((k) => Type.Literal(k)),
        ),
        resource_id: id,
      },
      closed,
    ),
    path: FilePath,
    size: Type.Integer({ minimum: 0, maximum: fileLimits.fileBytes }),
    sha256: Type.String({ pattern: '^[a-fA-F0-9]{64}$' }),
    media_type: Type.String({
      pattern: '^[a-zA-Z0-9!#$&^_.+-]+/[a-zA-Z0-9!#$&^_.+-]+$',
      maxLength: 127,
    }),
  },
  closed,
);
export type UploadInputValue = Static<typeof UploadInput>;
export const UploadStatus = Type.Object(
  {
    upload_id: id,
    state: Type.Union(
      [
        'waiting',
        'uploading',
        'staged',
        'finalizing',
        'prepared',
        'cleaning',
        'expired',
        'quarantined',
      ].map((v) => Type.Literal(v)),
    ),
    path: FilePath,
    size: Type.Integer(),
    sha256: Type.String(),
    media_type: Type.String(),
    upload_expires_at: Type.String(),
    prepared_expires_at: Type.String(),
  },
  closed,
);
export type UploadStatusValue = Static<typeof UploadStatus>;
export const FileEntry = Type.Object(
  {
    kind: Type.Literal('file'),
    path: FilePath,
    file_id: id,
    size: Type.Integer(),
    sha256: Type.String(),
    media_type: Type.String(),
    type_evidence: Type.Literal('declared'),
    download_url: Type.String(),
  },
  closed,
);
export type FileEntryValue = Static<typeof FileEntry>;
export const FilePage = Type.Object(
  {
    artifact_id: id,
    revision_id: id,
    prefix: Type.String(),
    items: Type.Array(
      Type.Union([
        FileEntry,
        Type.Object({ kind: Type.Literal('folder'), path: FilePath }, closed),
      ]),
      { maxItems: 25 },
    ),
    next_cursor: Type.Union([Type.String(), Type.Null()]),
    complete: Type.Boolean(),
    availability: Type.Literal('declared_not_probed'),
    max_response_bytes: Type.Integer(),
  },
  closed,
);
export type FilePageValue = Static<typeof FilePage>;
const { artifact_id: _artifact, ...filePageFields } = FilePage.properties;
export const AttachmentPage = Type.Object(
  {
    ...filePageFields,
    contribution_id: id,
    discussion_id: id,
    contributor_id: id,
    revision_publisher_id: id,
  },
  closed,
);
export type AttachmentPageValue = Static<typeof AttachmentPage>;
export const AttachmentSelection = Type.Object(
  {
    contribution_id: id,
    discussion_id: id,
    revision_id: id,
    contributor_id: id,
    revision_publisher_id: id,
    file: FileEntry,
  },
  closed,
);
export type AttachmentSelectionValue = Static<typeof AttachmentSelection>;
export const PromotionInput = Type.Object(
  {
    idempotency_key: id,
    source: Type.Object({ contribution_id: id, revision_id: id, file_id: id }, closed),
    area_id: id,
    title: Type.String({ minLength: 1, maxLength: 160 }),
  },
  closed,
);
export type PromotionInputValue = Static<typeof PromotionInput>;
export const PromotionProvenance = Type.Object(
  {
    artifact_id: id,
    revision_id: id,
    promoter_id: id,
    source: Type.Union([
      Type.Object({ state: Type.Literal('unavailable') }, closed),
      Type.Object(
        {
          state: Type.Literal('available'),
          discussion_id: id,
          contribution_id: id,
          revision_id: id,
          file_id: id,
          contributor_id: id,
          revision_publisher_id: id,
          uploader_id: id,
        },
        closed,
      ),
    ]),
  },
  closed,
);
export type PromotionProvenanceValue = Static<typeof PromotionProvenance>;

export function normalizeFilePath(value: string): string {
  const path = value.normalize('NFC');
  if (
    new TextDecoder().decode(new TextEncoder().encode(value)) !== value ||
    new TextEncoder().encode(path).length > fileLimits.pathBytes ||
    /[\\\x00-\x1f\x7f-\x9f]/u.test(path) ||
    /^[a-zA-Z]:/.test(path)
  )
    throw new Error('Invalid relative file path.');
  const segments = path.split('/');
  if (segments.length > fileLimits.depth || segments.some((s) => !s || s === '.' || s === '..'))
    throw new Error('Invalid relative file path.');
  return path;
}
export function normalizeFileSet<T extends PublicationFileSet>(value: T): T {
  const files = value.files
    .map((member) => ({
      path: normalizeFilePath(member.path),
      source:
        'upload_id' in member.source
          ? { upload_id: member.source.upload_id.toLowerCase() }
          : {
              revision_id: member.source.revision_id.toLowerCase(),
              file_id: member.source.file_id.toLowerCase(),
            },
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const seen = new Set<string>();
  for (const file of files) {
    const key = file.path.replace(/[A-Z]/g, (c) => c.toLowerCase());
    if (seen.has(key)) throw new Error('Duplicate file path.');
    seen.add(key);
  }
  for (const key of seen) {
    const parts = key.split('/');
    parts.pop();
    while (parts.length) {
      if (seen.has(parts.join('/'))) throw new Error('File and directory paths collide.');
      parts.pop();
    }
  }
  const result = { version: value.version, files };
  if (
    files.length > fileLimits.entries ||
    new TextEncoder().encode(JSON.stringify(result)).length > fileLimits.manifestBytes
  )
    throw new Error('File manifest exceeds the synthetic limit.');
  return result as T;
}
