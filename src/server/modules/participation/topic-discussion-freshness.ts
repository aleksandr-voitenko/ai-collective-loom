import { randomBytes, randomUUID } from 'node:crypto';
import { Value } from '@sinclair/typebox/value';
import * as C from '../../../contracts/topic-discussion-freshness.js';
import { decryptCursor, encryptCursor } from '../../application/encrypted-cursor.js';
import type { SqlTransaction, Transactions } from '../../db/postgres.js';
import type { ActorContext } from '../publication/actor.js';
import { PublicationError, safeError } from '../publication/errors.js';
import { lockActor, lockContext } from '../publication/guards.js';
import { fit, RetrievalError } from './retrieval.js';
import { topicObservationState, topicWithdrawalTag } from './topic-discussion-observation.js';

type EventRow = {
  position: string;
  opening_id: string;
  effect: 'created' | 'revised' | 'arrived' | 'departed';
};
type VisibilityRow = {
  position: string;
  area_id: string;
  opening_id: string;
  revision_id: string | null;
};
type Source = {
  opening_id: string;
  area_id: string;
  current_revision_id: string | null;
  current_available: boolean;
};
type Position = { after: string; visibility_after: string };
type State = Awaited<ReturnType<typeof topicObservationState>>;

function decode(state: State, binding: string, token: string): Position {
  try {
    if (Buffer.from(token, 'base64url').toString('base64url') !== token) throw new Error();
    const value = decryptCursor(state.cursor_key, token) as Position & { binding: string };
    if (
      value.binding !== binding ||
      !/^\d{1,19}$/.test(value.after) ||
      !/^\d{1,19}$/.test(value.visibility_after) ||
      BigInt(value.after) < BigInt(state.retained_after) ||
      BigInt(value.after) > BigInt(state.position) ||
      BigInt(value.visibility_after) > BigInt(state.visibility_version)
    )
      throw new Error('Invalid topic observation position');
    return value;
  } catch {
    throw new RetrievalError('invalid_cursor');
  }
}

async function observedSources(tx: SqlTransaction, openings: string[], revisions: string[]) {
  // The selected topic lock already holds the shared structure guard. Every
  // lookup is correlated to one exact ID, including ancestors and rows that
  // moved since their event. This keeps recursive joins from scanning unrelated
  // resources. Use one snapshot for source and revision availability.
  const { rows } = await tx.query<{
    sources: Source[];
    revisions: { id: string; resource_id: string }[];
  }>(
    `WITH RECURSIVE sources AS (
       SELECT o.id AS opening_id,o.owner_resource_id AS parent,o.current_revision_id,
              NULL::uuid AS area_id,1 AS depth
       FROM unnest($1::uuid[]) AS candidate(id)
       CROSS JOIN LATERAL (
         SELECT id,owner_resource_id,current_revision_id FROM loom.resources
         WHERE id=candidate.id AND kind='contribution' AND state='active' LIMIT 1
       ) o
       CROSS JOIN LATERAL (
         SELECT 1 FROM loom.discussions d WHERE d.id=o.owner_resource_id AND d.opening_id=o.id LIMIT 1
       ) opening
       UNION ALL
       SELECT s.opening_id,r.owner_resource_id,s.current_revision_id,
              CASE WHEN s.depth=2 THEN r.id ELSE s.area_id END,s.depth+1
       FROM sources s
       CROSS JOIN LATERAL (
         SELECT id,owner_resource_id FROM loom.resources
         WHERE id=s.parent AND state='active'
           AND kind=(CASE WHEN s.depth=1 THEN 'discussion' ELSE 'area' END) LIMIT 1
       ) r
       WHERE s.depth<32
     ), eligible AS (
       SELECT opening_id,area_id,current_revision_id,
              (SELECT true FROM loom.revisions v WHERE v.id=s.current_revision_id
                AND v.resource_id=s.opening_id AND v.availability='available' LIMIT 1) IS TRUE AS current_available
       FROM sources s WHERE parent IS NULL AND area_id IS NOT NULL
     )
     SELECT coalesce((SELECT jsonb_agg(e) FROM eligible e),'[]'::jsonb) AS sources,
            coalesce((SELECT jsonb_agg(jsonb_build_object('id',v.id,'resource_id',v.resource_id))
              FROM unnest($2::uuid[]) AS candidate(id)
              CROSS JOIN LATERAL (
                SELECT id,resource_id FROM loom.revisions
                WHERE id=candidate.id AND availability='available' LIMIT 1
              ) v),
              '[]'::jsonb) AS revisions`,
    [openings, revisions],
  );
  return {
    sources: new Map(rows[0]!.sources.map((row) => [row.opening_id, row])),
    revisions: new Map(rows[0]!.revisions.map(({ id, resource_id }) => [id, resource_id])),
  };
}

export class TopicDiscussionFreshness {
  // A restored database can eventually reuse numerical positions from the
  // discarded history. An old runtime cannot observe through that boundary.
  private readonly runtime = randomUUID();
  constructor(private readonly database: Transactions) {}

