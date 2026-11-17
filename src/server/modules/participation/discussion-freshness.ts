import { Value } from '@sinclair/typebox/value';
import { decryptCursor, encryptCursor } from '../../application/encrypted-cursor.js';
import type { SqlTransaction, Transactions } from '../../db/postgres.js';
import * as C from '../../../contracts/discussion-freshness.js';
import type { ActorContext } from '../publication/actor.js';
import { lockActor, lockContext, requireRevision } from '../publication/guards.js';
import { PublicationError, safeError } from '../publication/errors.js';
import { RetrievalError } from './retrieval.js';

type State = {
  cursor_key: Buffer;
  instance_id: string;
  recovery_epoch: string;
  retained_after: string;
  position: string;
  visibility_version: string;
};
type Cursor = {
  purpose: typeof C.freshnessContract;
  owner: string;
  instance: string;
  epoch: string;
  discussion: string;
  after: string;
  visibility_after: string;
};
type EventRow = {
  position: string;
  kind: string;
  resource_id: string;
  revision_id: string | null;
  publisher_id: string;
  parent_id: string | null;
  discussion_id: string | null;
  revision_number: string | null;
  affected_target_ids: string[] | null;
};
type VisibilityRow = { visibility_version: string; resource_id: string; discussion_id: string };

export class DiscussionFreshness {
  constructor(private readonly database: Transactions) {}

  private async state(tx: SqlTransaction): Promise<State> {
    const state = (
      await tx.query<State>(
        `SELECT s.cursor_key,s.recovery_epoch::text,c.instance_id::text,
        s.retained_after::text,s.visibility_version::text,k.shared_position::text AS position
       FROM loom.shared_retrieval_state s CROSS JOIN loom.community_settings c
       CROSS JOIN loom.community_clocks k WHERE s.id=1 AND c.id=1 AND k.id=1`,
        [],
      )
    ).rows[0];
    if (!state) throw new PublicationError('service_unavailable');
    return state;
  }

  private token(
    state: State,
    owner: string,
    discussion: string,
    after: string,
    visibilityAfter: string,
  ) {
    return encryptCursor(
      state.cursor_key,
      () =>
        ({
          purpose: C.freshnessContract,
          owner,
          instance: state.instance_id,
          epoch: state.recovery_epoch,
          discussion,
          after,
          visibility_after: visibilityAfter,
        }) satisfies Cursor,
    );
  }

  private after(state: State, owner: string, discussion: string, token: string): Cursor {
    try {
      const value = decryptCursor(state.cursor_key, token) as Cursor;
      if (
        value.purpose !== C.freshnessContract ||
        value.owner !== owner ||
        value.instance !== state.instance_id ||
        value.epoch !== state.recovery_epoch ||
        value.discussion !== discussion ||
        !/^\d{1,19}$/.test(value.after) ||
        !/^\d{1,19}$/.test(value.visibility_after) ||
        BigInt(value.after) > BigInt(state.position) ||
        BigInt(value.visibility_after) > BigInt(state.visibility_version) ||
        BigInt(value.after) < BigInt(state.retained_after)
      )
        throw new Error('Invalid discussion cursor');
      return value;
    } catch {
      throw new RetrievalError('invalid_cursor');
    }
  }

