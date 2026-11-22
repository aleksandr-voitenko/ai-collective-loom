import { createHmac } from 'node:crypto';
import * as R from '../../../contracts/routine-updates.js';
import { decryptCursor, encryptCursor } from '../../application/encrypted-cursor.js';
import type { SqlTransaction } from '../../db/postgres.js';
import { attentionPolicy, dismissalStates, inputKey } from '../attention/controls.js';
import { unavailable } from '../following/context.js';
import { sharedMatches } from '../following/retrieval.js';
import type { PersonalNotifications } from '../notifications/retrieval.js';
import { fit } from '../participation/retrieval.js';
import { lockContext, requireRevision } from '../publication/guards.js';
import { authorizeEvent, includesPersonalReason, scanCandidates } from './candidates.js';
import { UpdatesError } from './errors.js';
import type { Bound, State } from './model.js';

type Position = { shared: string; personal: string; found: boolean; unknown: boolean };

// Bind the compact cursor to the full authenticated overview meaning. Page offsets,
// group preparation and random descriptor nonces can change within that same view.
function observationKey(state: State, bound: Bound) {
  return createHmac('sha256', state.cursor_key)
    .update(
      JSON.stringify([
        'routine-updates-observation-1',
        bound.purpose,
        bound.owner,
        bound.instance,
        bound.id,
        bound.epoch,
        bound.shared_epoch,
        bound.personal_epoch,
        bound.shared_visibility,
        bound.personal_visibility,
        bound.scope,
        bound.definitions,
        bound.reason,
        bound.selection,
        bound.policy,
        bound.shared_lower,
        bound.shared_upper,
        bound.personal_lower,
        bound.personal_upper,
        bound.shared_history,
        bound.personal_history,
        bound.baseline,
        bound.expires,
      ]),
    )
    .digest();
}

function position(key: Buffer, bound: Bound, state: State, token?: string): Position {
  if (!token)
    return {
      shared: bound.shared_upper,
      personal: bound.personal_upper,
      found: false,
      unknown: false,
    };
  try {
    const value = decryptCursor(key, token) as Position;
    if (
      Buffer.from(token, 'base64url').toString('base64url') !== token ||
      typeof value.found !== 'boolean' ||
      typeof value.unknown !== 'boolean' ||
      !(['shared', 'personal'] as const).every(
        (stream) =>
          typeof value[stream] === 'string' &&
          /^\d{1,19}$/.test(value[stream]) &&
          BigInt(value[stream]) >= BigInt(bound[`${stream}_upper`]) &&
          BigInt(value[stream]) <= BigInt(state[`${stream}_position`]),
      )
    )
      throw new Error('Invalid observation position');
    return value;
  } catch {
    throw new UpdatesError('updates_token_invalid');
  }
}

export async function observeCandidates(
  tx: SqlTransaction,
  state: State,
  bound: Bound,
  policy: Awaited<ReturnType<typeof attentionPolicy>> | undefined,
  personal: PersonalNotifications,
  settingsCurrent: boolean,
  cursor?: string,
): Promise<R.RoutineObservationView> {
  const key = observationKey(state, bound),
    from = position(key, bound, state, cursor);
  const batch = await scanCandidates(
    tx,
    bound,
    {
      shared_lower: from.shared,
      shared_upper: state.shared_position,
      personal_lower: from.personal,
      personal_upper: state.personal_position,
    },
    [],
    'observe',
  );
  const dismissed = policy
    ? await dismissalStates(tx, bound.owner, [
        ...batch.shared.map(({ id }) => ({ kind: 'shared_event' as const, id })),
        ...batch.personal.map(({ id }) => ({ kind: 'personal_delivery' as const, id })),
      ])
    : undefined;
  let { found, unknown } = from;
  for (const row of batch.shared) {
    if (row.actor_kind === 'internal') continue;
    const match = sharedMatches(row, bound.definitions);
    if (!match.unknown && !match.reasons.length) continue;
    if (dismissed?.get(inputKey({ kind: 'shared_event', id: row.id }))?.dismissed) continue;
    const mute = policy && sharedMatches(row, policy.definitions);
    if (mute?.reasons.length) continue;
    try {
      await authorizeEvent(tx, row);
      unknown ||= match.unknown || !!mute?.unknown;
      found ||= match.reasons.length > 0;
    } catch (error) {
      if (!unavailable(error)) throw error;
    }
  }
  for (const row of batch.personal) {
    if (dismissed?.get(inputKey({ kind: 'personal_delivery', id: row.id }))?.dismissed) continue;
    if (
      bound.reason !== 'all' &&
      !includesPersonalReason(bound.reason, await personal.reasons(tx, row.signal_id))
    )
      continue;
    try {
      // The full personal item uses these same owner-chain and exact-trigger guards.
      // Parent and opening previews are optional there and confer no eligibility.
      await lockContext(tx, row.resource_id, 'resolution');
      await requireRevision(tx, row.resource_id, row.revision_id);
      found = true;
    } catch (error) {
      if (!unavailable(error)) throw error;
    }
  }
  return fit(
    {
      contract_version: R.routineUpdatesContract,
      cursor: encryptCursor(key, () => ({
        shared: batch.shared_after,
        personal: batch.personal_after,
        found,
        unknown,
      })),
      new_activity: found,
      scan_complete: batch.complete,
      coverage: unknown ? 'unknown' : 'known',
      settings_current: settingsCurrent,
    },
    R.observationLimits.responseBytes,
  );
}
