import MarkdownIt, { type Token } from 'markdown-it';
import { Value } from '@sinclair/typebox/value';
import {
  Content,
  limits,
  type AuthoredContent,
  type NoteContent,
  type ChangeAccountValue,
} from './participation.js';

// Parse once using the same bounded dialect in browser and server. No raw HTML,
// image fetches, autolinking, embedded applications, or inferred @name entities.
const markdown = new MarkdownIt('commonmark', {
  html: false,
  linkify: false,
  maxNesting: 20,
}).disable(['image', 'html_block', 'html_inline']);
markdown.validateLink = (value) => /^https?:\/\//i.test(value);
markdown.inline.ruler.before('link', 'loom_mention', (state, silent) => {
  // Link-label lookahead must count the token's brackets normally. Consuming it
  // in silent mode would turn a linked mention into apparently ordinary prose.
  if (silent) return false;
  const match = /^\[\[mention:([a-z][a-z0-9_]{0,31})\]\]/.exec(state.src.slice(state.pos));
  if (!match) return false;
  if (!silent) {
    const token = state.push('loom_mention', 'span', 0);
    token.content = match[1]!;
  }
  state.pos += match[0].length;
  return true;
});
export function parseAuthored(content: AuthoredContent): Token[] {
  if (
    !Value.Check(Content, content) ||
    new TextEncoder().encode(content.text).length > limits.textBytes ||
    content.text.includes('\0') ||
    !validUnicode(content.text)
  )
    throw new Error('Invalid authored text.');
  if (content.format !== 'loom-markdown-v1') {
    const ids = new Set<string>(),
      targets = new Set<string>();
    let bytes = new TextEncoder().encode(content.text).length;
    for (const ref of content.references) {
      const id = ref.reference_id.toLowerCase();
      const target = JSON.stringify([
        ref.target.resource_id.toLowerCase(),
        ref.target.revision_id?.toLowerCase() ?? null,
      ]);
      const rationale = ref.rationale;
      if (
        ids.has(id) ||
        targets.has(target) ||
        (ref.target.kind === 'discussion' && ref.target.revision_id) ||
        (['builds_on', 'contradicts'].includes(ref.relationship ?? '') && !rationale?.trim()) ||
        (rationale !== null &&
          (!validUnicode(rationale) ||
            rationale.includes('\0') ||
            new TextEncoder().encode(rationale).length > limits.rationaleBytes))
      )
        throw new Error('Invalid or duplicate recorded reference.');
      ids.add(id);
      targets.add(target);
      bytes += new TextEncoder().encode(rationale ?? '').length;
    }
    if (bytes > limits.textBytes)
      throw new Error('Text and reference rationales exceed the authored byte limit.');
  }
  const tokens = markdown.parse(content.text, {});
  const entities = new Map(content.mentions.map((entity) => [entity.token, entity]));
  if (entities.size !== content.mentions.length) throw new Error('Duplicate mention token.');
  const used = new Set<string>();
  let count = 0,
    quoteDepth = 0;
  const inspect = (token: Token, inLink = false) => {
    if (++count > limits.parserTokens) throw new Error('Authored text is too complex.');
    if (token.type === 'blockquote_open') quoteDepth++;
    if (token.type === 'blockquote_close') quoteDepth--;
    if (token.type === 'loom_mention') {
      if (quoteDepth || inLink || !entities.has(token.content) || used.has(token.content))
        throw new Error('Mention must occur once in ordinary prose.');
      used.add(token.content);
    }
    let link = inLink;
    for (const child of token.children ?? []) {
      if (child.type === 'link_open') link = true;
      inspect(child, link);
      if (child.type === 'link_close') link = false;
    }
  };
  tokens.forEach((token) => inspect(token));
  if (used.size !== entities.size)
    throw new Error('Every mention requires one explicit prose token.');
  return tokens;
}

export function validUnicode(text: string) {
  return new TextDecoder().decode(new TextEncoder().encode(text)) === text;
}

/** Fields are versioned as a publication, not silently defaulted into old intent. */
export function validateChangeFields(
  content: AuthoredContent,
  fields: {
    change_note?: NoteContent | null;
    change_account?: ChangeAccountValue | null;
  },
) {
  if (content.format !== 'loom-markdown-v3') {
    if ('change_note' in fields || 'change_account' in fields)
      throw new Error('Change fields require loom-markdown-v3.');
    return;
  }
  if (!('change_note' in fields) || !('change_account' in fields))
    throw new Error('V3 requires explicit change_note and change_account, using null when absent.');
  const note = fields.change_note;
  const fieldsToParse = note ? [content, note] : [content];
  let tokens = 0;
  const count = (token: Token) => {
    tokens++;
    token.children?.forEach(count);
  };
  for (const field of fieldsToParse) parseAuthored(field).forEach(count);
  const bytes = (field: AuthoredContent) =>
    new TextEncoder().encode(field.text).length +
    (field.format === 'loom-markdown-v1'
      ? 0
      : field.references.reduce(
          (sum, ref) => sum + new TextEncoder().encode(ref.rationale ?? '').length,
          0,
        ));
  if (
    (note && bytes(note) > limits.noteBytes) ||
    fieldsToParse.reduce((sum, field) => sum + bytes(field), 0) > limits.textBytes ||
    fieldsToParse.reduce((sum, field) => sum + field.mentions.length, 0) > limits.mentions ||
    fieldsToParse.reduce((sum, field) => sum + field.references.length, 0) > limits.references ||
    tokens > limits.parserTokens
  )
    throw new Error('Combined authored fields exceed the synthetic limit.');
  if (fields.change_account && 'revisions' in fields.change_account) {
    const members = fields.change_account.revisions.map(
      (target) => `${target.resource_id.toLowerCase()}/${target.revision_id.toLowerCase()}`,
    );
    if (new Set(members).size !== members.length) throw new Error('Duplicate described revision.');
  }
}