  async query(
    actorContext: ActorContext,
    discussion: string,
    input: C.FreshnessInputView,
  ): Promise<C.FreshnessView> {
    if (!Value.Check(C.FreshnessInput, input)) throw new PublicationError('invalid_input');
    try {
      return await this.database.transaction(async (tx) => {
        const actor = await lockActor(tx, actorContext);
        await lockContext(tx, discussion, 'resolution', ['discussion']);
        const opening = (
          await tx.query<{ opening_id: string }>(
            'SELECT opening_id FROM loom.discussions WHERE id=$1',
            [discussion],
          )
        ).rows[0]?.opening_id;
        if (!opening) throw new PublicationError('unavailable');
        const state = await this.state(tx);
        if (input.action === 'baseline')
          return {
            contract: C.freshnessContract,
            cursor: this.token(
              state,
              actor.participantId,
              discussion,
              state.position,
              state.visibility_version,
            ),
            complete: true,
            scanned: 0,
            visibility_scanned: 0,
            events: [],
            displayed: [],
          };
        const after = this.after(state, actor.participantId, discussion, input.cursor);
        if (
          new Set(input.parents.map((id) => id.toLowerCase())).size !== input.parents.length ||
          new Set(input.displayed.map((item) => item.resource_id.toLowerCase())).size !==
            input.displayed.length
        )
          throw new PublicationError('invalid_input');
        const parents = input.parents.map((id) => id.toLowerCase()).sort();
        const displayed = input.displayed
          .map((item) => ({
            resource_id: item.resource_id.toLowerCase(),
            revision_id: item.revision_id.toLowerCase(),
          }))
          .sort((a, b) => a.resource_id.localeCompare(b.resource_id));
        // position has a unique B-tree index. LIMIT bounds database event work even
        // when unrelated discussions dominate the shared stream.
        const rows = (
          await tx.query<EventRow>(
            `SELECT e.position::text,e.kind,e.resource_id,e.revision_id,e.publisher_id,
            c.parent_id,c.discussion_id,v.revision_number::text,e.affected_target_ids
           FROM loom.shared_activity e
           LEFT JOIN loom.contributions c ON c.id=e.resource_id
           LEFT JOIN loom.revisions v ON v.id=e.revision_id
           WHERE e.position>$1::bigint AND e.position<=$2::bigint
           ORDER BY e.position LIMIT $3`,
            [after.after, state.position, C.freshnessLimits.events + 1],
          )
        ).rows;
        const scanned = rows.slice(0, C.freshnessLimits.events);
        const visibilityRows = (
          await tx.query<VisibilityRow>(
            `SELECT visibility_version::text,resource_id,discussion_id
             FROM loom.discussion_freshness_visibility
             WHERE visibility_version>$1::bigint AND visibility_version<=$2::bigint
             ORDER BY visibility_version LIMIT $3`,
            [after.visibility_after, state.visibility_version, C.freshnessLimits.visibility + 1],
          )
        ).rows;
        const visibilityScanned = visibilityRows.slice(0, C.freshnessLimits.visibility);
        const local = (row: EventRow) =>
          row.discussion_id === discussion ||
          (row.kind === 'organization.changed' &&
            (row.resource_id === discussion || row.affected_target_ids?.includes(discussion)));
        const eventResources = scanned
          .filter((row) => local(row) && row.kind === 'revision.published')
          .map((row) => row.resource_id);
        const visibilityResources = visibilityScanned
          .filter((row) => row.discussion_id === discussion)
          .map((row) => row.resource_id);
        const locked = new Map<string, boolean>();
        // Parent watches are structural. A suppressed parent still scopes eligible children.
        for (const id of [
          ...new Set([
            ...parents,
            ...displayed.map((item) => item.resource_id),
            ...eventResources,
            ...visibilityResources,
          ]),
        ].sort()) {
          const chain = await lockContext(tx, id, 'reply-traversal', ['contribution']);
          locked.set(id, chain[0]!.state === 'active');
          if (!parents.includes(id) && !displayed.some((item) => item.resource_id === id)) continue;
          const row = (
            await tx.query<{ discussion_id: string }>(
              'SELECT discussion_id FROM loom.contributions WHERE id=$1',
              [id],
            )
          ).rows[0];
          if (row?.discussion_id !== discussion) throw new PublicationError('invalid_input');
        }
        const statuses: C.FreshnessView['displayed'] = [];
        for (const item of displayed) {
          if (
            !(
              await tx.query('SELECT id FROM loom.revisions WHERE id=$1 AND resource_id=$2', [
                item.revision_id,
                item.resource_id,
              ])
            ).rowCount
          )
            throw new PublicationError('invalid_input');
          const resource = (
            await tx.query<{
              state: string;
              current_revision_id: string | null;
              current_available: boolean;
              displayed_available: boolean;
            }>(
              `SELECT r.state,r.current_revision_id,
             EXISTS(SELECT 1 FROM loom.revisions v WHERE v.id=r.current_revision_id AND v.availability='available') AS current_available,
             EXISTS(SELECT 1 FROM loom.revisions v WHERE v.id=$2 AND v.resource_id=r.id AND v.availability='available') AS displayed_available
             FROM loom.resources r WHERE r.id=$1`,
              [item.resource_id, item.revision_id],
            )
          ).rows[0]!;
          const available = resource.state === 'active' && resource.displayed_available;
          statuses.push({
            ...item,
            state: available ? 'available' : 'unavailable',
            current_revision_id:
              resource.state === 'active' && resource.current_available
                ? resource.current_revision_id
                : null,
          });
        }
        const events: C.FreshnessView['events'] = [];
        for (const row of scanned) {
          if (!local(row)) continue;
          if (row.kind === 'organization.changed') {
            events.push({
              position: row.position,
              kind: 'discussion',
              own: row.publisher_id === actor.participantId,
            });
            continue;
          }
          // The event is an observation, not an access grant. Only currently
          // eligible revisions may disclose their resource and parent IDs.
          if (!locked.get(row.resource_id)) continue;
          try {
            await requireRevision(tx, row.resource_id, row.revision_id!);
          } catch (error) {
            if (error instanceof PublicationError && error.code === 'unavailable') continue;
            throw error;
          }
          events.push({
            position: row.position,
            kind:
              row.revision_number === '1'
                ? row.parent_id === opening
                  ? 'new_root'
                  : 'new_reply'
                : 'revision',
            resource_id: row.resource_id,
            ...(row.parent_id ? { parent_id: row.parent_id } : {}),
            ...(row.revision_id ? { revision_id: row.revision_id } : {}),
            own: row.publisher_id === actor.participantId,
          });
        }
        for (const row of visibilityScanned) {
          if (row.discussion_id !== discussion || !locked.get(row.resource_id)) continue;
          const current = (
            await tx.query<{ revision_id: string | null; parent_id: string | null }>(
              `SELECT r.current_revision_id AS revision_id,c.parent_id
               FROM loom.resources r JOIN loom.contributions c ON c.id=r.id WHERE r.id=$1`,
              [row.resource_id],
            )
          ).rows[0];
          if (!current?.revision_id) continue;
          try {
            await requireRevision(tx, row.resource_id, current.revision_id);
          } catch (error) {
            if (error instanceof PublicationError && error.code === 'unavailable') continue;
            throw error;
          }
          events.push({
            position: row.visibility_version,
            kind: 'availability',
            resource_id: row.resource_id,
            ...(current.parent_id ? { parent_id: current.parent_id } : {}),
            revision_id: current.revision_id,
            own: false,
          });
        }
        const last = scanned.at(-1)?.position ?? after.after;
        const visibilityLast =
          visibilityScanned.at(-1)?.visibility_version ?? after.visibility_after;
        return {
          contract: C.freshnessContract,
          cursor: this.token(
            state,
            actor.participantId,
            discussion,
            rows.length > C.freshnessLimits.events ? last : state.position,
            visibilityRows.length > C.freshnessLimits.visibility
              ? visibilityLast
              : state.visibility_version,
          ),
          complete:
            rows.length <= C.freshnessLimits.events &&
            visibilityRows.length <= C.freshnessLimits.visibility,
          scanned: scanned.length,
          visibility_scanned: visibilityScanned.length,
          events,
          displayed: statuses,
        };
      });
    } catch (error) {
      if (error instanceof RetrievalError) throw error;
      return safeError(error);
    }
  }
}
