import { Type, type Static } from '@sinclair/typebox';
import { UUID, closed, Content, Title, Resource, Participant, PageInput, changeFields } from './participation.js';

export const summaryLimits = Object.freeze({ sources:100, activePreparations:8, ownerPreparations:128, preparations:8192,
  preparationHours:24, maintenanceScan:10, maintenanceItems:5, cursorBytes:2048, cursorSeconds:300 });
export const SourcePair=Type.Object({contribution_id:UUID,revision_id:UUID},closed);
export type SourcePairValue=Static<typeof SourcePair>;
export const PrepareInput=Type.Union([
  Type.Object({idempotency_key:UUID,discussion_id:UUID,scope:Type.Literal('full')},closed),
  Type.Object({idempotency_key:UUID,discussion_id:UUID,scope:Type.Literal('selected'),members:Type.Array(SourcePair,{maxItems:summaryLimits.sources})},closed),
]);
export type PrepareRequest=Static<typeof PrepareInput>;
export const CoverageDeclaration=Type.Union([
  Type.Object({preparation_id:UUID},closed),
  Type.Object({carry_forward_revision_id:UUID},closed),
]);
export type CoverageDeclarationValue=Static<typeof CoverageDeclaration>;
const authored={idempotency_key:UUID,title:Title,content:Content,coverage:CoverageDeclaration,...changeFields};
export const SummaryCreateInput=Type.Object({...authored,discussion_id:UUID},closed);
export const SummaryRevisionInput=Type.Object({...authored,resource_id:UUID,expected_revision_id:UUID},closed);
export const SummaryStatusInput=Type.Object({operation_kind:Type.Union([Type.Literal('summary.create'),Type.Literal('summary.revise')]),idempotency_key:UUID},closed);
export const SummaryPageInput=Type.Object({...PageInput.properties,cursor:Type.Optional(Type.String({maxLength:2048}))},closed);
export type SummaryPageOptions=Static<typeof SummaryPageInput>;
export const Preparation=Type.Object({preparation_id:UUID,discussion_id:UUID,scope:Type.Union([Type.Literal('full'),Type.Literal('selected')]),
  expires_at:Type.String(),eligible_members:Type.Integer({minimum:0,maximum:100}),unknown:Type.Boolean(),members_url:Type.String()},closed);
export type PreparationView=Static<typeof Preparation>;
export const Coverage=Type.Object({scope:Type.Union([Type.Literal('full'),Type.Literal('selected')]),
  uncovered_eligible:Type.Union([Type.Integer({minimum:0,maximum:100}),Type.Null()]),
  changed_eligible:Type.Union([Type.Integer({minimum:0,maximum:100}),Type.Null()]),unknown:Type.Boolean(),
  comparison:Type.Union([Type.Literal('complete'),Type.Literal('work_limited')]),
  claim:Type.Literal('author_declared; not_read_or_correctness_proof')},closed);
export type CoverageView=Static<typeof Coverage>;
export const SourceEntry=Type.Object({source:Resource,declared_revision_id:Type.Optional(UUID),
  status:Type.Union([Type.Literal('covered'),Type.Literal('changed'),Type.Literal('uncovered'),Type.Literal('prepared'),Type.Literal('unknown')]),
  context_url:Type.String(),browser_url:Type.String()},closed);
export type SourceEntryView=Static<typeof SourceEntry>;
const page={next_cursor:Type.Union([Type.String(),Type.Null()]),complete:Type.Boolean(),work_budget_reached:Type.Boolean(),
  limit:Type.Integer(),max_response_bytes:Type.Integer(),omitted_detail:Type.Literal('bodies; unavailable_members'),expires_at:Type.String()};
export const SourcePage=Type.Object({...page,items:Type.Array(SourceEntry,{maxItems:25}),unknown:Type.Boolean()},closed);
export type SourcePageView=Static<typeof SourcePage>;
export const CoverageDetail=Type.Object({summary_id:UUID,revision_id:UUID,discussion_id:UUID,coverage:Coverage,
  members_url:Type.String(),sources_url:Type.String()},closed);
export type CoverageDetailView=Static<typeof CoverageDetail>;
export const SummaryLookup=Type.Union([
  Type.Object({state:Type.Literal('absent'),can_create:Type.Boolean()},closed),
  Type.Object({state:Type.Literal('unavailable')},closed),
  Type.Object({state:Type.Literal('available'),summary:Resource},closed),
]);
export type SummaryLookupView=Static<typeof SummaryLookup>;
export const MaintenanceInput=Type.Object({...SummaryPageInput.properties,limit:Type.Optional(Type.String({pattern:'^[1-5]$'})),
  filter:Type.Optional(Type.Union(['uncovered','changed','partial','unknown','no_active_editor'].map(s=>Type.Literal(s)))),
  editable:Type.Optional(Type.Union([Type.Literal('true'),Type.Literal('false')])),topic:Type.Optional(UUID),
  descendants:Type.Optional(Type.Union([Type.Literal('true'),Type.Literal('false')]))},closed);
export type MaintenanceOptions=Static<typeof MaintenanceInput>;
export const MaintenanceEntry=Type.Object({summary:Resource,coverage:Coverage,no_active_editor:Type.Boolean(),
  editors:Type.Array(Participant,{maxItems:32}),coverage_url:Type.String(),browser_url:Type.String()},closed);
export type MaintenanceEntryView=Static<typeof MaintenanceEntry>;
export const MaintenancePage=Type.Object({...page,items:Type.Array(MaintenanceEntry,{maxItems:5})},closed);
export type MaintenancePageView=Static<typeof MaintenancePage>;
