import { Type, type Static } from '@sinclair/typebox';
import { closed } from './participation.js';
import * as U from './updates.js';
import { Version } from './attention.js';

export const routineUpdatesContract = 'combined-updates-2';
const viewToken = { minLength: 1, maxLength: U.updatesLimits.tokenBytes };
export const observationLimits = Object.freeze({ tokenBytes: 512, responseBytes: 1024 });
const observationCursor = {
  pattern: '^[A-Za-z0-9_-]+$',
  maxLength: observationLimits.tokenBytes,
};
export const RoutineObservationQuery = Type.Object(
  {
    view: Type.String({
      ...viewToken,
      description: 'The accepted routine overview page_cursor, including preparing pages.',
    }),
    cursor: Type.Optional(
      Type.String({
        ...observationCursor,
        description:
          'Omit to start after the view’s captured shared and personal upper bounds. Supply the last observation cursor to continue.',
      }),
    ),
  },
  {
    ...closed,
    description:
      'Check for eligible committed activity without creating or advancing a grouped view. Scheduling is optional.',
  },
);
export type RoutineObservationOptions = Static<typeof RoutineObservationQuery>;
export const RoutineObservation = Type.Object(
  {
    contract_version: Type.Literal(routineUpdatesContract),
    cursor: Type.String(observationCursor),
    new_activity: Type.Boolean({
      description:
        'At least one eligible input was observed since this chain began. Future ranked cards are not counted.',
    }),
    scan_complete: Type.Boolean({
      description:
        'Both streams reached the committed positions sampled in this request. If false, more bounded scanning remains.',
    }),
    coverage: Type.Union([Type.Literal('known'), Type.Literal('unknown')], {
      description:
        'Unknown records potentially matched but retained event-time facts were insufficient. This qualification persists across the chain.',
    }),
    settings_current: Type.Boolean({
      description: 'Whether the frozen Following definitions still match current choices.',
    }),
  },
  closed,
);
export type RoutineObservationView = Static<typeof RoutineObservation>;
export const RoutineQuery = Type.Object(
  {
    ...U.UpdatesQuery.properties,
    refresh_from_view: Type.Optional(
      Type.String({
        ...viewToken,
        description:
          'Explicitly extend an authorized routine overview from its original shared and personal lower bounds. Supply its page_cursor and optional response budgets only. The replacement prepares in bounded steps.',
      }),
    ),
    recovery: Type.Optional(
      Type.Object(
        {
          token: Type.Optional(Type.String(viewToken)),
          action: Type.Union(
            ['renew', 'replay', 'resynchronize', 'attention_refresh'].map((v) => Type.Literal(v)),
          ),
        },
        closed,
      ),
    ),
  },
  closed,
);
export type RoutineOptions = Static<typeof RoutineQuery>;
export const AttentionCoverage = Type.Object(
  {
    policy_version: Version,
    selection: Type.Union([
      Type.Literal('remaining_routine_inputs'),
      Type.Literal('all_represented_inputs'),
    ]),
    counts: Type.Literal('source_records; shared_events; personal_signals_are_distinct_units'),
    refresh: Type.Literal('explicit_same_scope_and_intervals'),
  },
  closed,
);
export const RoutinePage = Type.Object(
  {
    ...U.UpdatesPage.properties,
    contract_version: Type.Literal(routineUpdatesContract),
    attention: AttentionCoverage,
    recovery: Type.Union(
      [
        'none',
        'renewed',
        'visibility_replay',
        'retained_resynchronization',
        'attention_refreshed',
      ].map((v) => Type.Literal(v)),
    ),
  },
  closed,
);
export type RoutinePageView = Static<typeof RoutinePage>;
export const RoutineMembersPage = Type.Object(
  {
    ...U.UpdatesMembersPage.properties,
    contract_version: Type.Literal(routineUpdatesContract),
    attention: AttentionCoverage,
  },
  closed,
);
export type RoutineMembersPageView = Static<typeof RoutineMembersPage>;
