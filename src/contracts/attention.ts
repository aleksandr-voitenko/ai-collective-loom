import { Type, type Static } from '@sinclair/typebox';
import { closed, UUID } from './participation.js';
import { FollowTarget, FollowSource } from './following.js';

export const attentionContract = 'attention-controls-1';
export const attentionLimits = Object.freeze({ batch:100, activeMutes:64, mutes:500, inputs:10000,
  operations:50000, outcomeMembers:100000, requestBytes:65536, responseBytes:131072,
  selectionBytes:32768, selectionSeconds:86400, localOperations:128, localBytes:1048576 });
export const Version=Type.Integer({minimum:0,maximum:2147483646});
const Availability=Type.Union([Type.Literal('available'),Type.Literal('unavailable')]);
export const MuteSettings=Type.Object({target:FollowTarget,include_descendants:Type.Boolean()},closed);
export const MuteUpdate=Type.Object({...MuteSettings.properties,idempotency_key:UUID,muted:Type.Boolean(),expected_version:Version},closed);
export type MuteUpdateInput=Static<typeof MuteUpdate>;
export const MuteItem=Type.Object({...MuteSettings.properties,muted:Type.Boolean(),version:Version,source:FollowSource,
  other_current_scope_mutes:Type.Array(MuteSettings,{maxItems:64})},closed);
export type MuteItemView=Static<typeof MuteItem>;
export const AttentionInput=Type.Object({kind:Type.Union([Type.Literal('shared_event'),Type.Literal('personal_delivery')]),id:UUID},closed);
export type AttentionInputView=Static<typeof AttentionInput>;
export const DismissCommand=Type.Object({...AttentionInput.properties,dismissed:Type.Boolean(),expected_version:Version},closed);
export const DismissUpdate=Type.Object({idempotency_key:UUID,selection:Type.Optional(Type.String({minLength:1,maxLength:32768})),
  inputs:Type.Array(DismissCommand,{minItems:1,maxItems:100})},closed);
export type DismissUpdateInput=Static<typeof DismissUpdate>;
export const DismissItem=Type.Object({...AttentionInput.properties,dismissed:Type.Boolean(),version:Version,availability:Availability},closed);
export type DismissItemView=Static<typeof DismissItem>;
export const DismissLookup=Type.Object({inputs:Type.Array(AttentionInput,{minItems:1,maxItems:100})},closed);
export const DismissPage=Type.Object({items:Type.Array(DismissItem,{maxItems:100}),policy_version:Version},closed);
export type DismissPageView=Static<typeof DismissPage>;
const ResultFields={operation_state:Type.Union([Type.Literal('applied'),Type.Literal('version_conflict')]),
  operation_id:UUID,idempotency:Type.Union([Type.Literal('created'),Type.Literal('replayed')]),policy_version:Version};
export const MuteResult=Type.Object({...ResultFields,kind:Type.Literal('mute'),
  outcome:Type.Object({...MuteSettings.properties,muted:Type.Boolean(),expected_version:Version,result_version:Version},closed),current:MuteItem},closed);
export type MuteResultView=Static<typeof MuteResult>;
export const DismissResult=Type.Object({...ResultFields,kind:Type.Literal('dismissal'),
  outcome:Type.Object({inputs:Type.Array(Type.Object({...DismissCommand.properties,result_version:Version},closed),{maxItems:100})},closed),
  current:Type.Array(DismissItem,{maxItems:100})},closed);
export type DismissResultView=Static<typeof DismissResult>;
export const AttentionResult=Type.Union([MuteResult,DismissResult]);
export type AttentionResultView=Static<typeof AttentionResult>;
export const AttentionStatusInput=Type.Object({idempotency_key:UUID},closed);
export const AttentionStatus=Type.Union([AttentionResult,Type.Object({operation_state:Type.Literal('not_recorded')},closed)]);
export type AttentionStatusView=Static<typeof AttentionStatus>;
export const AttentionListInput=Type.Object({collection:Type.Union([Type.Literal('mutes'),Type.Literal('dismissals')]),
  cursor:Type.Optional(Type.String({minLength:1,maxLength:2048})),limit:Type.Optional(Type.Integer({minimum:1,maximum:25})),
  max_response_bytes:Type.Optional(Type.Integer({minimum:4096,maximum:131072}))},closed);
export const AttentionList=Type.Object({collection:AttentionListInput.properties.collection,
  mutes:Type.Array(MuteItem,{maxItems:25}),dismissals:Type.Array(DismissItem,{maxItems:25}),policy_version:Version,
  next_cursor:Type.Union([Type.String(),Type.Null()]),complete:Type.Boolean()},closed);
export type AttentionListView=Static<typeof AttentionList>;
export const AttentionSelectionQuery=Type.Object({cursor:Type.String({minLength:1,maxLength:16384}),group_id:UUID,
  inputs:Type.Optional(Type.Array(AttentionInput,{minItems:1,maxItems:100}))},closed);
export type AttentionSelectionOptions=Static<typeof AttentionSelectionQuery>;
export const AttentionSelection=Type.Object({selection:Type.String({maxLength:32768}),inputs:Type.Array(DismissItem,{minItems:1,maxItems:100}),
  policy_version:Version,shared_events:Type.Integer(),personal_signals:Type.Integer(),
  membership:Type.Literal('exact_represented_inputs_including_unexpanded_direct_sources'),expires_at:Type.String()},closed);
export type AttentionSelectionView=Static<typeof AttentionSelection>;
