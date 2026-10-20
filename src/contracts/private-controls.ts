import { Type, type Static } from '@sinclair/typebox';
import { closed } from './participation.js';
import * as F from './following.js';
import * as A from './attention.js';

// Additive response projections. Command bodies, digests and retained decisions
// keep their original meaning; private receipts carry no source authorization.
export const privateControlsContract='private-controls-1';
export type Projection='legacy'|'private';
export type Projected<P extends Projection,L,S>=P extends 'private'?S:L;
export const FollowItem=Type.Omit(F.FollowItem,['source'],closed);
export type FollowItemView=Static<typeof FollowItem>;
export const FollowResult=Type.Object({...F.FollowResult.properties,current:FollowItem},closed);
export type FollowResultView=Static<typeof FollowResult>;
export const FollowStatus=Type.Union([FollowResult,Type.Object({operation_state:Type.Literal('not_recorded')},closed)]);
export const FollowPage=Type.Object({...F.FollowPage.properties,items:Type.Array(FollowItem,{maxItems:25})},closed);
export type FollowPageView=Static<typeof FollowPage>;
export const MuteItem=Type.Omit(A.MuteItem,['source','other_current_scope_mutes'],closed);
export type MuteItemView=Static<typeof MuteItem>;
export const DismissItem=Type.Omit(A.DismissItem,['availability'],closed);
export type DismissItemView=Static<typeof DismissItem>;
export const DismissPage=Type.Object({...A.DismissPage.properties,items:Type.Array(DismissItem,{maxItems:100})},closed);
export const MuteResult=Type.Object({...A.MuteResult.properties,current:MuteItem},closed);
export const DismissResult=Type.Object({...A.DismissResult.properties,current:Type.Array(DismissItem,{maxItems:100})},closed);
export const AttentionResult=Type.Union([MuteResult,DismissResult]);
export type AttentionResultView=Static<typeof AttentionResult>;
export const AttentionStatus=Type.Union([AttentionResult,Type.Object({operation_state:Type.Literal('not_recorded')},closed)]);
export type AttentionStatusView=Static<typeof AttentionStatus>;
export const AttentionList=Type.Object({...A.AttentionList.properties,mutes:Type.Array(MuteItem,{maxItems:25}),dismissals:Type.Array(DismissItem,{maxItems:25})},closed);
export type AttentionListView=Static<typeof AttentionList>;

// One protected batch serves a bounded private page. Unavailable rows are
// explicit; a private lookup is never an implicit metadata probe.
export const PreviewQuery=Type.Object({targets:Type.Array(F.FollowTarget,{minItems:1,maxItems:25})},closed);
export type PreviewQueryView=Static<typeof PreviewQuery>;
export const PreviewItem=Type.Object({target:F.FollowTarget,source:F.FollowSource,
  other_current_scope_mutes:Type.Array(A.MuteSettings,{maxItems:64})},closed);
export type PreviewItemView=Static<typeof PreviewItem>;
export const PreviewPage=Type.Object({items:Type.Array(PreviewItem,{maxItems:25})},closed);
export type PreviewPageView=Static<typeof PreviewPage>;
