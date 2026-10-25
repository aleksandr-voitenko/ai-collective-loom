import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildDraftBody, composerOperation, correctDraft, draftCorrection, type ComposerOperation, type DraftFields } from '../../src/web/composer-draft.js';
import type { AuthoredContent, ReferenceValue } from '../../src/contracts/participation.js';

const reference: ReferenceValue = { reference_id: 'ref', target: { kind: 'artifact', resource_id: 'target' }, relationship: 'related_to', rationale: 'Exact reason' };
const fileSet = { version: 'artifact-files-v1' as const, files: [{ path: 'draft/Report.txt', source: { upload_id: 'upload' } }] };
const note = { format: 'loom-markdown-v2' as const, text: 'Why it changed', mentions: [], references: [] };
const account = { revisions: [{ kind: 'artifact' as const, resource_id: 'target', revision_id: 'target-revision' }] };
const fields = (patch: Partial<DraftFields> = {}): DraftFields => ({ text: 'Exact  text\r\n', title: 'Draft title',
  mentions: [{ token: 'm1', participant_id: 'Mixed-Case-Participant' }], format: 'loom-markdown-v1', references: [],
  base: undefined, coverage: undefined, note: null, account: null, fileSet: undefined, ...patch });
const content = (patch: Partial<Extract<AuthoredContent, { format: 'loom-markdown-v1' }>> = {}): AuthoredContent =>
  ({ format: 'loom-markdown-v1', text: 'Exact  text\r\n', mentions: [{ token: 'm1', participant_id: 'Mixed-Case-Participant' }], ...patch });
const revision: ComposerOperation = { kind: 'revision.publish', resourceKind: 'contribution', resourceId: 'source', revisionId: 'initial', title: 'Original title' };
type Comparison = NonNullable<Parameters<typeof correctDraft>[0]['comparison']>;
const comparison = (format: AuthoredContent['format'], references: ReferenceValue[] = []): Comparison => ({
  revision_id: 'conflict', content: format === 'loom-markdown-v1'
    ? { format, text: 'Other author text', mentions: [] }
    : { format, text: 'Other author text', mentions: [], references },
});
const rejected = (format: AuthoredContent['format'], extra: Record<string, unknown> = {}) => ({
  state: 'rejected' as const, conflict_revision_id: 'conflict', body: {
    expected_revision_id: 'original', content: format === 'loom-markdown-v1' ? { format, text: 'Attempted', mentions: [] }
      : { format, text: 'Attempted', mentions: [], references: [] }, ...extra,
  },
});

for (const { operation, path, target, titleField, canFiles, canNote, summaryDiscussion } of [
  { operation: { kind: 'discussion.create', areaId: 'area' }, path: '/api/v1/discussions', target: { area_id: 'area' }, titleField: true, canFiles: true, canNote: false, summaryDiscussion: undefined },
  { operation: { kind: 'artifact.create', areaId: 'area' }, path: '/api/v1/artifacts', target: { area_id: 'area' }, titleField: true, canFiles: true, canNote: true, summaryDiscussion: undefined },
  { operation: { kind: 'reply.create', discussionId: 'discussion', parentId: 'parent' }, path: '/api/v1/replies', target: { discussion_id: 'discussion', parent_id: 'parent' }, titleField: false, canFiles: true, canNote: false, summaryDiscussion: undefined },
  { operation: { kind: 'summary.create', discussionId: 'discussion' }, path: '/api/v1/summaries', target: { discussion_id: 'discussion' }, titleField: true, canFiles: false, canNote: true, summaryDiscussion: 'discussion' },
  { operation: revision, path: '/api/v1/revisions', target: { resource_id: 'source', expected_revision_id: 'initial', title: 'Original title' }, titleField: true, canFiles: true, canNote: false, summaryDiscussion: undefined },
  { operation: { kind: 'summary.revise', resourceId: 'source', revisionId: 'initial', title: 'Original title', discussionId: 'discussion' }, path: '/api/v1/summary-revisions', target: { resource_id: 'source', expected_revision_id: 'initial', title: 'Original title' }, titleField: true, canFiles: false, canNote: true, summaryDiscussion: 'discussion' },
] satisfies { operation: ComposerOperation; path: string; target: object; titleField: boolean; canFiles: boolean; canNote: boolean; summaryDiscussion: string | undefined }[]) {
  test(`${operation.kind} derives its route, target, capabilities and complete new draft`, () => {
    assert.deepEqual(composerOperation(operation), { path, fixed: target, titleField, canFiles, canNote, summaryDiscussion });
    assert.deepEqual(buildDraftBody({ operation, fields: fields() }), {
      ...target, ...(titleField ? { title: 'Draft title' } : {}), content: content(),
    });
  });
}

