import { authoredLink, parseAuthoredLinks } from './authored.js';
import type { AuthoredContent } from './participation.js';

export const discussionLinkLimits = Object.freeze({
  destinations: 100,
  destinationBytes: 1024,
  scan: 20,
});
export type DiscussionLink = {
  kind: 'discussion' | 'resource' | 'file';
  resource_id: string;
  revision_id?: string;
  file_id?: string;
  focus_id?: string;
  destination: string;
};
const id = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const discussion = new RegExp(`^/(?:loom/discussion/(${id})/?|api/v1/discussions/(${id}))$`);
const resource = new RegExp(
  `^/(?:loom/resource/(${id})(?:/(${id}))?/?|api/v1/resources/(${id})(?:/revisions/(${id}))?)$`,
);
const file = new RegExp(
  `^/(?:loom/file/contribution/(${id})/(${id})/(${id})/?|api/v1/contributions/(${id})/revisions/(${id})/attachments/(${id})/(?:download|text(?:/status)?))$`,
);

/** Inspect only active Markdown link tokens in ordinary prose. Quotation is
 * evidence of quoted text, not a new link by the publishing participant. */
export function discussionLinks(content: AuthoredContent, origin: string): DiscussionLink[] {
  const links = new Map<string, DiscussionLink>();
  let quoteDepth = 0;
  for (const token of parseAuthoredLinks(content)) {
    if (token.type === 'blockquote_open') quoteDepth++;
    if (token.type === 'blockquote_close') quoteDepth--;
    if (quoteDepth || token.type !== 'inline') continue;
    for (const child of token.children ?? []) {
      if (child.type !== 'link_open' || links.size === discussionLinkLimits.destinations) continue;
      const href = child.attrGet('href');
      if (typeof href !== 'string' || /[\\\u0000-\u0020]/.test(href)) continue;
      const safe = authoredLink(href);
      if (!safe) continue;
      let url: URL;
      try {
        url = new URL(safe, origin + '/');
      } catch {
        continue;
      }
      if (url.origin !== origin || url.username || url.password || url.hash) continue;
      const d = discussion.exec(url.pathname),
        r = resource.exec(url.pathname),
        f = file.exec(url.pathname);
      let link: DiscussionLink | undefined;
      if (d) {
        const keys = [...url.searchParams.keys()];
        const focus = url.searchParams.get('focus');
        if (
          keys.length &&
          (!url.pathname.startsWith('/loom/discussion/') ||
            keys.length !== 1 ||
            keys[0] !== 'focus' ||
            !focus ||
            !new RegExp(`^${id}$`, 'i').test(focus))
        )
          continue;
        link = {
          kind: 'discussion',
          resource_id: (d[1] ?? d[2])!.toLowerCase(),
          ...(focus ? { focus_id: focus.toLowerCase() } : {}),
          destination: url.pathname + url.search,
        };
      } else if (!url.search && r) {
        link = {
          kind: 'resource',
          resource_id: (r[1] ?? r[3])!.toLowerCase(),
          ...((r[2] ?? r[4]) ? { revision_id: (r[2] ?? r[4])!.toLowerCase() } : {}),
          destination: url.pathname,
        };
      } else if (!url.search && f) {
        link = {
          kind: 'file',
          resource_id: (f[1] ?? f[4])!.toLowerCase(),
          revision_id: (f[2] ?? f[5])!.toLowerCase(),
          file_id: (f[3] ?? f[6])!.toLowerCase(),
          destination: url.pathname,
        };
      }
      // Unsupported URLs must never turn an ordinary publication into a storage
      // refusal, including query padding ignored by URLSearchParams.
      if (
        link &&
        new TextEncoder().encode(link.destination).length <= discussionLinkLimits.destinationBytes
      )
        links.set(link.destination, link);
    }
  }
  return [...links.values()];
}
