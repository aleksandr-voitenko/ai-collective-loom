import { createHmac } from 'node:crypto';
import type { SqlTransaction } from '../../db/postgres.js';
import { PublicationError } from '../publication/errors.js';

type ObservationState = {
  cursor_key: Buffer;
  instance_id: string;
  recovery_epoch: string;
  retained_after: string;
  position: string;
  visibility_version: string;
};

export async function topicObservationState(tx: SqlTransaction) {
  const state = (
    await tx.query<ObservationState>(
      `SELECT s.cursor_key,s.recovery_epoch::text,c.instance_id::text,s.retained_after::text,
         s.visibility_version::text,k.shared_position::text AS position
       FROM loom.shared_retrieval_state s CROSS JOIN loom.community_settings c
       CROSS JOIN loom.community_clocks k WHERE s.id=1 AND c.id=1 AND k.id=1`,
      [],
    )
  ).rows[0];
  if (!state) throw new PublicationError('service_unavailable');
  return state;
}

export function topicWithdrawalTag(
  state: ObservationState,
  owner: string,
  topic: string,
  opening: string,
  revision: string | null,
) {
  return createHmac('sha256', state.cursor_key)
    .update(
      JSON.stringify([
        'topic-discussion-withdrawal-1',
        state.instance_id,
        state.recovery_epoch,
        owner,
        topic,
        opening,
        revision,
      ]),
    )
    .digest('base64url');
}