test('revision title null remains present without an editor; artifact revision owns file and note capabilities', () => {
  const operation: ComposerOperation = { ...revision, title: null, resourceKind: 'artifact' };
  assert.deepEqual(composerOperation(operation), { path: '/api/v1/revisions',
    fixed: { resource_id: 'source', expected_revision_id: 'initial', title: null }, titleField: false, canFiles: true, canNote: true, summaryDiscussion: undefined });
  assert.deepEqual(buildDraftBody({ operation, fields: fields({ title: 'Invisible local value', base: 'saved-base' }) }), {
    resource_id: 'source', expected_revision_id: 'saved-base', title: null, content: content(),
  });
});

test('proposal draft retains its selected area/settings and does not invent an affected area', () => {
  for (const proposal of [{ expected_settings_version: 7 }, { affected_area_id: 'subject', expected_settings_version: 7 }, { expected_settings_version: undefined }]) {
    const operation: ComposerOperation = { kind: 'discussion.create', areaId: 'retained-area', proposal };
    assert.deepEqual(buildDraftBody({ operation, fields: fields() }), {
      area_id: 'retained-area', proposal_context: proposal, title: 'Draft title', content: content(),
    });
  }
});

test('empty legacy formats retain their envelopes and named patches keep undefined defaults and intentional empty values', () => {
  const operation: ComposerOperation = { kind: 'artifact.create', areaId: 'area' };
  for (const format of ['loom-markdown-v1', 'loom-markdown-v2', 'loom-markdown-v3'] as const) {
    assert.deepEqual(buildDraftBody({ operation, fields: fields({ format }), patch: { text: '', title: '', mentions: [], references: [], note: null, account: null } }), {
      area_id: 'area', title: '', ...(format === 'loom-markdown-v3' ? { change_note: null, change_account: null } : {}),
      content: { format, ...(format === 'loom-markdown-v1' ? {} : { references: [] }), text: '', mentions: [] },
    });
  }
  const complete = fields({ format: 'loom-markdown-v3', references: [reference], coverage: { preparation_id: 'prepared' }, note, account, fileSet });
  const before = structuredClone(complete);
  assert.deepEqual(buildDraftBody({ operation, fields: complete, patch: { text: '', note: null, account: null, coverage: undefined, fileSet: undefined } }), {
    area_id: 'area', title: 'Draft title', coverage: { preparation_id: 'prepared' }, file_set: fileSet,
    change_note: null, change_account: null,
    content: { format: 'loom-markdown-v3', references: [reference], text: '', mentions: complete.mentions },
  });
  assert.deepEqual(complete, before, 'Building a draft must not modify the editor snapshot.');
});

test('references and each authored extension select the complete supported format without normalizing values', () => {
  const operation: ComposerOperation = { kind: 'artifact.create', areaId: 'Mixed-Case-Area' };
  assert.deepEqual(buildDraftBody({ operation, fields: fields(), patch: { references: [reference] } }), {
    area_id: 'Mixed-Case-Area', title: 'Draft title', content: { format: 'loom-markdown-v2', references: [reference], text: 'Exact  text\r\n', mentions: fields().mentions },
  });
  for (const patch of [{ note }, { account }, { fileSet, text: '' }]) {
    assert.deepEqual(buildDraftBody({ operation, fields: fields(), patch }), {
      area_id: 'Mixed-Case-Area', title: 'Draft title', ...('fileSet' in patch ? { file_set: fileSet } : {}),
      change_note: 'note' in patch ? note : null, change_account: 'account' in patch ? account : null,
      content: { format: 'loom-markdown-v3', references: [], text: 'text' in patch ? '' : 'Exact  text\r\n', mentions: fields().mentions },
    });
  }
});

