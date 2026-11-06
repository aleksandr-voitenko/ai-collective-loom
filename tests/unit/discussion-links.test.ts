import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { discussionLinks, discussionLinkLimits } from '../../src/contracts/discussion-links.js';
import { plain } from '../helpers/references.js';
import { parseAuthored, parseAuthoredLinks } from '../../src/contracts/authored.js';

test('ordinary parsed links support canonical local forms and retain exact discussion, resource, revision and attachment destinations', () => {
  const d = randomUUID(),
    c = randomUUID(),
    r = randomUUID(),
    f = randomUUID(),
    origin = 'https://loom.example';
  const paths = [
    `/loom/discussion/${d}`,
    `/loom/discussion/${d}?focus=${c}`,
    `/loom/resource/${c}`,
    `/loom/resource/${c}/${r}`,
    `/api/v1/discussions/${d}`,
    `/api/v1/resources/${c}/revisions/${r}`,
    `/loom/file/contribution/${c}/${r}/${f}`,
    `/api/v1/contributions/${c}/revisions/${r}/attachments/${f}/text/status`,
  ];
  const links = discussionLinks(plain(paths.map((path) => `[target](${path})`).join('\n')), origin);
  assert.deepEqual(
    links.map((link) => link.destination),
    paths,
  );
  for (const prefix of ['', 'https://loom.example', '.', './', '../']) {
    const href =
      prefix === '' || prefix.startsWith('http') || prefix === '.'
        ? prefix + paths[0]
        : prefix + paths[0]!.slice(1);
    assert.equal(discussionLinks(plain(`[target](${href})`), origin)[0]?.destination, paths[0]);
  }
  assert.deepEqual(
    discussionLinks(plain(`[one](${paths[0]}) [two](${origin}${paths[0]})`), origin),
    [links[0]],
  );
});

test('code, nested quotes, bare text, malformed, external and unsupported destinations never infer links', () => {
  const d = randomUUID(),
    path = `/loom/discussion/${d}`,
    link = `[target](${path})`;
  for (const text of [
    '`' + link + '`',
    '```md\n' + link + '\n```',
    '    ' + link,
    '> ' + link,
    '> > ' + link,
    path,
    'https://loom.example' + path,
    `[other](https://other.example${path})`,
    `[credentials](https://user:pass@loom.example${path})`,
    `[fragment](${path}#comment)`,
    `[unknown](${path}?unknown=yes)`,
    `[bad focus](${path}?focus=no)`,
    `[duplicate focus](${path}?focus=${d}&focus=${d})`,
    `[API focus](/api/v1/discussions/${d}?focus=${d})`,
    `[wrong route case](/LOOM/DISCUSSION/${d})`,
    `[API trailing slash](/api/v1/discussions/${d}/)`,
    '[bad](/loom/discussion/not-a-uuid)',
    `[edit](/loom/resource/${d}?edit=1)`,
    `[file](/loom/file/artifact/${d}/${d}/${d})`,
    `[scheme](javascript:alert(1))`,
    `[protocol relative](//other.example${path})`,
  ])
    assert.deepEqual(discussionLinks(plain(text), 'https://loom.example'), [], text);
  assert.equal(discussionLinks(plain(`> ${link}\n\n${link}`), 'https://loom.example').length, 1);
  assert.equal(
    discussionLinks(plain(`<https://loom.example${path}>`), 'https://loom.example').length,
    1,
  );
  // This dialect disables image parsing: ! followed by a normal active link
  // remains text plus a link, with no image or network fetch.
  assert.equal(discussionLinks(plain('!' + link), 'https://loom.example').length, 1);
});

test('link detection has a deterministic bound without rejecting ordinary prose', () => {
  const text = Array.from({ length: 110 }, () => `[x](/loom/discussion/${randomUUID()})`).join(' ');
  assert.equal(
    discussionLinks(plain(text), 'https://loom.example').length,
    discussionLinkLimits.destinations,
  );
});
test('oversized destination URLs remain prose rather than exceeding inferred storage bounds', () => {
  const path = `/loom/discussion/${randomUUID()}?${'&'.repeat(1200)}`;
  assert.equal(discussionLinks(plain(`[padded query](${path})`), 'https://loom.example').length, 0);
});
test('local-link presentation preserves old mention placement and token accounting instead of invalidating retained intent', () => {
  const path = '/loom/discussion/' + randomUUID();
  const legacy = {
    ...plain(`[label [[mention:m]]](${path})`),
    mentions: [{ token: 'm', participant_id: randomUUID() }],
  };
  assert.deepEqual(parseAuthoredLinks(legacy), parseAuthored(legacy));
  assert.deepEqual(discussionLinks(legacy, 'https://loom.example'), []);
  const bounded = plain('*a* '.repeat(1020) + `[x](${path}) `.repeat(8));
  assert.deepEqual(parseAuthoredLinks(bounded), parseAuthored(bounded));
  assert.deepEqual(discussionLinks(bounded, 'https://loom.example'), []);
});
