import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Value } from '@sinclair/typebox/value';
import * as C from '../../../contracts/updates.js';
import * as R from '../../../contracts/routine-updates.js';
import {
  BoundDefinition,
  eventPreferences,
  type BoundDefinitionView,
} from '../../../contracts/following.js';
import { normalizeSettings } from '../following/subscriptions.js';
import { UpdatesError } from './errors.js';
import type { State, Bound, UpdatesMode } from './model.js';

const L = C.updatesLimits;
export function contractFor(mode: UpdatesMode) {
  return mode === 'routine' ? R.routineUpdatesContract : C.updatesContract;
}

export function encodeDescriptor(mode: UpdatesMode, state: State, bound: Bound) {
  const { definitions, ...rest } = bound;
  const d = definitions.map((v) => [
    v.target.kind,
    v.target.resource_id,
    v.include_descendants ? 1 : 0,
    eventPreferences.reduce((mask, p, i) => mask + (v.preferences.includes(p) ? 2 ** i : 0), 0),
    v.version,
  ]);
  const nonce = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', state.cursor_key, nonce);
  cipher.setAAD(Buffer.from(contractFor(mode)));
  const bytes = Buffer.concat([cipher.update(JSON.stringify({ ...rest, d })), cipher.final()]);
  const token = Buffer.concat([nonce, cipher.getAuthTag(), bytes]).toString('base64url');
  if (Buffer.byteLength(token) > L.tokenBytes) throw new UpdatesError('updates_capacity');
  return token;
}
export function decodeDescriptor(
  mode: UpdatesMode,
  state: State,
  token: string,
  owner: string,
): Bound {
  let bound: Bound;
  try {
    if (Buffer.byteLength(token) > L.tokenBytes) throw new Error();
    const bytes = Buffer.from(token, 'base64url'),
      cipher = createDecipheriv('aes-256-gcm', state.cursor_key, bytes.subarray(0, 12));
    cipher.setAAD(Buffer.from(contractFor(mode)));
    cipher.setAuthTag(bytes.subarray(12, 28));
    const { d, ...rest } = JSON.parse(
      Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString(),
    );
    if (!Array.isArray(d) || d.length > 64) throw new Error();
    bound = {
      ...rest,
      definitions: d.map(
        ([kind, id, desc, mask, version]: [string, string, number, number, number]) => {
          if (![0, 1].includes(desc) || !Number.isInteger(mask) || mask < 1 || mask > 127)
            throw new Error();
          return {
            target: { kind, resource_id: id },
            include_descendants: desc === 1,
            preferences: eventPreferences.filter((_, i) => mask & (2 ** i)),
            version,
          };
        },
      ),
    };
    if (
      bound.purpose !== contractFor(mode) ||
      bound.v !== 1 ||
      (mode === 'routine' && (!Number.isInteger(bound.policy) || bound.policy! < 0)) ||
      bound.owner !== owner ||
      bound.instance !== state.instance ||
      !['following', 'explicit', 'personal'].includes(bound.scope) ||
      !['all', 'mention', 'reply'].includes(bound.reason) ||
      !['prepare', 'groups', 'members', 'checkpoint'].includes(bound.kind) ||
      !['highlights', 'complete', 'direct'].includes(bound.selection) ||
      !bound.definitions.every((d) => Value.Check(BoundDefinition, d)) ||
      ![bound.shared_lower, bound.shared_upper, bound.personal_lower, bound.personal_upper].every(
        (v) => /^\d{1,19}$/.test(v),
      ) ||
      BigInt(bound.shared_lower) > BigInt(bound.shared_upper) ||
      BigInt(bound.personal_lower) > BigInt(bound.personal_upper) ||
      !Number.isInteger(bound.after) ||
      bound.after < 0 ||
      bound.after > L.members ||
      !Number.isFinite(bound.expires) ||
      !/^[a-f0-9-]{36}$/.test(bound.id) ||
      typeof bound.direct !== 'boolean' ||
      typeof bound.baseline !== 'boolean' ||
      !['retained', 'incomplete'].includes(bound.shared_history) ||
      !['retained', 'incomplete'].includes(bound.personal_history)
    )
      throw new Error();
  } catch {
    throw new UpdatesError('updates_token_invalid');
  }
  if (
    bound.epoch !== state.epoch ||
    bound.shared_epoch !== state.shared_epoch ||
    bound.personal_epoch !== state.personal_epoch
  )
    throw new UpdatesError('updates_epoch_changed');
  return bound;
}
export function checkContinuity(state: State, saved: Bound, action?: string) {
  if (
    (saved.shared_visibility !== state.shared_visibility ||
      saved.personal_visibility !== state.personal_visibility) &&
    !['replay', 'resynchronize'].includes(action ?? '')
  )
    throw new UpdatesError('updates_visibility_replay_required');
  for (const component of ['shared', 'personal'] as const) {
    const floor = BigInt(state[`${component}_floor`]);
    if (
      action !== 'resynchronize' &&
      ((action === 'replay' && floor > 0n) ||
        BigInt(
          saved.kind === 'checkpoint' ? saved[`${component}_upper`] : saved[`${component}_lower`],
        ) < floor ||
        BigInt(saved[`${component}_upper`]) > BigInt(state[`${component}_position`]))
    )
      throw new UpdatesError(
        component === 'shared' ? 'updates_shared_history_gap' : 'updates_personal_history_gap',
      );
  }
  if (saved.kind !== 'checkpoint' && saved.expires <= Date.now() && !action)
    throw new UpdatesError('updates_descriptor_expired');
}