test('correction requires a rejected attempt and its exact retained comparison before adopting unsupported fields', () => {
  const record = rejected('loom-markdown-v1');
  for (const current of [undefined, { ...comparison('loom-markdown-v2'), revision_id: 'newer-current' }]) {
    assert.equal(correctDraft({ operation: revision, fields: fields(), record, comparison: current }), undefined);
    assert.deepEqual(draftCorrection({ operation: revision, record, comparison: current }), {
      comparisonRevision: 'conflict', comparisonReady: false, adoptsBaseReferences: false, adoptsFileReferences: false, requiresComparison: true,
      legacyCorrection: true, legacyFileCorrection: true,
    });
  }
  const noConflict = { state: 'rejected' as const, body: record.body };
  assert.equal(draftCorrection({ operation: revision, record: noConflict, comparison: undefined }).comparisonRevision, 'original');
  for (const state of ['draft', 'uncertain', 'committed'] as const) {
    const frozen = { ...record, state }, before = JSON.stringify(frozen);
    assert.equal(correctDraft({ operation: revision, fields: fields(), record: frozen, comparison: comparison('loom-markdown-v2') }), undefined);
    assert.equal(JSON.stringify(frozen), before);
  }
});

for (const references of [[], [reference]]) test(`v1 correction adopts the exact comparison's ${references.length} references and keeps attempted text`, () => {
  const current = fields({ base: 'original' }), record = rejected('loom-markdown-v1'), before = structuredClone(record);
  assert.deepEqual(correctDraft({ operation: revision, fields: current, record, comparison: comparison('loom-markdown-v2', references) }), {
    fields: { ...current, base: 'conflict', format: 'loom-markdown-v2', references },
    body: { resource_id: 'source', expected_revision_id: 'conflict', title: 'Draft title',
      content: { format: 'loom-markdown-v2', references, text: current.text, mentions: current.mentions } },
  });
  assert.deepEqual(record, before);
});

for (const format of ['loom-markdown-v1', 'loom-markdown-v2', 'loom-markdown-v3'] as const) {
  test(`${format} correction to v3 preserves supported reference fields and account provenance`, () => {
    const attempted = [{ ...reference, rationale: 'Edited attempted rationale' }, { ...reference, reference_id: 'added', target: { kind: 'artifact' as const, resource_id: 'added-target' } }];
    const baseReferences = [{ ...reference, reference_id: 'withdrawn', rationale: 'Must not revive a v2 withdrawal' }];
    const current = fields({ format, references: attempted, note, account, base: 'original' });
    const compare = { ...comparison('loom-markdown-v3', baseReferences), change_account: { state: 'declared' as const, coverage_url: '/coverage' } };
    const references = format === 'loom-markdown-v1' ? baseReferences : attempted;
    const nextAccount = format === 'loom-markdown-v3' ? account : { carry_forward_revision_id: 'conflict' };
    assert.deepEqual(correctDraft({ operation: revision, fields: current, record: rejected(format), comparison: compare }), {
      fields: { ...current, base: 'conflict', format: 'loom-markdown-v3', references, account: nextAccount },
      body: { resource_id: 'source', expected_revision_id: 'conflict', title: 'Draft title', change_note: note, change_account: nextAccount,
        content: { format: 'loom-markdown-v3', references, text: current.text, mentions: current.mentions } },
    });
  });
}

test('summary correction removes only the coverage declaration and preserves attempted authored content', () => {
  const operation: ComposerOperation = { kind: 'summary.revise', resourceId: 'source', revisionId: 'initial', title: 'Old title', discussionId: 'discussion' };
  const current = fields({ format: 'loom-markdown-v3', base: 'original', coverage: { carry_forward_revision_id: 'original' }, references: [reference], note });
  assert.deepEqual(correctDraft({ operation, fields: current, record: rejected('loom-markdown-v3'), comparison: comparison('loom-markdown-v3') }), {
    fields: { ...current, base: 'conflict', coverage: undefined },
    body: { resource_id: 'source', expected_revision_id: 'conflict', title: 'Draft title', change_note: note, change_account: null,
      content: { format: 'loom-markdown-v3', references: [reference], text: current.text, mentions: current.mentions } },
  });
});

