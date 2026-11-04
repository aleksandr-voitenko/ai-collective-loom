import { randomUUID } from 'node:crypto';
import type { SqlTransaction } from '../../db/postgres.js';
import { hasAttachmentSchema } from '../../db/schema-capabilities.js';
import { PublicationError, PublicationClosedError } from '../publication/errors.js';
import {
  lockActor,
  lockContext,
  requireRevision,
  authorizePublication,
  type Resource,
} from '../publication/guards.js';
import type { PreparedCoverage } from '../publication/summary-storage.js';
import { structureGuard, advanceHierarchy, OrganizationError } from './organization-context.js';
import {
  SummaryError,
  preparation,
  expirePreparation,
  authorizeMember,
} from './summary-context.js';
import type { PreparedPublication } from './publication-preparation.js';

export function requireOpenPublication(chain: Resource[]) {
  if (chain.some((resource) => !resource.publication_open)) throw new PublicationClosedError();
}

/** Current-base guards and atomic resource construction in the caller's transaction. */
export async function preparePublicationResource(
  tx: SqlTransaction,
  actor: Awaited<ReturnType<typeof lockActor>>,
  prepared: PreparedPublication,
  coverage: PreparedCoverage | undefined,
  replyAuthor: string | undefined,
) {
  const { kind, input, content, digest } = prepared;
  let chain: Resource[],
    resourceId: string,
    title = input.title ?? null;
  if (kind === 'revision.publish' || kind === 'summary.revise') {
    chain = await lockContext(tx, input.resource_id, 'publication');
    const resource = chain[0]!;
    if (resource.kind === 'summary' && kind !== 'summary.revise')
      throw new SummaryError('summary_coverage_required');
    if (
      kind === 'summary.revise' &&
      (resource.kind !== 'summary' ||
        !coverage ||
        coverage.discussion_id !== resource.owner_resource_id)
    )
      throw new PublicationError('unavailable');
    if (!resource.current_revision_id) throw new PublicationError('unavailable');
    await requireRevision(tx, resource.id, resource.current_revision_id);
    if (kind === 'summary.revise' && coverage?.preparation_id) {
      if (!(await preparation(tx, actor.participantId, coverage.preparation_id, true)).valid)
        return expirePreparation(tx, coverage.preparation_id);
      // A fresh declaration requires current source access; immediate-base
      // carry-forward deliberately keeps its independent historical rule.
      for (const member of coverage.members)
        await authorizeMember(tx, coverage.discussion_id, member);
    }
    await authorizePublication(tx, actor, chain);
    if (resource.current_revision_id !== input.expected_revision_id)
      throw new PublicationError('revision_conflict', resource.current_revision_id);
    if (input.attachment_set && (resource.kind !== 'contribution' || !content.text.length))
      throw new PublicationError('invalid_input');
    if (
      !input.attachment_set &&
      resource.kind === 'contribution' &&
      (await hasAttachmentSchema(tx)) &&
      (
        await tx.query(
          'SELECT revision_id FROM loom.contribution_attachment_sets WHERE revision_id=$1',
          [resource.current_revision_id],
        )
      ).rowCount
    )
      throw new PublicationError('file_format_required');
    if (input.file_set && resource.kind !== 'artifact') throw new PublicationError('invalid_input');
    if (
      !input.file_set &&
      (
        await tx.query<{ ready: boolean }>(
          "SELECT to_regclass('loom.artifact_file_sets') IS NOT NULL AS ready",
          [],
        )
      ).rows[0]!.ready &&
      (
        await tx.query('SELECT revision_id FROM loom.artifact_file_sets WHERE revision_id=$1', [
          resource.current_revision_id,
        ])
      ).rowCount
    )
      throw new PublicationError('file_format_required');
    const old = (
      await tx.query<{ title: string | null; content_format: string }>(
        'SELECT title,content_format FROM loom.revisions WHERE id=$1',
        [resource.current_revision_id],
      )
    ).rows[0]!;
    if (old.content_format === 'loom-markdown-v4' && content.format !== 'loom-markdown-v4')
      throw new PublicationError('file_reference_format_required');
    if (
      old.content_format === 'loom-markdown-v3' &&
      !['loom-markdown-v3', 'loom-markdown-v4'].includes(content.format)
    )
      throw new PublicationError('change_format_required');
    if (old.content_format === 'loom-markdown-v2' && content.format === 'loom-markdown-v1')
      throw new PublicationError('reference_format_required');
    if ((old.title === null) !== (title === null)) throw new PublicationError('invalid_input');
    resourceId = resource.id;
  } else if (kind === 'summary.create') {
    const owners = await lockContext(tx, input.discussion_id, 'resolution', ['discussion']);
    if (!coverage || coverage.discussion_id !== input.discussion_id || !coverage.preparation_id)
      throw new PublicationError('invalid_input');
    if (
      (
        await tx.query('SELECT id FROM loom.summaries WHERE discussion_id=$1', [
          input.discussion_id,
        ])
      ).rowCount
    )
      throw new SummaryError('summary_already_exists');
    // Validate before inserts. A prepared historical revision is valid, but
    // neither the handle nor earlier eligibility reserves current authority.
    if (!(await preparation(tx, actor.participantId, coverage.preparation_id, true)).valid)
      return expirePreparation(tx, coverage.preparation_id);
    for (const member of coverage.members)
      await authorizeMember(tx, coverage.discussion_id, member);
    requireOpenPublication(owners);
    resourceId = await createResource(tx, actor.participantId, 'summary', input.discussion_id);
    await tx.query('INSERT INTO loom.summaries(id,discussion_id) VALUES ($1,$2)', [
      resourceId,
      input.discussion_id,
    ]);
    await tx.query('INSERT INTO loom.resource_editors VALUES ($1,$2)', [
      resourceId,
      actor.participantId,
    ]);
    chain = await lockContext(tx, resourceId, 'publication', ['summary']);
  } else if (kind === 'community.setup') {
    await tx.query('SELECT pg_advisory_xact_lock($1::integer,$2::integer)', [0x4c4f4f4d, 3]);
    const settings = (
      await tx.query<{ version: number }>(
        'SELECT version FROM loom.community_settings WHERE id=1 FOR UPDATE',
        [],
      )
    ).rows[0];
    if (!settings || settings.version !== 0) throw new PublicationError('idempotency_conflict');
    await structureGuard(tx, true);
    if ((await tx.query('SELECT id FROM loom.areas LIMIT 499', [])).rows.length > 498)
      throw new OrganizationError('organization_limit');
    const areaId = randomUUID(),
      proposalId = randomUUID();
    for (const [id, name, description] of [
      [areaId, input.ordinary_area_name, 'Shared work, questions, and ideas.'],
      [proposalId, input.proposal_area_name, 'Proposals and feedback about this community.'],
    ]) {
      await tx.query("INSERT INTO loom.resources(id,kind) VALUES ($1,'area')", [id]);
      await tx.query('INSERT INTO loom.areas(id,title,description) VALUES ($1,$2,$3)', [
        id,
        name,
        description,
      ]);
      await tx.query(
        'INSERT INTO loom.area_metadata_revisions(id,area_id,version,title,description,publisher_id) VALUES ($1,$2,1,$3,$4,$5)',
        [randomUUID(), id, name, description, actor.participantId],
      );
    }
    await advanceHierarchy(tx);
    resourceId = await createResource(tx, actor.participantId, 'artifact', areaId);
    await tx.query('INSERT INTO loom.artifacts VALUES ($1)', [resourceId]);
    await tx.query('INSERT INTO loom.resource_editors VALUES ($1,$2)', [
      resourceId,
      actor.participantId,
    ]);
    await tx.query(
      'UPDATE loom.community_settings SET version=1, community_name=$1, overview_id=$2, proposal_area_id=$3 WHERE id=1',
      [input.community_name, resourceId, proposalId],
    );
    await tx.query(
      'INSERT INTO loom.participation_audit(id,actor_id,actor_credential_id,operation_kind,target_id,idempotency_key,request_digest,result_version) VALUES ($1,$2,$3,$4,$5,$6,$7,1)',
      [
        randomUUID(),
        actor.participantId,
        actor.credentialId,
        kind,
        resourceId,
        input.idempotency_key,
        digest,
      ],
    );
    chain = await lockContext(tx, resourceId, 'publication');
    title = 'Community overview';
  } else {
    const owners =
      kind === 'reply.create'
        ? await lockContext(tx, input.parent_id, 'resolution')
        : await lockContext(tx, input.area_id, 'resolution', ['area']);
    let ownerId: string;
    if (kind === 'reply.create') {
      const parent = owners[0]!;
      const row = (
        await tx.query<{ discussion_id: string }>(
          'SELECT discussion_id FROM loom.contributions WHERE id=$1',
          [parent.id],
        )
      ).rows[0];
      if (
        parent.kind !== 'contribution' ||
        row?.discussion_id !== input.discussion_id ||
        !parent.current_revision_id
      )
        throw new PublicationError('unavailable');
      await requireRevision(tx, parent.id, parent.current_revision_id);
      ownerId = row!.discussion_id;
    } else if (kind !== 'discussion.create' && kind !== 'artifact.create')
      throw new PublicationError('invalid_input');
    else ownerId = input.area_id;
    requireOpenPublication(owners);
    if (kind === 'discussion.create') {
      ownerId = await createResource(tx, actor.participantId, 'discussion', input.area_id);
    }
    const resourceKind = kind === 'artifact.create' ? 'artifact' : 'contribution';
    resourceId = await createResource(tx, actor.participantId, resourceKind, ownerId);
    if (kind === 'discussion.create')
      await tx.query('INSERT INTO loom.discussions VALUES ($1,$2)', [ownerId, resourceId]);
    if (resourceKind === 'contribution')
      await tx.query(
        'INSERT INTO loom.contributions(id,discussion_id,parent_id) VALUES ($1,$2,$3)',
        [resourceId, ownerId, input.parent_id ?? null],
      );
    else {
      await tx.query('INSERT INTO loom.artifacts VALUES ($1)', [resourceId]);
      await tx.query('INSERT INTO loom.resource_editors VALUES ($1,$2)', [
        resourceId,
        actor.participantId,
      ]);
    }
    if (kind === 'discussion.create' && input.proposal_context?.affected_area_id)
      await tx.query(
        'INSERT INTO loom.discussion_area_references(discussion_id,area_id) VALUES ($1,$2)',
        [ownerId, input.proposal_context.affected_area_id],
      );
    // Additive compatibility: populated upgrade fixtures still run the old
    // schema. Old requests/digests remain unchanged; only new facts are added.
    if (
      kind === 'reply.create' &&
      replyAuthor &&
      (
        await tx.query<{ ready: boolean }>(
          "SELECT to_regclass('loom.notification_reply_facts') IS NOT NULL AS ready",
          [],
        )
      ).rows[0]!.ready
    ) {
      await tx.query(
        `INSERT INTO loom.notification_reply_facts(reply_id,recipient_id,eligible)
              SELECT $1,id,state='active' AND kind IN ('human','agent') FROM loom.participants WHERE id=$2`,
        [resourceId, replyAuthor],
      );
    }
    // New rows are owned by this transaction. Existing owner locks were taken
    // before insertion; no competing transaction can yet see these identities.
    chain = await lockContext(tx, resourceId, 'publication');
  }
  return { chain, resourceId, title };
}
async function createResource(tx: SqlTransaction, actor: string, kind: string, owner: string) {
  const id = randomUUID();
  await tx.query(
    'INSERT INTO loom.resources(id,kind,owner_resource_id,original_author_id) VALUES ($1,$2,$3,$4)',
    [id, kind, owner, actor],
  );
  return id;
}
