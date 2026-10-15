import { Type, type Static } from '@sinclair/typebox';
import { closed, UUID, Participant, PageInput } from './participation.js';

export const searchLimits = Object.freeze({ queryBytes:256, queryNodes:16, corpus:5000, window:200, excerptCharacters:320, cursorSeconds:300 });
export const SearchInput = Type.Object({
  q: Type.String({minLength:1,maxLength:256}),
  topic: Type.Optional(UUID), descendants: Type.Optional(Type.Union([Type.Literal('true'),Type.Literal('false')])),
  kind: Type.Optional(Type.Union(['discussion','comment','artifact','summary'].map(k=>Type.Literal(k)))),
  author: Type.Optional(UUID), from: Type.Optional(Type.String({maxLength:30})), before: Type.Optional(Type.String({maxLength:30})),
  ...PageInput.properties, cursor: Type.Optional(Type.String({maxLength:2048})),
}, closed);
export type SearchOptions = Static<typeof SearchInput>;
export const SearchAuthorsInput = Type.Object({
  ...PageInput.properties, cursor: Type.Optional(Type.String({maxLength:2048})), author: Type.Optional(UUID),
}, closed);
export type SearchAuthorsOptions = Static<typeof SearchAuthorsInput>;
export const SearchAuthorsPage = Type.Object({
  items:Type.Array(Participant,{maxItems:25}),next_cursor:Type.Union([Type.String(),Type.Null()]),
  limit:Type.Integer(),max_response_bytes:Type.Integer(),expires_at:Type.String(),
},closed);
export type SearchAuthorsView = Static<typeof SearchAuthorsPage>;
export const SearchStatus = Type.Object({
  indexing: Type.Union(['ready','incomplete','unavailable'].map(k=>Type.Literal(k))),
  coverage: Type.Union([Type.Literal('current_supported_text'),Type.Literal('not_established')]),
  direct_retrieval: Type.Literal('independent'),
}, closed);
export type SearchStatusView = Static<typeof SearchStatus>;
export const SearchResult = Type.Object({
  result_id: UUID, source_resource_id: UUID, revision_id: UUID,
  kind: Type.Union(['discussion','comment','artifact','summary'].map(k=>Type.Literal(k))),
  title: Type.Union([Type.String(),Type.Null()]), author: Participant, publisher: Participant,
  published_at: Type.String(), area_id: UUID, area_title: Type.String(),
  location: Type.Array(Type.Object({id:UUID,title:Type.String()},closed),{maxItems:32}),
  discussion_id: Type.Union([UUID,Type.Null()]), parent_id: Type.Union([UUID,Type.Null()]),
  excerpt: Type.Object({text:Type.String(),representation:Type.Literal('excerpt'),omitted_detail:Type.Literal('full_body')},closed),
  full_content_url:Type.String(), browser_url:Type.String(), context_url:Type.String(),browser_context_url:Type.String(),
}, closed);
export const SearchPage = Type.Object({
  items:Type.Array(SearchResult,{maxItems:25}),
  query:Type.String(), scope:Type.Object({topic:Type.Union([UUID,Type.Null()]),descendants:Type.Boolean(),
    kind:Type.Union([Type.String(),Type.Null()]),author:Type.Union([UUID,Type.Null()]),
    from:Type.Union([Type.String(),Type.Null()]),before:Type.Union([Type.String(),Type.Null()])},closed),
  indexing:SearchStatus, selection:Type.Literal('bounded_current_relevance'), ranking:Type.Literal('simple-title-body-v1'),
  next_cursor:Type.Union([Type.String(),Type.Null()]), window_exhausted:Type.Boolean(), selection_limited:Type.Boolean(),
  corpus_exhaustive:Type.Literal(false), limit:Type.Integer(), max_response_bytes:Type.Integer(), expires_at:Type.String(),
},closed);
export type SearchPageView=Static<typeof SearchPage>;
export type SearchResultView=Static<typeof SearchResult>;
export const SearchHealth=Type.Object({generation:Type.Integer(),scan_complete:Type.Boolean(),worker_available:Type.Boolean(),
  capacity_limited:Type.Boolean(),event_discovery_caught_up:Type.Boolean(),
  jobs:Type.Object(Object.fromEntries(['pending','running','succeeded','failed'].map(k=>[k,Type.Integer()])),closed)},closed);
export type SearchHealthView=Static<typeof SearchHealth>;
export const FailedSearchJobs=Type.Object({items:Type.Array(Type.Object({id:UUID,generation:Type.Integer(),claim_generation:Type.Integer(),
  attempts:Type.Integer(),failure:Type.String(),resource_id:Type.Union([UUID,Type.Null()]),revision_id:Type.Union([UUID,Type.Null()]),
  source_event_id:Type.Union([UUID,Type.Null()]),source_intent_id:Type.Union([UUID,Type.Null()])},closed),{maxItems:25}),next_after:Type.Union([UUID,Type.Null()])},closed);