for (const legacy of [true, false]) test(`artifact correction ${legacy ? 'adopts missing' : 'preserves attempted'} file manifest`, () => {
  const operation: ComposerOperation = { ...revision, resourceKind: 'artifact' };
  const inherited = { version: 'artifact-files-v1' as const, files: [{ path: 'base.txt', source: { revision_id: 'base-file-revision', file_id: 'base-file' } }] };
  const current = fields({ format: 'loom-markdown-v3', fileSet: legacy ? undefined : fileSet, base: 'original' });
  const nextFiles = legacy ? inherited : fileSet;
  assert.deepEqual(correctDraft({ operation, fields: current, record: rejected('loom-markdown-v3', legacy ? {} : { file_set: fileSet }),
    comparison: { ...comparison('loom-markdown-v3'), file_set: { ...inherited, manifest_url: '/manifest' } } }), {
    fields: { ...current, base: 'conflict', fileSet: nextFiles },
    body: { resource_id: 'source', expected_revision_id: 'conflict', title: 'Draft title', file_set: nextFiles,
      change_note: null, change_account: null,
      content: { format: 'loom-markdown-v3', references: [], text: current.text, mentions: current.mentions } },
  });
});

test('same-v1 correction and unversioned creation preserve fields without introducing newer envelopes', () => {
  const current = fields({ base: 'original' });
  assert.deepEqual(correctDraft({ operation: revision, fields: current, record: rejected('loom-markdown-v1'), comparison: comparison('loom-markdown-v1') }), {
    fields: { ...current, base: 'conflict' },
    body: { resource_id: 'source', expected_revision_id: 'conflict', title: 'Draft title', content: content() },
  });
  const operation: ComposerOperation = { kind: 'discussion.create', areaId: 'area' }, created = fields();
  assert.deepEqual(correctDraft({ operation, fields: created, record: { state: 'rejected', body: { content: content() } }, comparison: undefined }), {
    fields: created, body: { area_id: 'area', title: 'Draft title', content: content() },
  });
});

for (const attempted of [undefined, { version: 'contribution-attachments-v1' as const, files: [{ path: 'attempted.txt', source: { upload_id: 'private' } }] }]) {
  test('contribution correction carries only unsupported attachment fields and preserves attempted authored metadata '+!!attempted, () => {
    const current = fields({ format: 'loom-markdown-v3', fileSet: attempted, references: [reference], account });
    const base = { ...comparison('loom-markdown-v3'), attachment_set: { version: 'contribution-attachments-v1' as const, files: [{ path: 'base.txt', source: { revision_id: 'conflict', file_id: 'context' } }], manifest_url: '/exact' } };
    const record = rejected('loom-markdown-v3', attempted ? { attachment_set: attempted } : {});
    const result = correctDraft({ operation: revision, fields: current, record, comparison: base })!;
    assert.deepEqual(result.body, { resource_id: 'source', expected_revision_id: 'conflict', title: current.title,
      content: { format: 'loom-markdown-v3', text: current.text, mentions: current.mentions, references: [reference] },
      change_note: null, change_account: account, attachment_set: attempted ?? { version: base.attachment_set.version, files: base.attachment_set.files } });
    assert.equal(result.body.file_set, undefined);
  });
}


