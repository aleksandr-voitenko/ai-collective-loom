import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { AuthorizationBoundary, useAuthorization } from './AuthorizationBoundary.js';
import { ApiError, identityGeneration } from './participation-client.js';
import {
  DiscussionBacklinkPage,
  type DiscussionBacklinkPageView,
} from '../contracts/references.js';

export function MentionedIn({ discussion }: { discussion: string }) {
  const [opened, setOpened] = useState(false);
  return (
    <details
      className="mentioned-in"
      onToggle={(event) => {
        if (event.currentTarget.open) setOpened(true);
      }}
    >
      <summary>Mentioned in</summary>
      {opened && (
        <AuthorizationBoundary scope={'discussion-backlinks:' + discussion}>
          <BacklinkResults key={discussion} discussion={discussion} />
        </AuthorizationBoundary>
      )}
    </details>
  );
}

export function BacklinkResults({ discussion }: { discussion: string }) {
  const authority = useAuthorization();
  const [loaded, setLoaded] = useState<{
      page: DiscussionBacklinkPageView;
      cursor: string | null;
    }>(),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [restart, setRestart] = useState(false);
  const live = useRef(false),
    sequence = useRef(0),
    attempt = useRef<string | null>(null),
    heading = useRef<HTMLHeadingElement>(null);
  const data = loaded?.page;
  async function load(cursor: string | null, focus = false) {
    const seq = ++sequence.current,
      owner = identityGeneration();
    attempt.current = cursor;
    setBusy(true);
    setError('');
    setRestart(false);
    try {
      const result = await authority.read<DiscussionBacklinkPageView>(
        `/api/v1/discussions/${discussion}/mentioned-in?` +
          new URLSearchParams({ limit: '12', ...(cursor ? { cursor } : {}) }),
        { schema: DiscussionBacklinkPage },
      );
      if (live.current && seq === sequence.current && owner === identityGeneration()) {
        setLoaded({ page: result, cursor });
        if (focus) heading.current?.focus();
      }
    } catch (failure) {
      if (live.current && seq === sequence.current && owner === identityGeneration()) {
        setError((failure as Error).message);
        setRestart(failure instanceof ApiError && failure.code === 'references_changed');
      }
    } finally {
      if (live.current && seq === sequence.current && owner === identityGeneration())
        setBusy(false);
    }
  }
  useEffect(() => {
    live.current = true;
    void load(null);
    return () => {
      live.current = false;
      sequence.current++;
    };
  }, [discussion]);
  return (
    <section aria-label="Automatic discussion backlinks" aria-busy={busy}>
      <h3 ref={heading} tabIndex={-1}>
        Links from published contributions
      </h3>
      <p className="fineprint">
        Automatic links are navigation, not endorsements or recorded reference relationships. Only
        current published text is included.
      </p>
      {busy && <p role="status">Loading mentions…</p>}
      {error && (
        <>
          <p role="alert">{error}</p>
          {data && <p>The previous page remains visible; refresh to check current links.</p>}
          {!restart && (
            <button onClick={() => void load(attempt.current, true)}>Retry mentions page</button>
          )}
        </>
      )}
      <button
        aria-disabled={busy}
        onClick={() => {
          if (!busy) void load(null, true);
        }}
      >
        Refresh mentions
      </button>
      {data && (
        <>
          <ul className="reference-list">
            {data.items.map((item) => (
              <li className="reference-row" key={item.source.revision_id}>
                <Link to={item.source_context_url}>
                  {item.discussion_title ?? 'Discussion context'}
                </Link>
                <p>
                  <Link to={item.source_browser_url}>
                    {item.source.parent_id ? 'Comment' : 'Opening post'} · revision{' '}
                    {item.source.revision_number}
                  </Link>
                </p>
                <p className="fineprint">
                  By {item.source.author.nickname}
                  {item.source.publisher.id !== item.source.author.id && (
                    <> · revised by {item.source.publisher.nickname}</>
                  )}
                  {' · '}
                  <time dateTime={item.source.created_at}>
                    {new Date(item.source.created_at).toLocaleString()}
                  </time>
                </p>
              </li>
            ))}
          </ul>
          {!busy && !error && !data.items.length && (
            <p>
              {data.complete
                ? loaded?.cursor
                  ? 'End of recorded mentions.'
                  : 'No recorded mentions yet. Earlier text is included only when revised.'
                : 'No eligible mentions in this bounded page. More candidates remain.'}
            </p>
          )}
          {data.work_budget_reached && (
            <p className="fineprint">This page reached its scan limit.</p>
          )}
          {data.next_cursor && (
            <button
              aria-disabled={busy || !!error}
              onClick={() => {
                if (!busy && !error) void load(data.next_cursor, true);
              }}
            >
              Next mentions
            </button>
          )}
        </>
      )}
    </section>
  );
}
