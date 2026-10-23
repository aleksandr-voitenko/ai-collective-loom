import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import {
  limits,
  contractVersion,
  guideRevision,
  type ResourceView,
  type RevisionView,
  type PageView,
  type ContributionContextView,
} from '../../../contracts/participation.js';
import type { SqlTransaction, Transactions } from '../../db/postgres.js';
import type { ActorContext } from '../publication/actor.js';
import { identityOf } from '../publication/actor.js';
import { PublicationError, safeError } from '../publication/errors.js';
import { lockActor, lockContext, requireRevision } from '../publication/guards.js';
import { hasChangeSchema, hasAttachmentSchema } from '../../db/schema-capabilities.js';
import { hierarchyVersion, structureGuard } from './organization-context.js';
import { declaration, revisionReferences } from './reference-context.js';

export class RetrievalError extends Error {
  constructor(
    readonly code: 'invalid_cursor' | 'response_budget_too_small',
    readonly minimum_response_bytes?: number,
  ) {
    super(code);
  }
}
// Resource/owner guards must succeed before this narrower refusal is raised.
// It permits independent history discovery without implying a revision exists.
export class RevisionUnavailableError extends PublicationError {
  constructor() {
    super('unavailable');
  }
}
export type PageOptions = {
  cursor?: string;
  limit?: string;
  max_response_bytes?: string;
};
export function responseBudget(value?: string) {
  const budget = value === undefined ? limits.responseBytes : Number(value);
  if (
    !Number.isSafeInteger(budget) ||
    budget < limits.minResponseBytes ||
    budget > limits.responseBytes
  )
    throw new PublicationError('invalid_input');
  return budget;
}
export function fit<T>(value: T, budget: number): T {
  const bytes = Buffer.byteLength(JSON.stringify(value));
  if (bytes > budget) throw new RetrievalError('response_budget_too_small', bytes);
  return value;
}