  async query(
    actorContext: ActorContext,
    topic: string,
    input: C.TopicFreshnessInputView,
  ): Promise<C.TopicFreshnessView | C.TopicFreshnessAuditView> {
    if (!Value.Check(C.TopicFreshnessInput, input)) throw new PublicationError('invalid_input');
    try {
      return await this.database.transaction(async (tx) => {
        await tx.query(
          "SELECT set_config('statement_timeout','2500ms',true),set_config('lock_timeout','1500ms',true),set_config('transaction_timeout','5000ms',true)",
          [],
        );
        const actor = await lockActor(tx, actorContext);
        await lockContext(tx, topic, 'resolution', ['area']);
        const state = await topicObservationState(tx);
        const tag = (opening: string, revision: string | null) =>
          topicWithdrawalTag(state, actor.participantId, topic, opening, revision);
        if (input.action === 'audit') {
          const displayed = input.displayed.map(({ resource_id, revision_id }) => ({
            resource_id: resource_id.toLowerCase(),
            revision_id: revision_id.toLowerCase(),
          }));
          const available = await observedSources(
            tx,
            displayed.map(({ resource_id }) => resource_id),
            displayed.map(({ revision_id }) => revision_id),
          );
          const tags: C.TopicFreshnessAuditView['tags'] = displayed.map(
            ({ resource_id, revision_id }) =>
              available.sources.has(resource_id) &&
              available.revisions.get(revision_id) === resource_id
                ? [tag(resource_id, null), tag(resource_id, revision_id)]
                : null,
          );
          return fit(
            {
              unavailable: tags.flatMap((tags, index) => (tags ? [] : [index])),
              tags,
            },
            C.topicFreshnessLimits.responseBytes,
          );
        }
        const binding = JSON.stringify([
          C.topicFreshnessContract,
          this.runtime,
          state.instance_id,
          state.recovery_epoch,
          actor.participantId,
          topic,
        ]);
        const result: C.TopicFreshnessView = {
          contract: C.topicFreshnessContract,
          cursor: '',
          complete: true,
          scanned: 0,
          visibility_scanned: 0,
          change: 'none',
          withdrawn_tags: [],
        };
        const next: Position = {
          after: state.position,
          visibility_after: state.visibility_version,
        };
        if (input.action === 'check') {
          const from = decode(state, binding, input.cursor);
          const activity = (
            await tx.query<EventRow>(
              `SELECT a.position::text,a.opening_id,a.effect FROM loom.topic_discussion_activity a
               WHERE a.area_id=$1 AND a.position>$2::bigint AND a.position<=$3::bigint
               ORDER BY a.position LIMIT $4`,
              [topic, from.after, state.position, C.topicFreshnessLimits.events + 1],
            )
          ).rows;
          const visibility = (
            await tx.query<VisibilityRow>(
              `SELECT v.visibility_version::text AS position,v.area_id,v.opening_id,v.revision_id
               FROM loom.topic_discussion_visibility v
               WHERE v.visibility_version>$1::bigint AND v.visibility_version<=$2::bigint
               ORDER BY v.visibility_version LIMIT $3`,
              [
                from.visibility_after,
                state.visibility_version,
                C.topicFreshnessLimits.visibility + 1,
              ],
            )
          ).rows;
          const events = activity.slice(0, C.topicFreshnessLimits.events);
          const transitions = visibility.slice(0, C.topicFreshnessLimits.visibility);
          result.scanned = events.length;
          result.visibility_scanned = transitions.length;
          if (activity.length > events.length) next.after = events.at(-1)!.position;
          if (visibility.length > transitions.length)
            next.visibility_after = transitions.at(-1)!.position;
          result.complete =
            activity.length === events.length && visibility.length === transitions.length;
          if (events.length || transitions.length) {
            const available = await observedSources(
              tx,
              [...new Set([...events, ...transitions].map(({ opening_id }) => opening_id))],
              transitions.flatMap(({ revision_id }) => (revision_id ? [revision_id] : [])),
            );
            for (const event of events) {
              const source = available.sources.get(event.opening_id);
              // A direct departure can raise a generic notice in its former
              // topic even when the destination source is unavailable.
              if (
                event.effect !== 'departed' &&
                (!source?.current_available || source.area_id !== topic)
              )
                continue;
              if (event.effect === 'created') result.change = 'new_discussions';
              else if (result.change === 'none') result.change = 'updated';
            }
            for (const { area_id, opening_id, revision_id } of transitions) {
              const source = available.sources.get(opening_id);
              const lost =
                !source || (revision_id && available.revisions.get(revision_id) !== opening_id);
              // All slots are opaque and exactly one per candidate. Loss of a
              // source yields a match only for a previously authorized row.
              result.withdrawn_tags.push(
                lost
                  ? tag(opening_id, source ? revision_id : null)
                  : randomBytes(32).toString('base64url'),
              );
              if (
                result.change === 'none' &&
                ((lost &&
                  area_id === topic &&
                  (!source || revision_id === source.current_revision_id)) ||
                  (source?.area_id === topic &&
                    source.current_available &&
                    (!revision_id || revision_id === source.current_revision_id)))
              )
                result.change = 'updated';
            }
          }
        }
        result.cursor = encryptCursor(state.cursor_key, () => ({ binding, ...next }));
        return fit(result, C.topicFreshnessLimits.responseBytes);
      });
    } catch (error) {
      if (error instanceof RetrievalError) throw error;
      return safeError(error);
    }
  }
}
