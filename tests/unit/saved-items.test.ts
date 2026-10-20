import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Value } from '@sinclair/typebox/value';
import { SavedUpdate, SavedStatusInput } from '../../src/contracts/saved-items.js';

test('Saved items requests enforce exact targets, owner isolation and strict types', () => {
  const examples = [
    {
      "idempotency_key": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "target": {
        "kind": "artifact",
        "resource_id": "11111111-1111-4111-8111-111111111111"
      },
      "saved": true,
      "expected_version": 0
    },
    {
      "idempotency_key": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      "target": {
        "kind": "revision",
        "resource_id": "11111111-1111-4111-8111-111111111111",
        "revision_id": "22222222-2222-4222-8222-222222222222"
      },
      "saved": true,
      "expected_version": 0
    },
    {
      "idempotency_key": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      "target": {
        "kind": "artifact",
        "resource_id": "11111111-1111-4111-8111-111111111111"
      },
      "saved": false,
      "expected_version": 1
    },
    {
      "idempotency_key": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    }
  ] as const;
  assert.equal(examples.length, 4);
  for (const example of examples.slice(0,3)) assert.equal(Value.Check(SavedUpdate, example), true);
  assert.equal(Value.Check(SavedStatusInput, examples[3]), true);
  assert.equal(Value.Check(SavedUpdate, { ...examples[0], owner_id: '11111111-1111-4111-8111-111111111111' }), false);
  assert.equal(Value.Check(SavedUpdate, { ...examples[0], expected_version: '0' }), false);
  assert.equal(Value.Check(SavedUpdate, { ...examples[0], target: { ...examples[0].target, revision_id: examples[1].target.revision_id } }), false);
});
