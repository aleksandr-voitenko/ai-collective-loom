import assert from 'node:assert/strict';
import { test } from 'node:test';
import { insertMention } from '../../src/web/composer-mentions.js';
import { parseAuthored } from '../../src/contracts/authored.js';
import type { AuthoredContent } from '../../src/contracts/participation.js';

const mention = { token: 'ada', participant_id: '11111111-1111-4111-8111-111111111111' };
const content = (text: string): AuthoredContent => ({ format: 'loom-markdown-v1', text, mentions: [] });
test('mention insertion respects the caret and selection, with Unicode and surrounding text preserved', () => {
  for (const [text, start, end, expected] of [
    ['Hello world', 6, 6, 'Hello [[mention:ada]] world'],
    ['Hello world', 6, 11, 'Hello [[mention:ada]]'],
    ['🧵 thread', 2, 2, '🧵 [[mention:ada]] thread'],
  ] as const) {
    const result = insertMention(content(text), mention, { start, end });
    assert.equal(result.text, expected);
    assert.equal(result.separateParagraph, false);
    assert.ok(parseAuthored({ ...content(result.text), mentions: [mention] }).length);
  }
});
test('invalid Markdown placement falls back to a separate prose paragraph without deleting the selection', () => {
  for (const [text, start, end] of [
    ['> Quoted ending', 15, 15],
    ['```ts\nconst x = 1;\n```', 10, 15],
    ['[A source](https://example.org)', 3, 6],
  ] as const) {
    const result = insertMention(content(text), mention, { start, end });
    assert.equal(result.text, text + '\n\n[[mention:ada]]');
    assert.equal(result.caret, result.text.length);
    assert.equal(result.separateParagraph, true);
    assert.ok(parseAuthored({ ...content(result.text), mentions: [mention] }).length);
  }
});
test('unclosed code and over-limit content fail without changing the authored input', () => {
  for (const text of ['```ts\nconst x = 1;', 'a'.repeat(16380)]) {
    const original = content(text), copy = structuredClone(original);
    assert.throws(() => insertMention(original, mention, { start: text.length, end: text.length }));
    assert.deepEqual(original, copy);
  }
});

test('readable mention editing retains stable bindings only outside the replaced range', async () => {
  const { mentionPresentation, editMentionPresentation } = await import('../../src/web/composer-mentions.js');
  const bound = { ...content('Hi [[mention:ada]] / [[mention:ada]]!'), mentions: [mention] };
  const names = { [mention.participant_id]: 'Ada' };
  const view = mentionPresentation(bound, names);
  assert.equal(view.text, 'Hi @Ada / @Ada!');
  assert.equal(view.wireOffset(7), 'Hi [[mention:ada]]'.length);
  assert.equal(view.displayOffset('Hi [[mention:ada]]'.length), 7);
  assert.deepEqual(editMentionPresentation(bound, names, 'Hi @Ada / @Ada!?'), { text: bound.text + '?', mentions: [mention] });
  assert.deepEqual(editMentionPresentation(bound, names, 'Hi @Ada / @Ada!', { start: 3, end: 7 }), {
    text: 'Hi @Ada / [[mention:ada]]!', mentions: [mention],
  });
  assert.deepEqual(editMentionPresentation({ text: 'Hi [[mention:ada]]', mentions: [mention] }, names, 'Hi @Ana'), { text: 'Hi @Ana', mentions: [] });
  assert.deepEqual(editMentionPresentation(content('Hi '), names, 'Hi @Ada'), { text: 'Hi @Ada', mentions: [] });
});
