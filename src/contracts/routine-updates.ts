import { Type, type Static } from '@sinclair/typebox';
import { closed } from './participation.js';
import * as U from './updates.js';
import { Version } from './attention.js';

export const routineUpdatesContract = 'combined-updates-2';
export const RoutineQuery = Type.Object(
  {
    ...U.UpdatesQuery.properties,
    recovery: Type.Optional(
      Type.Object(
        {
          token: Type.Optional(Type.String({ minLength: 1, maxLength: 16384 })),
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
