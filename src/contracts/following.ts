import { Type, type Static } from '@sinclair/typebox';
import { closed, UUID, Participant } from './participation.js';

export const sharedContract='shared-changes-1';
export const followingLimits=Object.freeze({targets:500,active:64,operations:10000,scan:100,items:25,reasons:8,tokenBytes:16384,cursorSeconds:86400});
export const eventPreferences=['new_discussions','discussion_edits','replies','artifact_revisions','summaries','change_notes','structural'] as const;
export const Preference=Type.Union(eventPreferences.map(v=>Type.Literal(v)));
export const Preferences=Type.Array(Preference,{minItems:1,maxItems:7,uniqueItems:true});
export const FollowTarget=Type.Object({kind:Type.Union(['area','discussion','artifact'].map(v=>Type.Literal(v))),resource_id:UUID},closed);
export type FollowTargetView=Static<typeof FollowTarget>;
export const FollowSettings=Type.Object({target:FollowTarget,include_descendants:Type.Boolean(),preferences:Preferences},closed);
export type FollowSettingsView=Static<typeof FollowSettings>;
const Version=Type.Integer({minimum:0,maximum:2147483646});
export const FollowUpdate=Type.Object({...FollowSettings.properties,idempotency_key:UUID,following:Type.Boolean(),expected_version:Version},closed);
export type FollowUpdateInput=Static<typeof FollowUpdate>;
export const FollowSource=Type.Union([
  Type.Object({state:Type.Literal('unavailable')},closed),
  Type.Object({state:Type.Literal('available'),title:Type.Union([Type.String(),Type.Null()]),
    path:Type.Array(Type.Object({id:UUID,title:Type.String()},closed),{maxItems:32}),browser_url:Type.String()},closed),
]);
export type FollowSourceView=Static<typeof FollowSource>;
export const FollowItem=Type.Object({...FollowSettings.properties,following:Type.Boolean(),version:Version,source:FollowSource},closed);
export type FollowItemView=Static<typeof FollowItem>;
export const FollowResult=Type.Object({operation_state:Type.Union([Type.Literal('applied'),Type.Literal('version_conflict')]),
  operation_id:UUID,idempotency:Type.Union([Type.Literal('created'),Type.Literal('replayed')]),
  outcome:Type.Object({...FollowSettings.properties,following:Type.Boolean(),expected_version:Version,result_version:Version},closed),current:FollowItem},closed);
export type FollowResultView=Static<typeof FollowResult>;
export const FollowStatus=Type.Union([FollowResult,Type.Object({operation_state:Type.Literal('not_recorded')},closed)]);
export type FollowStatusView=Static<typeof FollowStatus>;
export const FollowPage=Type.Object({items:Type.Array(FollowItem,{maxItems:25}),next_cursor:Type.Union([Type.String(),Type.Null()]),
  complete:Type.Boolean(),collection_version:Version,ordering:Type.Literal('stable_target_id'),limit:Type.Integer(),max_response_bytes:Type.Integer()},closed);
export type FollowPageView=Static<typeof FollowPage>;

export const SharedScope=Type.Union([Type.Object({kind:Type.Literal('following')},closed),Type.Object({kind:Type.Literal('explicit'),definition:FollowSettings},closed)]);
export type SharedScopeView=Static<typeof SharedScope>;
const Token=Type.String({minLength:1,maxLength:followingLimits.tokenBytes});
const NullableToken=Type.Union([Token,Type.Null()]);
export const SharedQuery=Type.Object({scope:Type.Optional(SharedScope),cursor:Type.Optional(Token),checkpoint:Type.Optional(Token),
  recovery:Type.Optional(Type.Object({action:Type.Union(['renew','replay','resynchronize'].map(v=>Type.Literal(v))),token:Type.Optional(Token)},closed)),
  limit:Type.Optional(Type.Integer({minimum:1,maximum:25})),max_response_bytes:Type.Optional(Type.Integer({minimum:4096,maximum:131072}))},closed);
export type SharedOptions=Static<typeof SharedQuery>;
export const BoundDefinition=Type.Object({...FollowSettings.properties,version:Version},closed);
export type BoundDefinitionView=Static<typeof BoundDefinition>;
export const MatchReason=Type.Object({definition:Type.Integer({minimum:0,maximum:63}),target:FollowTarget,preferences:Preferences,
  relevance:Type.Union(['event_time_area','direct_target','structural_before_after','ancestor_impact'].map(v=>Type.Literal(v)))},closed);
export type MatchReasonView=Static<typeof MatchReason>;
export const SharedItem=Type.Object({event_id:UUID,kind:Type.String(),resource_id:UUID,discussion_id:Type.Union([UUID,Type.Null()]),
  revision_id:Type.Union([UUID,Type.Null()]),revision_number:Type.Union([Type.String(),Type.Null()]),
  actor:Participant,occurred_at:Type.String(),current:FollowSource,
  exact_url:Type.Union([Type.String(),Type.Null()]),context_url:Type.String(),full_content_url:Type.Union([Type.String(),Type.Null()]),
  change_note_url:Type.Union([Type.String(),Type.Null()]),
  reasons:Type.Array(MatchReason,{maxItems:8}),reasons_complete:Type.Boolean(),
  detail_url:Type.String(),next_reason:Type.Union([Type.Integer({minimum:0,maximum:63}),Type.Null()])},closed);
export type SharedItemView=Static<typeof SharedItem>;
export const SharedDetailInput=Type.Object({cursor:Token,event_id:UUID,reason_offset:Type.Optional(Type.Integer({minimum:0,maximum:63})),
  max_response_bytes:Type.Optional(Type.Integer({minimum:4096,maximum:131072}))},closed);
export const SharedPage=Type.Object({contract_version:Type.Literal(sharedContract),items:Type.Array(SharedItem,{maxItems:25}),
  traversal:Type.Object({id:UUID,scope:Type.Union([Type.Literal('following'),Type.Literal('explicit')]),definitions:Type.Array(BoundDefinition,{maxItems:64}),
    settings_current:Type.Boolean(),selection:Type.Literal('complete'),grouping:Type.Literal('none'),order:Type.Literal('committed_event_ascending'),
    boundaries:Type.Literal('fixed_shared_interval'),history_start:Type.Literal('retained_history'),expires_at:Type.String()},closed),
  page_cursor:Token,next_cursor:NullableToken,checkpoint:NullableToken,
  page_exhausted:Type.Boolean(),interval_complete:Type.Boolean(),no_subscriptions:Type.Boolean(),work_budget_reached:Type.Boolean(),
  coverage:Type.Union([Type.Literal('known'),Type.Literal('unknown')]),coverage_limit:Type.Union([Type.Literal('historical_or_unsupported_facts'),Type.Null()]),
  recovery:Type.Union(['none','renewed','visibility_replay','retained_resynchronization'].map(v=>Type.Literal(v))),
  history:Type.Union([Type.Literal('retained'),Type.Literal('incomplete')]),baseline_established:Type.Boolean(),
  inventory:Type.Array(Type.Object({label:Type.String(),url:Type.String()},closed),{maxItems:192}),
  omitted_detail:Type.Literal('full_bodies'),limit:Type.Integer(),max_response_bytes:Type.Integer()},closed);
export type SharedPageView=Static<typeof SharedPage>;