export class ParticipationRetrieval {
  // Continuations hide scanned protected IDs. Restart invalidates this short-lived
  // query capability; it never invalidates publication intent or exact resource IDs.
  private readonly cursorKey = randomBytes(32);
  constructor(private readonly database: Transactions) {}
  private encode(binding: string, after: string) {
    const nonce = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', this.cursorKey, nonce);
    const bytes = Buffer.concat([
      cipher.update(JSON.stringify({ binding, after }), 'utf8'),
      cipher.final(),
    ]);
    return Buffer.concat([nonce, cipher.getAuthTag(), bytes]).toString('base64url');
  }
  private decode(binding: string, value?: string) {
    if (!value) return null;
    try {
      const bytes = Buffer.from(value, 'base64url'),
        decipher = createDecipheriv('aes-256-gcm', this.cursorKey, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      const saved = JSON.parse(
        Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'),
      ) as { binding: string; after: string };
      if (saved.binding !== binding || !/^[0-9a-f-]{36}$/.test(saved.after)) throw new Error();
      return saved.after;
    } catch {
      throw new RetrievalError('invalid_cursor');
    }
  }
  private async run<T>(operation: (tx: SqlTransaction) => Promise<T>) {
    try {
      return await this.database.transaction(operation);
    } catch (error) {
      if (error instanceof RetrievalError) throw error;
      return safeError(error);
    }
  }
  async resource(
    tx: SqlTransaction,
    actor: Awaited<ReturnType<typeof lockActor>>,
    id: string,
    revisionId?: string,
    full = false,
  ): Promise<ResourceView | RevisionView> {
    const chain = await lockContext(tx, id, 'resolution');
    const resource = chain[0]!,
      selected = revisionId ?? resource.current_revision_id;
    if (!selected) throw new RevisionUnavailableError();
    try {
      await requireRevision(tx, id, selected);
    } catch (error) {
      if (error instanceof PublicationError && error.code === 'unavailable')
        throw new RevisionUnavailableError();
      throw error;
    }
    // An eligible historical body does not authorize disclosing the pointer to a
    // newer suppressed revision, or advertising an edit against that hidden base.
    const currentAvailable =
      selected === resource.current_revision_id ||
      !!(
        await tx.query(
          "SELECT id FROM loom.revisions WHERE resource_id=$1 AND id=$2 AND availability='available' FOR SHARE",
          [id, resource.current_revision_id],
        )
      ).rowCount;
    const row = (
      await tx.query<{
        title: string | null;
        revision_number: string;
        publisher_id: string;
        created_at: Date;
        author_nickname: string;
        author_kind: string;
        publisher_nickname: string;
        publisher_kind: string;
        discussion_id: string | null;
        parent_id: string | null;
        is_editor: boolean;
      }>(
        `SELECT v.title,v.revision_number::text,v.publisher_id,v.created_at,
      a.nickname AS author_nickname,a.kind AS author_kind,p.nickname AS publisher_nickname,p.kind AS publisher_kind,
      COALESCE(c.discussion_id,(SELECT owner_resource_id FROM loom.resources WHERE id=$1 AND kind='summary')) AS discussion_id,c.parent_id,EXISTS(SELECT 1 FROM loom.resource_editors WHERE resource_id=$1 AND participant_id=$3) AS is_editor
      FROM loom.revisions v JOIN loom.participants p ON p.id=v.publisher_id
      JOIN loom.participants a ON a.id=$4 LEFT JOIN loom.contributions c ON c.id=v.resource_id
      WHERE v.id=$2 AND v.resource_id=$1`,
        [id, selected, actor.participantId, resource.original_author_id],
      )
    ).rows[0];
    if (!row) throw new PublicationError('unavailable');
    const area = chain.find((item) => item.kind === 'area')!;
    const areaTitle =
      (await tx.query<{ title: string }>('SELECT title FROM loom.areas WHERE id=$1', [area.id]))
        .rows[0]?.title ?? 'Unavailable topic';
    const view: ResourceView = {
      resource_id: id,
      kind: resource.kind,
      title: row.title,
      revision_id: selected,
      revision_number: row.revision_number,
      author: {
        id: resource.original_author_id!,
        nickname: row.author_nickname,
        kind: row.author_kind,
      },
      publisher: {
        id: row.publisher_id,
        nickname: row.publisher_nickname,
        kind: row.publisher_kind,
      },
      created_at: row.created_at.toISOString(),
      area_id: area.id,
      area_title: areaTitle,
      discussion_id: row.discussion_id,
      parent_id: row.parent_id,
      can_edit:
        currentAvailable &&
        chain.every((item) => item.publication_open) &&
        (actor.administrator ||
          (resource.kind === 'contribution'
            ? resource.original_author_id === actor.participantId
            : row.is_editor)),
      publication_open: chain.every((item) => item.publication_open),
      full_content_url: `/api/v1/resources/${id}/revisions/${selected}`,
    };
    if (row.discussion_id) {
      const reference = (
        await tx.query<{ area_id: string }>(
          'SELECT area_id FROM loom.discussion_area_references WHERE discussion_id=$1',
          [row.discussion_id],
        )
      ).rows[0];
      if (reference) {
        try {
          await lockContext(tx, reference.area_id, 'resolution', ['area']);
          view.affected_area_id = reference.area_id;
        } catch (error) {
          if (!(error instanceof PublicationError) || error.code !== 'unavailable') throw error;
        }
      }
    }
    if (!full) return view;
    const body = (
      await tx.query<{ content_format: string; content_text: string }>(
        'SELECT content_format,content_text FROM loom.revisions WHERE id=$1',
        [selected],
      )
    ).rows[0]!;
    // Legacy internal test envelopes are not participant documents.
    if (!['loom-markdown-v1', 'loom-markdown-v2', 'loom-markdown-v3'].includes(body.content_format))
      throw new RevisionUnavailableError();
    const fields = await hasChangeSchema(tx);
    const mentions = (
      await tx.query<{
        token: string;
        participant_id: string;
        nickname: string;
        kind: string;
      }>(
        `SELECT m.token,m.participant_id,p.nickname,p.kind FROM loom.revision_mentions m
      JOIN loom.participants p ON p.id=m.participant_id WHERE m.revision_id=$1 ${fields ? "AND m.source_field='main'" : ''} ORDER BY m.token`,
        [selected],
      )
    ).rows;
    return {
      ...view,
      ...(view.kind === 'artifact' &&
      (
        await tx.query<{ ready: boolean }>(
          "SELECT to_regclass('loom.artifact_file_sets') IS NOT NULL AS ready",
          [],
        )
      ).rows[0]!.ready &&
      (
        await tx.query('SELECT revision_id FROM loom.artifact_file_sets WHERE revision_id=$1', [
          selected,
        ])
      ).rowCount
        ? {
            file_set: {
              version: 'artifact-files-v1' as const,
              files: (
                await tx.query<{ id: string; path: string }>(
                  'SELECT id,path FROM loom.file_contexts WHERE revision_id=$1 ORDER BY path LIMIT 16',
                  [selected],
                )
              ).rows.map((f) => ({
                path: f.path,
                source: { revision_id: selected, file_id: f.id },
              })),
              manifest_url: `/api/v1/artifacts/${id}/revisions/${selected}/files`,
            },
          }
        : {}),
      ...(view.kind === 'contribution' &&
      (await hasAttachmentSchema(tx)) &&
      (
        await tx.query(
          'SELECT revision_id FROM loom.contribution_attachment_sets WHERE revision_id=$1',
          [selected],
        )
      ).rowCount
        ? {
            attachment_set: {
              version: 'contribution-attachments-v1' as const,
              files: (
                await tx.query<{ id: string; path: string }>(
                  'SELECT id,path FROM loom.file_contexts WHERE contribution_id=$1 AND revision_id=$2 ORDER BY path LIMIT 16',
                  [id, selected],
                )
              ).rows.map((f) => ({
                path: f.path,
                source: { revision_id: selected, file_id: f.id },
              })),
              manifest_url: `/api/v1/contributions/${id}/revisions/${selected}/attachments`,
            },
          }
        : {}),
      ...(view.kind === 'artifact' &&
      (await hasAttachmentSchema(tx)) &&
      (
        await tx.query(
          'SELECT revision_id FROM loom.attachment_promotions WHERE artifact_id=$1 AND revision_id=$2',
          [id, selected],
        )
      ).rowCount
        ? { provenance_url: `/api/v1/artifacts/${id}/revisions/${selected}/provenance` }
        : {}),
      content: {
        ...(body.content_format !== 'loom-markdown-v1'
          ? {
              format: body.content_format as 'loom-markdown-v2' | 'loom-markdown-v3',
              references: (await revisionReferences(tx, selected)).map(declaration),
            }
          : { format: 'loom-markdown-v1' as const }),
        text: body.content_text,
        mentions: mentions.map((m) => ({
          token: m.token,
          participant_id: m.participant_id,
        })),
      },
      mentioned_participants: mentions.map((m) => ({
        id: m.participant_id,
        nickname: m.nickname,
        kind: m.kind,
      })),
      ...(body.content_format === 'loom-markdown-v3'
        ? {
            change_note: {
              state: (
                await tx.query(
                  'SELECT revision_id FROM loom.revision_change_notes WHERE revision_id=$1',
                  [selected],
                )
              ).rowCount
                ? ('available' as const)
                : ('absent' as const),
              full_content_url: `/api/v1/resources/${id}/revisions/${selected}/change-note`,
            },
            change_account: {
              state: (
                await tx.query(
                  'SELECT revision_id FROM loom.change_account_sets WHERE revision_id=$1',
                  [selected],
                )
              ).rowCount
                ? ('declared' as const)
                : ('absent' as const),
              coverage_url: `/api/v1/resources/${id}/revisions/${selected}/change-coverage`,
            },
          }
        : {}),
      current_revision_id: currentAvailable ? resource.current_revision_id : null,
    };
  }
  detail(actor: ActorContext, id: string, revision?: string, budget?: string) {
    return this.run(
      async (tx) =>
        fit(
          await this.resource(tx, await lockActor(tx, actor), id, revision, true),
          responseBudget(budget),
        ) as RevisionView,
    );
  }
  private async contributionOwner(tx: SqlTransaction, id: string) {
    const chain = await lockContext(tx, id, 'reply-traversal', ['contribution']);
    const row = (
      await tx.query<{ discussion_id: string; parent_id: string | null }>(
        'SELECT discussion_id,parent_id FROM loom.contributions WHERE id=$1',
        [id],
      )
    ).rows[0];
    if (!row || row.discussion_id !== chain[1]?.id) throw new PublicationError('unavailable');
    return row;
  }
  contribution(actor: ActorContext, id: string, budget?: string): Promise<ContributionContextView> {
    return this.run(async (tx) => {
      const authority = await lockActor(tx, actor);
      const ownership = await this.contributionOwner(tx, id);
      let value: ContributionContextView;
      try {
        value = (await this.resource(tx, authority, id, undefined, true)) as RevisionView;
      } catch (error) {
        if (!(error instanceof PublicationError) || error.code !== 'unavailable') throw error;
        value = { resource_id: id, state: 'unavailable', ...ownership };
      }
      return fit(value, responseBudget(budget));
    });
  }
  area(actor: ActorContext, id: string) {
    return this.run(async (tx) => {
      await lockActor(tx, actor);
      const chain = await lockContext(tx, id, 'resolution', ['area']);
      const area = (
        await tx.query<{ id: string; title: string; description: string }>(
          'SELECT id,title,description FROM loom.areas WHERE id=$1',
          [id],
        )
      ).rows[0];
      if (!area) throw new PublicationError('unavailable');
      return {
        ...area,
        publication_open: chain.every((resource) => resource.publication_open),
      };
    });
  }
  discussion(actor: ActorContext, id: string) {
    return this.run(async (tx) => {
      const authority = await lockActor(tx, actor),
        chain = await lockContext(tx, id, 'resolution', ['discussion']);
      const discussion = (
        await tx.query<{ opening_id: string }>(
          'SELECT opening_id FROM loom.discussions WHERE id=$1',
          [id],
        )
      ).rows[0];
      if (!discussion) throw new PublicationError('unavailable');
      const area = (
        await tx.query<{ id: string; title: string; description: string }>(
          'SELECT id,title,description FROM loom.areas WHERE id=$1',
          [chain[1]!.id],
        )
      ).rows[0]!;
      return {
        id,
        area: { ...area, publication_open: chain.slice(1).every((r) => r.publication_open) },
        opening: await this.resource(tx, authority, discussion.opening_id),
      };
    });
  }
  onboarding(actor: ActorContext) {
    return this.run(async (tx) => {
      const authority = await lockActor(tx, actor);
      const settings = (
        await tx.query<{
          instance_id: string;
          community_name: string;
          version: number;
          overview_id: string | null;
          proposal_area_id: string | null;
        }>(
          'SELECT instance_id,community_name,version,overview_id,proposal_area_id FROM loom.community_settings WHERE id=1',
          [],
        )
      ).rows[0];
      if (!settings) throw new PublicationError('service_unavailable');
      const designation = async (id: string | null, kind: 'artifact' | 'area') => {
        if (!id) return { state: 'setup_incomplete' as const };
        try {
          const chain = await lockContext(tx, id, 'resolution', [kind]);
          if (kind === 'area') {
            if (!chain.every((r) => r.publication_open))
              return {
                state: 'unavailable' as const,
                unavailable_reason: 'publication_closed' as const,
              };
            return { state: 'ready' as const, resource_id: id };
          }
          const resource = await this.resource(tx, authority, id);
          return {
            state: 'ready' as const,
            resource_id: id,
            revision_id: resource.revision_id,
          };
        } catch (error) {
          if (error instanceof PublicationError && error.code === 'unavailable')
            return { state: 'unavailable' as const };
          throw error;
        }
      };
      return {
        instance_id: settings.instance_id,
        contract_version: contractVersion,
        guide_revision: guideRevision,
        profile: 'synthetic' as const,
        community_name: settings.community_name,
        settings_version: settings.version,
        overview: await designation(settings.overview_id, 'artifact'),
        proposal_area: await designation(settings.proposal_area_id, 'area'),
        contacts: (
          await tx.query<{ id: string; nickname: string; kind: string }>(
            "SELECT id,nickname,kind FROM loom.participants WHERE state='active' AND role='administrator' AND kind <> 'internal' ORDER BY id LIMIT 25",
            [],
          )
        ).rows,
        contacts_url: '/api/v1/contacts',
        guide_url: '/api/v1/guide',
        openapi_url: '/api/v1/openapi.json',
        limits,
        replay_retention:
          'retained_without_automatic_expiry; destructive_restore_unsupported' as const,
        derived_effects:
          'search_personal_direct_attention_and_supported_file_text; other_projections_disabled' as const,
        updates_contract: 'combined-updates-1' as const,
        attention_contract: 'attention-controls-1' as const,
        moderation_contract: 'moderation-state-1' as const,
        moderation_url: '/api/v1/admin/moderation/targets' as const,
        attention_url: '/api/v1/me/attention/list' as const,
        routine_updates_contract: 'combined-updates-2' as const,
        routine_updates_url: '/api/v1/me/routine-updates/query' as const,
        reading_contract: 'reading-state-1' as const,
        reading_url: '/api/v1/me/reading/lookup' as const,
        updates_url: '/api/v1/me/updates/query' as const,
        notification_contract: 'personal-attention-1' as const,
        notifications_url: '/api/v1/me/notifications/query' as const,
        following_contract: 'following-1' as const,
        following_url: '/api/v1/me/following' as const,
        shared_changes_contract: 'shared-changes-1' as const,
        shared_changes_url: '/api/v1/shared-changes/query' as const,
        file_text_contract: 'literal-utf8-v1' as const,
        file_search_url: '/api/v1/search/files' as const,
      };
    });
  }
  list(
    actorContext: ActorContext,
    kind:
      | 'areas'
      | 'discussions'
      | 'artifacts'
      | 'children'
      | 'ancestors'
      | 'revisions'
      | 'participants'
      | 'contacts',
    scope: string,
    options: PageOptions,
  ): Promise<PageView> {
    const pageSize = Number(options.limit ?? 12),
      budget = responseBudget(options.max_response_bytes);
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > limits.pageItems)
      throw new PublicationError('invalid_input');
    return this.run(async (tx) => {
      const actor = await lockActor(tx, actorContext);
      await structureGuard(tx);
      // Current-placement browsing explicitly restarts after organization changes;
      // a stale continuation cannot silently declare a moved population complete.
      const binding = JSON.stringify([
        identityOf(actorContext).participantId,
        kind,
        scope,
        ['areas', 'discussions', 'artifacts'].includes(kind) ? await hierarchyVersion(tx) : null,
      ]);
      const after = this.decode(binding, options.cursor);
      if (['discussions', 'artifacts'].includes(kind) && scope !== 'all')
        await lockContext(tx, scope, 'resolution', ['area']);
      if (kind === 'children' || kind === 'ancestors') await this.contributionOwner(tx, scope);
      if (kind === 'revisions') await lockContext(tx, scope, 'resolution');
      let ids: { id: string }[],
        ancestorNext: string | null = null;
      if (kind === 'ancestors') {
        let next =
          after ??
          (
            await tx.query<{ parent_id: string | null }>(
              'SELECT parent_id FROM loom.contributions WHERE id=$1',
              [scope],
            )
          ).rows[0]?.parent_id ??
          null;
        ids = [];
        for (let i = 0; next && i < limits.scanItems; i++) {
          ids.push({ id: next });
          next =
            (
              await tx.query<{ parent_id: string | null }>(
                'SELECT parent_id FROM loom.contributions WHERE id=$1',
                [next],
              )
            ).rows[0]?.parent_id ?? null;
        }
        ancestorNext = next;
      } else {
        const queries = {
          areas:
            'SELECT id FROM loom.areas WHERE ($1::uuid IS NULL OR id>$1) ORDER BY id LIMIT 101',
          participants:
            "SELECT id FROM loom.participants WHERE kind <> 'internal' AND state='active' AND ($1::uuid IS NULL OR id>$1) ORDER BY id LIMIT 101",
          contacts:
            "SELECT id FROM loom.participants WHERE kind <> 'internal' AND state='active' AND role='administrator' AND ($1::uuid IS NULL OR id>$1) ORDER BY id LIMIT 101",
          children:
            'SELECT id FROM loom.contributions WHERE parent_id=$2 AND ($1::uuid IS NULL OR (created_at,id)>((SELECT created_at FROM loom.contributions WHERE id=$1),$1::uuid)) ORDER BY created_at,id LIMIT 101',
          revisions:
            'SELECT id FROM loom.revisions WHERE resource_id=$2 AND ($1::uuid IS NULL OR id>$1) ORDER BY id LIMIT 101',
          discussions: `SELECT d.opening_id AS id FROM loom.discussions d JOIN loom.resources r ON r.id=d.id WHERE ($2::uuid IS NULL OR r.owner_resource_id=$2) AND ($1::uuid IS NULL OR d.opening_id>$1) ORDER BY d.opening_id LIMIT 101`,
          artifacts:
            'SELECT a.id FROM loom.artifacts a JOIN loom.resources r ON r.id=a.id WHERE ($2::uuid IS NULL OR r.owner_resource_id=$2) AND ($1::uuid IS NULL OR a.id>$1) ORDER BY a.id LIMIT 101',
        };
        ids = (
          await tx.query<{ id: string }>(
            queries[kind],
            ['areas', 'participants', 'contacts'].includes(kind)
              ? [after]
              : [after, scope === 'all' ? null : scope],
          )
        ).rows;
      }
      const page: PageView = {
        items: [],
        scope: `${kind}:${scope}`,
        representation: 'metadata',
        omitted_detail: 'bodies',
        next_cursor: null,
        complete: false,
        work_budget_reached: false,
        limit: pageSize,
        max_response_bytes: budget,
      };
      let last = after,
        processed = 0;
      for (const row of ids.slice(0, limits.scanItems)) {
        let item: PageView['items'][number] | undefined;
        try {
          if (kind === 'areas') {
            const chain = await lockContext(tx, row.id, 'resolution', ['area']);
            const area = (
              await tx.query<{
                id: string;
                title: string;
                description: string;
              }>('SELECT id,title,description FROM loom.areas WHERE id=$1', [row.id])
            ).rows[0]!;
            item = {
              ...area,
              publication_open: chain.every((r) => r.publication_open),
            };
          } else if (kind === 'participants' || kind === 'contacts')
            item = (
              await tx.query<{ id: string; nickname: string; kind: string }>(
                'SELECT id,nickname,kind FROM loom.participants WHERE id=$1',
                [row.id],
              )
            ).rows[0]!;
          else
            item = await this.resource(
              tx,
              actor,
              kind === 'revisions' ? scope : row.id,
              kind === 'revisions' ? row.id : undefined,
            );
        } catch (error) {
          if (!(error instanceof PublicationError) || error.code !== 'unavailable') throw error;
          if (kind === 'ancestors' || kind === 'children') {
            // Confirm owning-discussion access before exposing structural identity.
            await this.contributionOwner(tx, row.id);
            item = { resource_id: row.id, state: 'unavailable' };
          }
        }
        // Reserve enough for the encrypted continuation and all control metadata.
        if (
          item &&
          (page.items.length === pageSize ||
            Buffer.byteLength(JSON.stringify({ ...page, items: [...page.items, item] })) + 1024 >
              budget)
        )
          break;
        if (item) page.items.push(item);
        last = row.id;
        processed++;
      }
      page.complete = processed === ids.length && !ancestorNext;
      page.work_budget_reached = !page.complete && processed === limits.scanItems;
      if (!page.complete) {
        const position = kind === 'ancestors' ? (ids[processed]?.id ?? ancestorNext) : last;
        if (!position) throw new RetrievalError('response_budget_too_small');
        page.next_cursor = this.encode(binding, position);
      }
      return fit(page, budget);
    });
  }
  editors(actorContext: ActorContext, id: string) {
    return this.run(async (tx) => {
      const actor = await lockActor(tx, actorContext);
      await this.resource(tx, actor, id);
      const row = (
        await tx.query<{ editors_version: number; kind: string }>(
          'SELECT editors_version,kind FROM loom.resources WHERE id=$1',
          [id],
        )
      ).rows[0]!;
      if (row.kind !== 'artifact' && row.kind !== 'summary')
        throw new PublicationError('unavailable');
      const editors = (
        await tx.query<{ id: string; nickname: string; kind: string }>(
          'SELECT p.id,p.nickname,p.kind FROM loom.resource_editors e JOIN loom.participants p ON p.id=e.participant_id WHERE e.resource_id=$1 ORDER BY p.id LIMIT 32',
          [id],
        )
      ).rows;
      return {
        resource_id: id,
        version: row.editors_version,
        can_manage: actor.administrator,
        editors,
      };
    });
  }
}
