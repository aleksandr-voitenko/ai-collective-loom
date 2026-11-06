import { admitPublication, chargeRate } from '../rates/accounting.js';
import {
  fileGuard,
  prepareFiles,
  prepareAttachments,
  admitFilePublication,
  uploadRow,
} from './file-context.js';
import { hasAttachmentSchema } from '../../db/schema-capabilities.js';
import { FileError } from './file-storage.js';
import type { SqlTransaction } from '../../db/postgres.js';
import { identityOf, type ActorContext } from '../publication/actor.js';
import { PublicationError } from '../publication/errors.js';
import {
  lockActor,
  lockContext,
  authorizePublication,
  requireRevision,
} from '../publication/guards.js';
import { commitRevision, result } from '../publication/publication.js';
import { structureGuard, OrganizationError } from './organization-context.js';
import { lockReferencePlan, prepareReferences } from './reference-context.js';
import {
  SummaryError,
  preparationGuard,
  preparation,
  expirePreparation,
  preparedMembers,
  coverageSet,
} from './summary-context.js';
import type { PreparedCoverage } from '../publication/summary-storage.js';
import { changeMembers, prepareChangeAccount } from './change-context.js';
import type { PreparedPublication } from './publication-preparation.js';
import { publicationOutcome } from './publication-attempt.js';
import type { DiscussionLink } from '../../../contracts/discussion-links.js';
import { prepareDiscussionLinks } from './discussion-link-context.js';
import { preparePublicationResource, requireOpenPublication } from './publication-resource.js';

