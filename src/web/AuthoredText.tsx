import { createElement, type ReactNode } from 'react';
import type { Token } from 'markdown-it';
import { parseAuthored } from '../contracts/authored.js';
import type { AuthoredContent } from '../contracts/participation.js';

export function AuthoredText({
  content,
  participants = [],
}: {
  content: AuthoredContent;
  participants?: { id: string; nickname: string }[];
}) {
  let tokens: Token[];
  try {
    tokens = parseAuthored(content);
  } catch {
    return <p>The text representation is unavailable.</p>;
  }
  function render(list: Token[]): ReactNode[] {
    const root: ReactNode[] = [],
      stack: {
        tag: string;
        children: ReactNode[];
        attrs: Record<string, string>;
      }[] = [];
    const add = (node: ReactNode) => (stack.at(-1)?.children ?? root).push(node);
    for (const [index, token] of list.entries()) {
      if (token.nesting === 1) {
        const allowed = new Set([
          'p',
          'h1',
          'h2',
          'h3',
          'h4',
          'h5',
          'h6',
          'strong',
          'em',
          'a',
          'ul',
          'ol',
          'li',
          'blockquote',
        ]);
        const tag = allowed.has(token.tag) ? token.tag : 'span';
        const value = token.attrGet('href'),
          href = typeof value === 'string' ? value : null;
        stack.push({
          tag,
          children: [],
          attrs:
            tag === 'a' && href && /^https?:\/\//i.test(href)
              ? { href, rel: 'noopener noreferrer' }
              : {},
        });
      } else if (token.nesting === -1) {
        const node = stack.pop();
        if (node) add(createElement(node.tag, { ...node.attrs, key: index }, ...node.children));
      } else if (token.type === 'inline')
        add(<span key={index}>{render(token.children ?? [])}</span>);
      else if (token.type === 'fence' || token.type === 'code_block')
        add(
          <pre key={index}>
            <code>{token.content}</code>
          </pre>,
        );
      else if (token.type === 'code_inline') add(<code key={index}>{token.content}</code>);
      else if (token.type === 'softbreak') add('\n');
      else if (token.type === 'hardbreak') add(<br key={index} />);
      else if (token.type === 'hr') add(<hr key={index} />);
      else if (token.type === 'loom_mention') {
        const entity = content.mentions.find((m) => m.token === token.content),
          participant = participants.find((p) => p.id === entity?.participant_id);
        add(
          <span className="mention" key={index} title={entity?.participant_id}>
            @{participant?.nickname ?? 'participant'}
          </span>,
        );
      } else add(token.content);
    }
    return root;
  }
  return <div className="prose">{render(tokens)}</div>;
}
