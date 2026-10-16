import { randomUUID } from 'node:crypto';
import type { ExactChangeTargetValue, NoteContent, ReferenceValue, AuthoredContent } from '../../src/contracts/participation.js';
export { fixture } from './summaries.js';
export const content = (text:string,references:ReferenceValue[]=[]) => ({format:'loom-markdown-v3' as const,text,mentions:[] as AuthoredContent['mentions'],references});
export const note = (text:string):NoteContent => ({format:'loom-markdown-v2',text,mentions:[],references:[]});
export const exactPair = (source:{resource_id:string;revision_id:string},kind:ExactChangeTargetValue['kind']='artifact'):ExactChangeTargetValue => ({kind,resource_id:source.resource_id,revision_id:source.revision_id});
export const revisionBody = (source:{resource_id:string;revision_id:string},text:string,changeNote:NoteContent|null=null) => ({
  idempotency_key:randomUUID(),resource_id:source.resource_id,expected_revision_id:source.revision_id,title:'Artifact',
  content:content(text),change_note:changeNote,change_account:null,
});
export const notePath=(s:{resource_id:string;revision_id:string})=>`/api/v1/resources/${s.resource_id}/revisions/${s.revision_id}/change-note`;
export const coveragePath=(s:{resource_id:string;revision_id:string})=>`/api/v1/resources/${s.resource_id}/revisions/${s.revision_id}/change-coverage`;
export const discover=(s:{resource_id:string;revision_id?:string},options:Record<string,string>={})=>'/api/v1/changes?'+new URLSearchParams({kind:'artifact',resource_id:s.resource_id,...(s.revision_id?{revision_id:s.revision_id}:{}),...options});
