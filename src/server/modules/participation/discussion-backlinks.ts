import { randomBytes, createHash } from 'node:crypto';
import { Value } from '@sinclair/typebox/value';
import { encryptCursor, decryptCursor } from '../../application/encrypted-cursor.js';
import type { Transactions } from '../../db/postgres.js';
import type { ActorContext } from '../publication/actor.js';
import { lockActor } from '../publication/guards.js';
import { PublicationError, safeError } from '../publication/errors.js';
import { lockReferencePlan, referenceTarget } from './reference-context.js';
import { ReferenceError, referenceBoundary } from './references.js';
import { ParticipationRetrieval, RetrievalError, responseBudget, fit } from './retrieval.js';
import { discussionLinkLimits } from '../../../contracts/discussion-links.js';
import {
  ReferencePageInput,
  referenceLimits,
  type ReferencePageOptions,
  type DiscussionBacklinkPageView,
  type DiscussionBacklinkView,
} from '../../../contracts/references.js';
import type { ReferenceTargetValue } from '../../../contracts/participation.js';

type Membership = {
  source_id: string;
  revision_id: string;
  target_kind: ReferenceTargetValue['kind'];
  target_id: string;
  target_revision_id: string | null;
  target_file_id: string | null;
  target_path: string | null;
  destination: string;
};
type Cursor = { binding: string; boundary: string; after: string; expires: number };

