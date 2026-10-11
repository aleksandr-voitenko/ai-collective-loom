import assert from "node:assert/strict";
import { test } from "node:test";
import { checkDocs, definitions, illustrativeJson } from "../../scripts/check-docs.mjs";

test("imported sources retain hashes, requirements, acceptance mappings, JSON and companion links", async () => {
  assert.deepEqual(await checkDocs(), { requirements: 101, acceptanceScenarios: 61, illustrativeJsonBlocks: 42 });
});
test("duplicate identifier declarations are rejected", () => {
  assert.throws(() => definitions("ID: AC01\nID: AC01", /^ID: (AC\d{2})/gm), /Duplicate/);
});
test("invalid illustrative JSON is not counted as validated", () => {
  assert.throws(() => illustrativeJson('```json\n{bad}\n```'), /Invalid JSON/);
});
