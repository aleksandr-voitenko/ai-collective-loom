import { readFile, access } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export function definitions(text, pattern) {
  const identifiers = [...text.matchAll(pattern)].map((match) => match[1]);
  assert.equal(identifiers.length, new Set(identifiers).size, "Duplicate declared identifiers.");
  return identifiers.sort();
}
export function illustrativeJson(text) {
  return [...text.matchAll(/```json\s*\n([\s\S]*?)\n```/g)].map((match, index) => {
    try { return JSON.parse(match[1]); }
    catch { throw new Error(`Invalid JSON in illustrative block ${index + 1}.`); }
  });
}

export async function checkDocs(root = ROOT) {
  const manifest = JSON.parse(await readFile(resolve(root, "docs/baselines.json"), "utf8"));
  const sourceTexts = new Map();
  for (const record of [manifest.product, ...manifest.architecture]) {
    const bytes = await readFile(resolve(root, record.path));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), record.sha256, `Baseline changed: ${record.path}. Review the source and manifest deliberately; do not weaken this check.`);
    sourceTexts.set(record.path, bytes.toString("utf8"));
  }
  const product = sourceTexts.get(manifest.product.path);
  const architecture = [...sourceTexts.entries()].find(([p]) => p.endsWith("/ai-collective-loom-architecture-v0.3.md"));
  const matrix = [...sourceTexts.entries()].find(([p]) => p.includes("-traceability-"));
  const examples = [...sourceTexts.entries()].find(([p]) => p.includes("-contract-examples-"));
  assert.ok(architecture && matrix && examples, "Architecture package is incomplete.");
  const requirements = definitions(product, /^\*\*([A-Z]{3,4}-\d{2}) —/gm);
  const mappings = definitions(matrix[1], /^\| \*\*([A-Z]{3,4}-\d{2})\*\* —/gm);
  const acceptance = definitions(product, /^\| (AC\d{2}) \|/gm);
  const acceptanceMappings = definitions(matrix[1], /^\| \*\*(AC\d{2})\*\* \|/gm);
  assert.deepEqual(mappings, requirements);
  assert.deepEqual(acceptanceMappings, acceptance);
  assert.equal(requirements.length, 101);
  assert.equal(acceptance.length, 61);
  const examplesCount = illustrativeJson(examples[1]).length;
  assert.equal(examplesCount, 42);
  for (const [path, text] of sourceTexts) {
    // Original architecture companions use relative file links; preserve all three
    // together rather than rewriting source text just to move them into docs/.
    for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const link = match[1];
      if (link.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(link)) continue;
      await access(resolve(root, dirname(path), decodeURIComponent(link.split("#")[0])));
    }
  }
  assert.doesNotMatch(architecture[1], /KaikiChat|^#{1,6}.*(?:changelog|revision history)/im);
  return { requirements: requirements.length, acceptanceScenarios: acceptance.length, illustrativeJsonBlocks: examplesCount };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  checkDocs().then((result) => console.log("Document checks passed:", JSON.stringify(result), "(not product acceptance)."))
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}