export async function publishPreparedPublication(
  tx: SqlTransaction,
  actorContext: ActorContext,
  prepared: PreparedPublication,
  links: readonly DiscussionLink[] = [],
) {
  const { kind, input, content, digest, version } = prepared;
  const identity = identityOf(actorContext);
  const saved = await publicationOutcome(tx, identity.participantId, kind, input.idempotency_key);
  // Parent authorship is immutable. Discover it before the complete sorted
  // participant plan; never introduce a participant guard after resources.
  const replyAuthor =
    kind === 'reply.create' && !saved
      ? (
          await tx.query<{ id: string }>(
            'SELECT r.original_author_id AS id FROM loom.contributions c JOIN loom.resources r ON r.id=c.id WHERE c.id=$1',
            [input.parent_id],
          )
        ).rows[0]?.id
      : undefined;
  // All participant locks precede credential/resource guards in UUID order.
  for (const id of [
    ...new Set([
      identity.participantId,
      ...(replyAuthor ? [replyAuthor] : []),
      ...content.mentions.map((m) => m.participant_id),
      ...(input.change_note?.mentions.map((m) => m.participant_id) ?? []),
    ]),
  ].sort()) {
    await tx.query('SELECT id FROM loom.participants WHERE id=$1 FOR SHARE', [id]);
  }
  const actor = await lockActor(tx, actorContext);
  if (kind === 'community.setup' && !actor.administrator) throw new PublicationError('forbidden');
  if (saved) {
    const chain = await lockContext(tx, saved.resource_id, 'resolution');
    await requireRevision(tx, saved.resource_id, saved.revision_id);
    if (kind === 'revision.publish' || kind === 'summary.revise')
      await authorizePublication(tx, actor, chain);
    else requireOpenPublication(chain);
    if (saved.semantic_version !== version || saved.request_digest !== digest)
      throw new PublicationError('idempotency_conflict');
    return result(saved, 'replayed');
  }
  const allowance = await admitPublication(tx, actor.participantId);
  for (const mention of [...content.mentions, ...(input.change_note?.mentions ?? [])]) {
    const found = await tx.query(
      "SELECT id FROM loom.participants WHERE id=$1 AND state='active' AND kind IN ('human','agent')",
      [mention.participant_id],
    );
    if (!found.rowCount) throw new PublicationError('invalid_input');
  }
  // A refusal binds the attempt even if a retry omits its file envelope.
  // Older schemas have no file attempts; successful legacy replays resolve above.
  if (
    ['artifact.create', 'revision.publish', 'discussion.create', 'reply.create'].includes(kind) &&
    (
      await tx.query<{ ready: boolean }>(
        "SELECT to_regclass('loom.file_publication_refusals') IS NOT NULL AS ready",
        [],
      )
    ).rows[0]!.ready
  ) {
    const refusal = (
      await tx.query<{ request_digest: string }>(
        'SELECT request_digest FROM loom.file_publication_refusals WHERE participant_id=$1 AND operation_kind=$2 AND idempotency_key=$3',
        [actor.participantId, kind, input.idempotency_key],
      )
    ).rows[0];
    if (refusal) {
      if (refusal.request_digest !== digest) throw new PublicationError('idempotency_conflict');
      return new FileError('file_expired', true);
    }
  }
  const declaredFiles = input.file_set ?? input.attachment_set;
  if (declaredFiles) {
    await fileGuard(tx);
    if (await hasAttachmentSchema(tx))
      await admitFilePublication(tx, actor.participantId, declaredFiles.files.length);
    for (const member of declaredFiles.files)
      if ('upload_id' in member.source) {
        const upload = await uploadRow(tx, member.source.upload_id, actor.participantId);
        if (!upload.prepared_valid || ['expired', 'cleaning'].includes(upload.state)) {
          if (
            Number(
              (
                await tx.query<{ count: string }>(
                  'SELECT count(*)::text AS count FROM loom.file_publication_refusals',
                  [],
                )
              ).rows[0]!.count,
            ) >= 4096
          )
            throw new FileError('file_capacity');
          await tx.query(
            'INSERT INTO loom.file_publication_refusals(participant_id,operation_kind,idempotency_key,request_digest) VALUES($1,$2,$3,$4)',
            [actor.participantId, kind, input.idempotency_key, digest],
          );
          return new FileError('file_expired', true);
        }
      }
  }
  let coverage: PreparedCoverage | undefined;
  if (input.coverage) {
    if ('preparation_id' in input.coverage) {
      await preparationGuard(tx);
      const snapshot = await preparation(
        tx,
        actor.participantId,
        input.coverage.preparation_id,
        true,
      );
      if (!snapshot.valid) return expirePreparation(tx, snapshot.id);
      coverage = {
        discussion_id: snapshot.discussion_id,
        scope: snapshot.scope,
        preparation_id: snapshot.id,
        carried_from_revision_id: null,
        members: await preparedMembers(tx, snapshot.id),
      };
    } else {
      if (
        kind !== 'summary.revise' ||
        input.coverage.carry_forward_revision_id !== input.expected_revision_id
      )
        throw new PublicationError('invalid_input');
      const prior = await coverageSet(tx, input.coverage.carry_forward_revision_id);
      if (prior.summary_id !== input.resource_id) throw new PublicationError('unavailable');
      coverage = {
        ...prior,
        preparation_id: null,
        carried_from_revision_id: input.coverage.carry_forward_revision_id,
      };
    }
  }
  if (input.proposal_context) {
    // Freeze the designation with the same configuration-before-structure
    // order used by settings. Exact committed retries resolved above.
    await tx.query('SELECT pg_advisory_xact_lock($1::integer,$2::integer)', [0x4c4f4f4d, 3]);
    const configured = (
      await tx.query<{ version: number; proposal_area_id: string | null }>(
        'SELECT version,proposal_area_id FROM loom.community_settings WHERE id=1 FOR SHARE',
        [],
      )
    ).rows[0]!;
    if (
      configured.version !== input.proposal_context.expected_settings_version ||
      configured.proposal_area_id !== input.area_id
    )
      throw new OrganizationError('proposal_route_changed');
  }
  const described =
    input.change_account && 'revisions' in input.change_account
      ? input.change_account.revisions
      : input.change_account && 'carry_forward_revision_id' in input.change_account
        ? await changeMembers(tx, input.change_account.carry_forward_revision_id)
        : [];
  if (content.format !== 'loom-markdown-v1' || coverage || input.attachment_set || links.length) {
    // Setup must take the exclusive structure guard before any shared plan.
    if (kind === 'community.setup') {
      await tx.query('SELECT pg_advisory_xact_lock($1::integer,$2::integer)', [0x4c4f4f4d, 3]);
      await structureGuard(tx, true);
    }
    await lockReferencePlan(
      tx,
      [
        input.resource_id,
        input.area_id,
        input.parent_id,
        coverage?.discussion_id,
        input.proposal_context?.affected_area_id,
        ...(content.format !== 'loom-markdown-v1'
          ? content.references.map((ref) => ref.target.resource_id)
          : []),
        ...(input.change_note?.references.map((ref) => ref.target.resource_id) ?? []),
        ...described.map((target) => target.resource_id),
        ...(coverage?.members.map((m) => m.contribution_id) ?? []),
        ...links.flatMap((link) => [link.resource_id, ...(link.focus_id ? [link.focus_id] : [])]),
      ].filter((id): id is string => !!id),
      kind === 'summary.create'
        ? input.discussion_id
        : kind === 'revision.publish' || kind === 'summary.revise'
          ? input.resource_id
          : undefined,
    );
  }
  if (input.proposal_context?.affected_area_id)
    await lockContext(tx, input.proposal_context.affected_area_id, 'resolution', ['area']);
  const resource = await preparePublicationResource(tx, actor, prepared, coverage, replyAuthor);
  // Expiry persists a refusal: carry it through COMMIT before the public service
  // converts it to an error, just like file-expiry refusals above.
  if (resource instanceof SummaryError) return resource;
  const { chain, resourceId, title } = resource;
  if (input.change_note && !['artifact', 'summary'].includes(chain[0]!.kind))
    throw new PublicationError('invalid_input');
  if (input.change_account && chain[0]!.kind !== 'contribution')
    throw new PublicationError('invalid_input');
  const account = input.change_account
    ? await prepareChangeAccount(
        tx,
        resourceId,
        input.expected_revision_id ?? null,
        input.change_account,
      )
    : undefined;
  const noteReferences = input.change_note
    ? await prepareReferences(tx, resourceId, null, input.change_note.references, 'change_note')
    : undefined;
  const files = input.file_set
    ? await prepareFiles(
        tx,
        actor.participantId,
        resourceId,
        input.area_id ?? chain[1]?.id,
        input.file_set,
      )
    : undefined;
  const attachments = input.attachment_set
    ? await prepareAttachments(
        tx,
        actor.participantId,
        resourceId,
        kind === 'discussion.create'
          ? { kind: 'opening', resource_id: input.area_id }
          : kind === 'reply.create'
            ? { kind: 'reply', resource_id: input.parent_id }
            : { kind: 'contribution', resource_id: resourceId },
        input.attachment_set,
      )
    : undefined;
  await chargeRate(tx, allowance);
  return commitRevision(
    tx,
    actor,
    chain,
    {
      idempotency_key: input.idempotency_key,
      expected_revision_id: input.expected_revision_id ?? null,
      content,
      title,
      mentions: content.mentions,
      discussionLinks: await prepareDiscussionLinks(tx, chain[0]!, links),
      ...(files ? { files } : {}),
      ...(attachments ? { attachments } : {}),
      ...(coverage ? { coverage } : {}),
      ...(input.change_note
        ? { changeNote: input.change_note, noteReferences: noteReferences! }
        : {}),
      ...(account ? { changeAccount: account } : {}),
      ...(content.format !== 'loom-markdown-v1'
        ? {
            references: await prepareReferences(
              tx,
              resourceId,
              input.expected_revision_id ?? null,
              content.references,
            ),
          }
        : {}),
    },
    { kind, version, digest },
  );
}
