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

export type MentionSelection = { start: number; end: number };

/** Presentation offsets are never notification identity. Only untouched bindings survive an edit. */
export function mentionPresentation(
  content: Pick<AuthoredContent, 'text' | 'mentions'>,
  names: Record<string, string>,
) {
  const spans: { start: number; end: number; wireStart: number; wireEnd: number; token: string }[] =
    [];
  let text = '',
    offset = 0;
  for (const match of content.text.matchAll(/\[\[mention:([^\]]+)\]\]/g)) {
    const mention = content.mentions.find((value) => value.token === match[1]);
    if (!mention) continue;
    text += content.text.slice(offset, match.index);
    const label = '@' + (names[mention.participant_id] ?? 'participant');
    spans.push({
      start: text.length,
      end: text.length + label.length,
      wireStart: match.index,
      wireEnd: match.index + match[0].length,
      token: mention.token,
    });
    text += label;
    offset = match.index + match[0].length;
  }
  text += content.text.slice(offset);
  function wireOffset(position: number) {
    let delta = 0;
    for (const span of spans) {
      if (position > span.start && position < span.end) return span.wireStart;
      if (position >= span.end) delta += span.wireEnd - span.wireStart - (span.end - span.start);
    }
    return position + delta;
  }
  function displayOffset(position: number) {
    let delta = 0;
    for (const span of spans) {
      if (position > span.wireStart && position < span.wireEnd) return span.start;
      if (position >= span.wireEnd)
        delta += span.wireEnd - span.wireStart - (span.end - span.start);
    }
    return position - delta;
  }
  return { text, spans, wireOffset, displayOffset };
}

export function editMentionPresentation(
  content: Pick<AuthoredContent, 'text' | 'mentions'>,
  names: Record<string, string>,
  value: string,
  replaced?: MentionSelection,
) {
  const before = mentionPresentation(content, names);
  let start = 0,
    end = before.text.length,
    nextEnd = value.length;
  while (start < end && start < nextEnd && before.text[start] === value[start]) start++;
  while (end > start && nextEnd > start && before.text[end - 1] === value[nextEnd - 1]) {
    end--;
    nextEnd--;
  }
  if (
    replaced &&
    value.startsWith(before.text.slice(0, replaced.start)) &&
    value.endsWith(before.text.slice(replaced.end))
  ) {
    start = replaced.start;
    end = replaced.end;
    nextEnd = value.length - (before.text.length - end);
  }
  // A paste replacing an identical label still removes the original binding.
  const touched = (span: (typeof before.spans)[number]) =>
    (start < span.end && end > span.start) ||
    (start === end && start > span.start && start < span.end) ||
    (!!replaced && replaced.start < span.end && replaced.end > span.start);
  let text = value;
  const retained = before.spans.filter((span) => !touched(span));
  for (const span of [...retained].reverse()) {
    const shift = span.start >= end ? nextEnd - end : 0;
    text =
      text.slice(0, span.start + shift) +
      `[[mention:${span.token}]]` +
      text.slice(span.end + shift);
  }
  return {
    text,
    mentions: content.mentions.filter((mention) =>
      retained.some((span) => span.token === mention.token),
    ),
  };
}