// Continuity has already passed; these checks precede the current Following read.
export function queryBinding(
  options: C.UpdatesOptions | R.RoutineOptions,
  saved: Bound | undefined,
) {
  const action = options.recovery?.action;
  if (action === 'attention_refresh' && (!saved || saved.kind === 'checkpoint'))
    throw new UpdatesError('updates_token_invalid');
  if (
    (options.checkpoint && saved?.kind !== 'checkpoint') ||
    (options.cursor && (!saved || !['groups', 'prepare'].includes(saved.kind))) ||
    (options.switch && saved?.kind === 'checkpoint') ||
    (action === 'renew' && saved?.kind === 'checkpoint')
  )
    throw new UpdatesError('updates_token_invalid');
  const scope = saved?.scope ?? options.scope?.kind ?? 'following',
    reason = saved?.reason ?? options.reason ?? 'all';
  if (
    saved &&
    ((options.reason && options.reason !== saved.reason) ||
      (options.selection && options.selection !== saved.selection) ||
      (options.scope &&
        (options.scope.kind !== saved.scope ||
          (options.scope.kind === 'explicit' &&
            JSON.stringify(normalizeSettings(options.scope.definition)) !==
              JSON.stringify((({ version: _, ...s }) => s)(saved.definitions[0]!))))))
  )
    throw new UpdatesError('updates_token_invalid');
  return { scope, reason };
}

// Current Following is read between query binding and these interval checks.
export function intervalBinding(
  state: State,
  options: C.UpdatesOptions | R.RoutineOptions,
  saved: Bound | undefined,
  current: BoundDefinitionView[] | undefined,
  scope: Bound['scope'],
  action: string | undefined,
) {
  const definitions =
    saved?.definitions ??
    current ??
    (scope === 'personal'
      ? []
      : [
          {
            ...normalizeSettings(
              (
                options.scope as Extract<
                  NonNullable<C.UpdatesOptions['scope']>,
                  { kind: 'explicit' }
                >
              ).definition,
            ),
            version: 0,
          },
        ]);
  const settingsCurrent = !current || JSON.stringify(current) === JSON.stringify(definitions);
  if (
    saved?.kind === 'checkpoint' &&
    !settingsCurrent &&
    action !== 'replay' &&
    action !== 'resynchronize'
  )
    throw new UpdatesError('updates_definition_changed');
  if (!saved && action !== 'resynchronize') {
    if (state.shared_floor !== '0') throw new UpdatesError('updates_shared_history_gap');
    if (state.personal_floor !== '0') throw new UpdatesError('updates_personal_history_gap');
  }
  const fresh =
    !saved || saved.kind === 'checkpoint' || action === 'replay' || action === 'resynchronize';
  const resync = action === 'resynchronize',
    replay = action === 'replay';
  return { definitions, settingsCurrent, fresh, resync, replay };
}

// The fresh-only caller samples ID and expiry after definitions, never on resume.
export function newBound({
  mode,
  state,
  owner,
  options,
  saved,
  policy,
  scope,
  reason,
  definitions,
  id,
  expires,
  action,
}: {
  mode: UpdatesMode;
  state: State;
  owner: string;
  options: C.UpdatesOptions | R.RoutineOptions;
  saved: Bound | undefined;
  policy: number | undefined;
  scope: Bound['scope'];
  reason: Bound['reason'];
  definitions: BoundDefinitionView[];
  id: string;
  expires: number;
  action: string | undefined;
}): Bound {
  const resync = action === 'resynchronize',
    replay = action === 'replay';
  return {
    purpose: contractFor(mode),
    ...(mode === 'routine' ? { policy: policy! } : {}),
    v: 1,
    owner,
    instance: state.instance,
    epoch: state.epoch,
    shared_epoch: state.shared_epoch,
    personal_epoch: state.personal_epoch,
    shared_visibility: state.shared_visibility,
    personal_visibility: state.personal_visibility,
    id,
    scope,
    definitions,
    reason,
    shared_lower: resync ? state.shared_position : replay ? '0' : (saved?.shared_upper ?? '0'),
    shared_upper: state.shared_position,
    personal_lower: resync
      ? state.personal_position
      : replay
        ? '0'
        : (saved?.personal_upper ?? '0'),
    personal_upper: state.personal_position,
    shared_history: resync ? 'incomplete' : (saved?.shared_history ?? 'retained'),
    personal_history: resync ? 'incomplete' : (saved?.personal_history ?? 'retained'),
    kind: 'prepare',
    selection: options.selection ?? saved?.selection ?? 'highlights',
    after: 0,
    group: null,
    direct: false,
    expires,
    baseline: resync,
  };
}