/** Direct current-revision navigation evidence, never an authored assertion. */
export class DiscussionBacklinks {
  private readonly key = randomBytes(32);
  private readonly reads: ParticipationRetrieval;
  constructor(private readonly database: Transactions) {
    this.reads = new ParticipationRetrieval(database);
  }
  private encode(value: Cursor) {
    return encryptCursor(this.key, () => value);
  }
  private decode(value: string): Cursor {
    try {
      if (Buffer.byteLength(value) > referenceLimits.cursorBytes) throw new Error();
      const saved = decryptCursor(this.key, value) as Cursor;
      if (
        !Number.isFinite(saved.expires) ||
        saved.expires <= Date.now() ||
        !/^[0-9a-f-]{36}$/.test(saved.after)
      )
        throw new Error();
      return saved;
    } catch {
      throw new ReferenceError('references_changed');
    }
  }
  async incoming(actorContext: ActorContext, discussion: string, options: ReferencePageOptions) {
    if (!Value.Check(ReferencePageInput, options)) throw new PublicationError('invalid_input');
    const budget = responseBudget(options.max_response_bytes),
      limit = Number(options.limit ?? 12);
    try {
      return await this.database.transaction(async (tx) => {
        await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ', []);
        await tx.query("SET LOCAL statement_timeout='2500ms'", []);
        const actor = await lockActor(tx, actorContext),
          state = await referenceBoundary(tx);
        const binding = createHash('sha256')
          .update(JSON.stringify([actor.participantId, discussion, 'inferred_markdown_link']))
          .digest('hex');
        const saved = options.cursor ? this.decode(options.cursor) : undefined;
        if (saved && (saved.binding !== binding || saved.boundary !== state))
          throw new ReferenceError('references_changed');
        const after = saved?.after ?? null,
          expires = saved?.expires ?? Date.now() + referenceLimits.cursorSeconds * 1000;
        // Obsolete memberships do not consume the current-source page budget.
        // Selection is not authority: recheck pointers and visibility under the
        // complete sorted resource guards below, within this same snapshot.
        const candidates = (
          await tx.query<{ source_id: string; revision_id: string }>(
            `SELECT l.source_id,l.revision_id FROM loom.revision_discussion_links l
           JOIN loom.resources s ON s.id=l.source_id AND s.current_revision_id=l.revision_id
           WHERE l.discussion_id=$1 AND ($2::uuid IS NULL OR l.revision_id>$2)
           GROUP BY l.revision_id,l.source_id ORDER BY l.revision_id,l.source_id LIMIT $3`,
            [discussion, after, discussionLinkLimits.scan + 1],
          )
        ).rows;
        const selected = candidates.slice(0, discussionLinkLimits.scan);
        const memberships = (
          await tx.query<Membership>(
            `SELECT * FROM loom.revision_discussion_links WHERE discussion_id=$1 AND revision_id=ANY($2::uuid[])
           ORDER BY revision_id,destination LIMIT $3`,
            [
              discussion,
              selected.map((row) => row.revision_id),
              discussionLinkLimits.scan * discussionLinkLimits.destinations,
            ],
          )
        ).rows;
        const contexts = (
          await tx.query<{ source_id: string; discussion_id: string; opening_id: string }>(
            `SELECT c.id AS source_id,c.discussion_id,d.opening_id FROM loom.contributions c
           JOIN loom.discussions d ON d.id=c.discussion_id WHERE c.id=ANY($1::uuid[])`,
            [selected.map((row) => row.source_id)],
          )
        ).rows;
        await lockReferencePlan(tx, [
          discussion,
          ...selected.map((row) => row.source_id),
          ...memberships.map((row) => row.target_id),
          ...contexts.map((row) => row.opening_id),
        ]);
        // Target authority is required even for empty pages and continuations.
        await referenceTarget(tx, { kind: 'discussion', resource_id: discussion });
        const page: DiscussionBacklinkPageView = {
          items: [],
          provenance: 'inferred_markdown_link',
          discussion_id: discussion,
          order: 'source_revision_uuid',
          next_cursor: null,
          complete: false,
          work_budget_reached: false,
          limit,
          max_response_bytes: budget,
          expires_at: new Date(expires).toISOString(),
        };
        let consumed = 0,
          last = after;
        for (const candidate of selected) {
          let entry: DiscussionBacklinkView | undefined;
          try {
            const current = (
              await tx.query<{ current_revision_id: string | null }>(
                'SELECT current_revision_id FROM loom.resources WHERE id=$1',
                [candidate.source_id],
              )
            ).rows[0]?.current_revision_id;
            if (current === candidate.revision_id) {
              const source = await this.reads.resource(
                tx,
                actor,
                candidate.source_id,
                candidate.revision_id,
              );
              const destinations: DiscussionBacklinkView['destinations'] = [];
              for (const row of memberships.filter(
                (row) => row.revision_id === candidate.revision_id,
              )) {
                const target: ReferenceTargetValue = {
                  kind: row.target_kind,
                  resource_id: row.target_id,
                  ...(row.target_revision_id ? { revision_id: row.target_revision_id } : {}),
                  ...(row.target_file_id
                    ? { file_id: row.target_file_id, path: row.target_path! }
                    : {}),
                };
                try {
                  await referenceTarget(tx, target);
                  const { path: _path, ...identity } = target;
                  destinations.push({ target: identity, browser_url: row.destination });
                } catch (error) {
                  if (!(error instanceof PublicationError) || error.code !== 'unavailable')
                    throw error;
                }
              }
              if (destinations.length) {
                const context = contexts.find((row) => row.source_id === source.resource_id)!;
                let title: string | null = null;
                // Reply parentage is not ownership: a hidden opening revision
                // withholds its title without hiding independently eligible replies.
                try {
                  title = (await this.reads.resource(tx, actor, context.opening_id)).title;
                } catch (error) {
                  if (!(error instanceof PublicationError) || error.code !== 'unavailable')
                    throw error;
                }
                entry = {
                  source,
                  discussion_id: context.discussion_id,
                  discussion_title: title,
                  source_browser_url: `/loom/resource/${source.resource_id}/${source.revision_id}`,
                  source_context_url: `/loom/discussion/${context.discussion_id}?focus=${source.resource_id}`,
                  destinations,
                };
              }
            }
          } catch (error) {
            if (!(error instanceof PublicationError) || error.code !== 'unavailable') throw error;
          }
          if (entry) {
            const preview = {
              ...page,
              items: [...page.items, entry],
              next_cursor: this.encode({
                binding,
                boundary: state,
                after: candidate.revision_id,
                expires,
              }),
            };
            if (
              page.items.length === limit ||
              Buffer.byteLength(JSON.stringify(preview)) > budget
            ) {
              if (!page.items.length) fit(preview, budget);
              break;
            }
            page.items.push(entry);
          }
          consumed++;
          last = candidate.revision_id;
        }
        page.complete = consumed === candidates.length;
        page.work_budget_reached = !page.complete && consumed === discussionLinkLimits.scan;
        if (!page.complete)
          page.next_cursor = this.encode({ binding, boundary: state, after: last!, expires });
        return fit(page, budget);
      });
    } catch (error) {
      if (error instanceof ReferenceError || error instanceof RetrievalError) throw error;
      const code = (error as { code?: string })?.code;
      if (['40001', '40P01', '55P03'].includes(code ?? ''))
        throw new ReferenceError('references_changed');
      if (code === '57014') throw new ReferenceError('reference_work_limit');
      return safeError(error);
    }
  }
}
