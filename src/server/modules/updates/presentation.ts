import { createHmac } from 'node:crypto';
import * as C from '../../../contracts/updates.js';
import type * as R from '../../../contracts/routine-updates.js';
import type { SharedCandidate } from '../following/retrieval.js';
import type { Bound, State, View, Group, Member } from './model.js';

export function attentionCoverage(bound:Bound):R.RoutinePageView['attention']{return {policy_version:bound.policy??0,selection:bound.selection==='complete'?'all_represented_inputs':'remaining_routine_inputs',counts:'source_records; shared_events; personal_signals_are_distinct_units',refresh:'explicit_same_scope_and_intervals'};}

export function groupKey(row: SharedCandidate): {kind: Group['kind']; key: string} {
  if(row.discussion_id||row.resource_kind==='discussion')return {kind:'discussion',key:row.discussion_id??row.resource_id};
  if(row.resource_kind==='artifact')return {kind:'artifact',key:row.resource_id};
  return {kind:'structural',key:row.id};
}

export function traversalMetadata(state: State, bound: Bound, view: View, settingsCurrent: boolean): C.UpdatesPageView['traversal'] {
  // Both protocols retain the original component-boundary fingerprint; descriptor AAD is separate.
  const boundary=(component:string,position:string)=>createHmac('sha256',state.cursor_key).update(JSON.stringify([C.updatesContract,bound.owner,component,position])).digest('base64url');
  return {id:bound.id,scope:bound.scope,definitions:bound.definitions,reason:bound.reason,selection:bound.selection,settings_current:settingsCurrent,grouping:'ownership; area_event',
          order:'direct_first; frozen_recent_then_identity',expires_at:new Date(bound.expires).toISOString(),
          shared:{contract:'shared-changes-1',lower:boundary('shared',bound.shared_lower),upper:boundary('shared',bound.shared_upper),
            scan_complete:view.shared_after===bound.shared_upper,coverage:view.unknown_shared?'unknown':'known',history:bound.shared_history},
          personal:{contract:'personal-attention-1',lower:boundary('personal',bound.personal_lower),upper:boundary('personal',bound.personal_upper),
            scan_complete:view.personal_after===bound.personal_upper,coverage:'known',history:bound.personal_history}};
}

export function directMembers(visible: Member[]) {
  return visible.filter(m=>m.delivery_id).sort((a,b)=>b.display_at.getTime()-a.display_at.getTime()||a.event_id.localeCompare(b.event_id));
}

export function groupCounts(eligible: SharedCandidate[], visible: Member[], direct: Member[], unknownShared: boolean): C.UpdateGroupView['counts'] {
  const count=(test:(e:SharedCandidate)=>boolean)=>eligible.filter(test).length;
  return {certainty:unknownShared?'known_sources_only':'exact',source_records:visible.length,shared_changes:visible.filter(m=>m.shared).length,personal_signals:direct.length,
        reply_publications:count(e=>e.resource_kind==='contribution'&&!!e.parent_id&&e.revision_number==='1'),
        reply_revisions:count(e=>e.resource_kind==='contribution'&&!!e.parent_id&&e.revision_number!=='1'),
        summary_changes:count(e=>e.resource_kind==='summary'),artifact_changes:count(e=>e.resource_kind==='artifact'&&e.kind==='revision.published'),
        opening_changes:count(e=>e.resource_kind==='contribution'&&!e.parent_id),structural_changes:count(e=>e.kind==='organization.changed')};
}
