import { parseAuthored } from '../contracts/authored.js';
import type { AuthoredContent } from '../contracts/participation.js';

export function insertMention(
  content: AuthoredContent,
  mention: AuthoredContent['mentions'][number],
  selection: { start: number; end: number },
): { text: string; caret: number; separateParagraph: boolean } {
  const marker = `[[mention:${mention.token}]]`;
  const start = Math.max(0, Math.min(selection.start, content.text.length));
  const end = Math.max(start, Math.min(selection.end, content.text.length));
  const before = content.text.slice(0, start),
    after = content.text.slice(end);
  const insertion = `${before && !/\s$/.test(before) ? ' ' : ''}${marker}${after && !/^\s/.test(after) ? ' ' : ''}`;
  const valid = (text: string) => {
    try {
      parseAuthored({ ...content, text, mentions: [...content.mentions, mention] });
      return true;
    } catch {
      return false;
    }
  };
  const text = before + insertion + after;
  if (valid(text))
    return { text, caret: before.length + insertion.length, separateParagraph: false };
  // A picker must not turn quoted/code text into a notifying entity. A separate
  // prose paragraph preserves the original selection when the caret is in markup.
  const separate = content.text + (content.text ? '\n\n' : '') + marker;
  if (valid(separate)) return { text: separate, caret: separate.length, separateParagraph: true };
  throw new Error(
    'Move the cursor outside quotes, links, and code, and check your Markdown before adding a mention.',
  );
}
