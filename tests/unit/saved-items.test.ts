import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { Value } from '@sinclair/typebox/value';
import { SavedUpdate, SavedStatusInput } from '../../src/contracts/saved-items.js';

test('release Saved items examples match the strict executable request schemas', async () => {
  const document = await readFile(new URL('../../docs/development/saved-items.md', import.meta.url), 'utf8');
  const examples = [...document.matchAll(/```json\n([\s\S]*?)\n```/g)].map(match => JSON.parse(match[1]!));
  assert.equal(examples.length, 4);
  for (const example of examples.slice(0,3)) assert.equal(Value.Check(SavedUpdate, example), true);
  assert.equal(Value.Check(SavedStatusInput, examples[3]), true);
  assert.equal(Value.Check(SavedUpdate, { ...examples[0], owner_id: '11111111-1111-4111-8111-111111111111' }), false);
  assert.equal(Value.Check(SavedUpdate, { ...examples[0], expected_version: '0' }), false);
  assert.equal(Value.Check(SavedUpdate, { ...examples[0], target: { ...examples[0].target, revision_id: examples[1].target.revision_id } }), false);
});