test('file-aware correction preserves attempted edits, file assertions and uncertain identity', () => {
  const file = { ...reference, target: { kind: 'artifact' as const, resource_id: 'target', revision_id: 'exact', file_id: 'file', path: 'Report.txt' } };
  const attempted = fields({ format: 'loom-markdown-v3', references: [reference], note, base: 'original' });
  const base = comparison('loom-markdown-v4', [file]);
  const record = rejected('loom-markdown-v3');
  const before = structuredClone(record);
  const next = correctDraft({ operation: revision, fields: attempted, record, comparison: base })!;
  assert.equal(next.fields.format, 'loom-markdown-v4');
  assert.equal(next.fields.references.length, 2);
  assert.deepEqual(next.fields.references[1], file);
  assert.notEqual(next.fields.references[0]!.reference_id, file.reference_id);
  assert.deepEqual({ ...next.fields.references[0], reference_id: reference.reference_id }, reference);
  assert.deepEqual(next.body.content, { format: 'loom-markdown-v4', text: attempted.text, mentions: attempted.mentions, references: next.fields.references });
  assert.deepEqual(record, before);
  assert.equal(correctDraft({ operation: revision, fields: attempted, record: { ...record, state: 'uncertain' }, comparison: base }), undefined);
  const noteFile = { ...note, format: 'loom-markdown-v4' as const, references: [file] };
  assert.equal(buildDraftBody({ operation: revision, fields: fields(), patch: { note: noteFile } }).content.format, 'loom-markdown-v4');
  assert.equal(buildDraftBody({ operation: revision, fields: fields(), patch: { references: [file] } }).content.format, 'loom-markdown-v4');
});

test('file-format refusal retains its exact base for correction without changing unrelated v3 rejection behavior',()=>{
 const attempted=fields({format:'loom-markdown-v3',base:'original',fileSet});
 const record={state:'rejected' as const,body:buildDraftBody({operation:revision,fields:attempted})};
 assert.equal(draftCorrection({operation:revision,record,comparison:undefined}).comparisonRevision,undefined);
 const required={...record,required_format:'loom-markdown-v4' as const};
 assert.equal(draftCorrection({operation:revision,record:required,comparison:undefined}).comparisonRevision,'original');
 assert.equal(correctDraft({operation:revision,fields:attempted,record:required,comparison:undefined}),undefined);
 const next=correctDraft({operation:revision,fields:attempted,record:required,comparison:{...comparison('loom-markdown-v4'),revision_id:'original'}})!;
 assert.equal(next.fields.format,'loom-markdown-v4');assert.deepEqual(next.body.file_set,fileSet);assert.equal(next.body.expected_revision_id,'original');
});

for (const resourceKind of ['artifact','contribution'] as const) for (const format of ['loom-markdown-v3','loom-markdown-v4'] as const) {
 test(`${resourceKind} manifest refusal preserves ${format} intent and adopts only unsupported file citations`,()=>{
  const operation:ComposerOperation={...revision,resourceKind};
  const file={...reference,reference_id:'file-reference',target:{kind:'artifact' as const,resource_id:'target',revision_id:'exact',file_id:'file',path:'Report.txt'}};
  const attempted=fields({format,base:'original',references:[reference]});
  // The manifest refusal happens before the v4 format check and carries neither
  // a conflict ID nor a required_format marker in the durable rejected request.
  const record={state:'rejected' as const,body:buildDraftBody({operation,fields:attempted})};
  const before=structuredClone(record),manifest={version:resourceKind==='artifact'?'artifact-files-v1' as const:'contribution-attachments-v1' as const,files:[{path:'retained.txt',source:{revision_id:'original',file_id:'retained-file'}}]};
  const compare={...comparison('loom-markdown-v4',[file]),revision_id:'original',...(resourceKind==='artifact'?{file_set:{...manifest,version:'artifact-files-v1' as const,manifest_url:'/files'}}:{attachment_set:{...manifest,version:'contribution-attachments-v1' as const,manifest_url:'/attachments'}})};
  const next=correctDraft({operation,fields:attempted,record,comparison:compare})!;
  assert.equal(next.fields.format,'loom-markdown-v4');
  assert.deepEqual(next.body.content,{format:'loom-markdown-v4',text:attempted.text,mentions:attempted.mentions,references:format==='loom-markdown-v3'?[reference,file]:[reference]});
  assert.deepEqual(next.fields.references,format==='loom-markdown-v3'?[reference,file]:[reference]);
  assert.deepEqual(next.body[resourceKind==='artifact'?'file_set':'attachment_set'],manifest);
  assert.deepEqual(record,before);
 });
}
