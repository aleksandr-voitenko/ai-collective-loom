import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { randomUUID } from "node:crypto";
import { AuthoredText } from "../../src/web/AuthoredText.js";
import { parseAuthored } from "../../src/contracts/authored.js";
import type { AuthoredContent } from "../../src/contracts/participation.js";

const content = (text: string): AuthoredContent => ({
  format: "loom-markdown-v1",
  text,
  mentions: [],
});
test("authored markup is rendered safely without HTML, remote images or executable URLs", () => {
  const result = renderToStaticMarkup(
    <AuthoredText
      content={content(
        '<img src=x onerror="alert(1)">\n\n[unsafe](javascript:alert(1)) ![pixel](https://example.org/pixel)\n\n**Strong** and [source](https://example.org)',
      )}
    />,
  );
  assert.ok(!result.includes("<img"));
  assert.ok(!result.includes('href="javascript:'));
  assert.ok(result.includes("&lt;img"));
  assert.ok(result.includes("<strong>Strong</strong>"));
  assert.ok(result.includes('href="https://example.org"'));
});
test("only explicit ordinary-prose entities resolve stable participant IDs", () => {
  const id = randomUUID(),
    value = {
      ...content("Hello [[mention:m]]. @raw remains text."),
      mentions: [{ token: "m", participant_id: id }],
    };
  const result = renderToStaticMarkup(
    <AuthoredText
      content={value}
      participants={[{ id, nickname: "renamed" }]}
    />,
  );
  assert.match(result, /@renamed/);
  assert.match(result, /@raw remains text/);
  for (const text of [
    "> [[mention:m]]",
    "`[[mention:m]]`",
    "[quote [[mention:m]]](https://example.org)",
    "[[mention:m]] [[mention:m]]",
  ])
    assert.throws(() => parseAuthored({ ...value, text }));
  assert.throws(() => parseAuthored({ ...value, mentions: [] }));
  assert.equal(parseAuthored(content("`@raw`\n\n> @raw")).length > 0, true);
});
test("authored byte and complexity bounds reject malformed or unretrievable input", () => {
  assert.ok(parseAuthored(content("🧵".repeat(4096))).length);
  assert.throws(() => parseAuthored(content("🧵".repeat(4097))));
  assert.throws(() => parseAuthored(content("bad\u0000text")));
  assert.throws(() => parseAuthored(content("\ud800")));
  assert.throws(() => parseAuthored(content("*x* ".repeat(1800))), /complex/);
});
