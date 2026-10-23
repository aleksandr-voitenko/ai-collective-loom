import { useAuthorization } from './AuthorizationBoundary.js';
import {
  FileSearchPage,
  FileSearchStatus,
  type FileSearchPageValue,
  type FileSearchStatusValue,
} from '../contracts/file-text.js';
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import {
  SearchPage,
  SearchStatus,
  SearchHealth,
  FailedSearchJobs,
  SearchAuthorsPage,
  type SearchPageView,
  type SearchStatusView,
  type SearchHealthView,
  type SearchAuthorsView,
} from '../contracts/search.js';
import { OrganizationResource, type OrganizationResourceView } from '../contracts/organization.js';
import { TopicDirectory } from './Organization.js';
import { identityGeneration, commandRequest } from './participation-client.js';
import { useQuery, type Context } from './participation-state.js';

export function IndexingNotice({ status }: { status: SearchStatusView | FileSearchStatusValue }) {
  if ('population' in status)
    return (
      <div className="search-indexing">
        <p role="status">
          File text worker: {status.worker}.{' '}
          {status.coverage === 'incomplete'
            ? 'Processing coverage is incomplete.'
            : 'Current eligible files have recorded processing outcomes.'}
        </p>
        <details>
          <summary>Search coverage</summary>
          <p>
            Only current eligible artifact files and opening/comment attachments in the explicit
            UTF-8 allowlist are searched. A partial extraction covers at most 64 KiB; unsupported
            files and unprocessed suffixes are excluded. Pending or failed processing can contain
            unknown matches. Excerpts are partial literal text. The selected relevance window
            contains at most 200 matches. Historical previews and original downloads are
            independent. Summaries have no files in this release.
          </p>
        </details>
      </div>
    );
  return (
    <div className="search-indexing">
      {status.indexing !== 'ready' && (
        <p className="notice" role="status">
          {status.indexing === 'unavailable'
            ? 'The search worker is unavailable.'
            : 'Some current text is still being indexed.'}{' '}
          Search results may be incomplete. You can still browse and open content directly.
        </p>
      )}
      <details>
        <summary>Search coverage</summary>
        <p>
          Current discussion openings, comments, text artifacts and authored summaries only.{' '}
          {status.coverage === 'current_supported_text'
            ? 'All currently eligible supported text is indexed at this observation.'
            : 'Current text coverage has not been established.'}{' '}
          Ranked results use a selected window of at most 200 matches; they are not change history.
          Refresh after edits or indexing changes.
        </p>
      </details>
    </div>
  );
}
function TopicName({ id }: { id: string }) {
  const area = useQuery<OrganizationResourceView>(
    '/api/v1/organization/resources/' + id,
    OrganizationResource,
  );
  return (
    <span>
      {area.data
        ? [...area.data.ancestors.map((a) => a.title), area.data.title].join(' › ')
        : area.error
          ? 'Topic unavailable'
          : 'Loading topic…'}
    </span>
  );
}
function AuthorPicker({ choose }: { choose: (id: string, name: string) => void }) {
  const [cursor, setCursor] = useState('');
  const page = useQuery<SearchAuthorsView>(
    '/api/v1/search/authors' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''),
    SearchAuthorsPage,
  );
  return (
    <section aria-label="Choose original author">
      <h3>Choose original author</h3>
      {page.error && <p role="alert">{page.error}</p>}
      {!page.data && !page.error && <p role="status">Loading authors…</p>}
      {page.data?.items.map((person) => (
        <button type="button" key={person.id} onClick={() => choose(person.id, person.nickname)}>
          {person.nickname} · {person.kind}
        </button>
      ))}
      <button
        type="button"
        disabled={!page.data?.next_cursor}
        onClick={() => setCursor(page.data!.next_cursor!)}
      >
        More authors
      </button>
      <button
        type="button"
        onClick={() => {
          setCursor('');
          page.refresh();
        }}
      >
        Refresh authors
      </button>
    </section>
  );
}
function AuthorName({ id }: { id: string }) {
  const author = useQuery<SearchAuthorsView>(
    '/api/v1/search/authors?author=' + encodeURIComponent(id),
    SearchAuthorsPage,
  );
  return (
    <>
      {author.data?.items[0]?.nickname ??
        (author.error || author.data ? 'Author unavailable' : 'Loading author…')}
    </>
  );
}
export function SearchPageViewComponent({ context: _context }: { context: Context }) {
  const authority = useAuthorization();
  const location = useLocation(),
    navigate = useNavigate(),
    params = new URLSearchParams(location.search);
  const files = params.get('mode') === 'files';
  const [query, setQuery] = useState(params.get('q') ?? ''),
    [topic, setTopic] = useState(params.get('topic') ?? ''),
    [descendants, setDescendants] = useState(params.get('descendants') === 'true'),
    [kind, setKind] = useState(params.get('kind') ?? ''),
    [author, setAuthor] = useState(params.get('author') ?? ''),
    [explanation, setExplanation] = useState(params.get('explanation') ?? ''),
    [from, setFrom] = useState(params.get('from')?.slice(0, 10) ?? ''),
    [before, setBefore] = useState(params.get('before')?.slice(0, 10) ?? ''),
    [topics, setTopics] = useState(false),
    [authors, setAuthors] = useState(false),
    [refresh, setRefresh] = useState(0),
    [data, setData] = useState<SearchPageView | FileSearchPageValue>(),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  // URL state survives exact-result navigation, reload and browser back. Each
  // effect setup owns its response, including development StrictMode's replay.
  useEffect(() => {
    const selected = new URLSearchParams(location.search);
    const fileMode = selected.get('mode') === 'files';
    selected.delete('mode');
    if (fileMode) selected.delete('explanation');
    setQuery(selected.get('q') ?? '');
    setTopic(selected.get('topic') ?? '');
    setDescendants(selected.get('descendants') === 'true');
    setExplanation(new URLSearchParams(location.search).get('explanation') ?? '');
    setKind(selected.get('kind') ?? '');
    setAuthor(selected.get('author') ?? '');
    setFrom(selected.get('from')?.slice(0, 10) ?? '');
    setBefore(selected.get('before')?.slice(0, 10) ?? '');
    let active = true;
    const owner = identityGeneration(),
      controller = new AbortController();
    setData(undefined);
    setError('');
    if (!selected.has('q')) {
      setBusy(false);
      return;
    }
    setBusy(true);
    void authority
      .read<SearchPageView | FileSearchPageValue>(
        (fileMode ? '/api/v1/search/files?' : '/api/v1/search?') + selected,
        {
          schema: fileMode ? FileSearchPage : SearchPage,
          signal: controller.signal,
        },
      )
      .then(
        (value) => {
          if (active && owner === identityGeneration()) {
            setData(value);
            setBusy(false);
            heading.current?.focus();
          }
        },
        (failure) => {
          if (active && owner === identityGeneration() && failure.name !== 'AbortError') {
            setError(failure.message);
            setBusy(false);
          }
        },
      );
    return () => {
      active = false;
      controller.abort();
    };
  }, [location.search, refresh]);
  const status = useQuery<SearchStatusView | FileSearchStatusValue>(
    files ? '/api/v1/search/files/status' : '/api/v1/search/status',
    files ? FileSearchStatus : SearchStatus,
  );
  function submit(mode = files ? 'files' : 'text') {
    const selected = new URLSearchParams(query ? { q: query } : {});
    if (mode === 'files') selected.set('mode', 'files');
    if (topic) {
      selected.set('topic', topic);
      selected.set('descendants', String(descendants));
    }
    if (explanation) selected.set('explanation', explanation);
    if (kind) selected.set('kind', kind);
    if (author) selected.set('author', author);
    if (from) selected.set('from', from + 'T00:00:00Z');
    if (before) selected.set('before', before + 'T00:00:00Z');
    const target = '/loom/search?' + selected;
    if (target === location.pathname + location.search) setRefresh((n) => n + 1);
    else void navigate(target);
  }
  function restart() {
    const selected = new URLSearchParams(location.search);
    selected.delete('cursor');
    const target = '/loom/search?' + selected;
    if (target === location.pathname + location.search) setRefresh((n) => n + 1);
    else void navigate(target);
    status.refresh();
  }
  return (
    <section className="search-page">
      <h1>Search</h1>
      <p className="subtitle">
        Find current shared text or supported file contents and open the exact matching revision.
      </p>
      <label>
        Search mode{' '}
        <select
          aria-label="Search mode"
          value={files ? 'files' : 'text'}
          onChange={(e) => submit(e.target.value)}
        >
          <option value="text">Shared text</option>
          <option value="files">Files</option>
        </select>
      </label>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <label>
          Search terms
          <input
            name="q"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            required
            maxLength={256}
          />
        </label>
        <p className="hint">
          Plain words, all required. No phrases, operators, stemming or substring matching.
        </p>
        <div className="search-filters">
          <label>
            Content kind
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="">{files ? 'All file owners' : 'All text'}</option>
              <option value="discussion">Discussions</option>
              <option value="comment">Comments</option>
              <option value="artifact">{files ? 'Artifacts' : 'Text artifacts'}</option>
              <option value="summary">Discussion summaries</option>
            </select>
          </label>
          <label>
            Change explanations
            <select
              disabled={files}
              value={explanation}
              onChange={(e) => setExplanation(e.target.value)}
            >
              <option value="">All publications</option>
              <option value="revision_note">With a current revision note</option>
              <option value="change_account">Explicit change accounts</option>
            </select>
          </label>
          <label>
            Published from (UTC)
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label>
            Published before (UTC)
            <input type="date" value={before} onChange={(e) => setBefore(e.target.value)} />
          </label>
        </div>
        <p>Topic: {topic ? <TopicName key={topic} id={topic} /> : <span>All topics</span>}</p>
        <button type="button" onClick={() => setTopics((v) => !v)}>
          Choose topic
        </button>
        {topic && (
          <button
            type="button"
            onClick={() => {
              setTopic('');
              setDescendants(false);
            }}
          >
            All topics
          </button>
        )}
        {topic && (
          <label className="search-checkbox">
            <input
              type="checkbox"
              checked={descendants}
              onChange={(e) => setDescendants(e.target.checked)}
            />
            Include descendants
          </label>
        )}
        {topics && (
          <TopicDirectory
            selectionLabel="Choose a search topic"
            select={(area) => {
              setTopic(area.resource_id);
              setTopics(false);
            }}
          />
        )}
        <p>Original author: {author ? <AuthorName key={author} id={author} /> : 'Any author'}</p>
        <button type="button" onClick={() => setAuthors((v) => !v)}>
          Choose author
        </button>
        {author && (
          <button type="button" onClick={() => setAuthor('')}>
            Any author
          </button>
        )}
        {authors && (
          <AuthorPicker
            choose={(id) => {
              setAuthor(id);
              setAuthors(false);
            }}
          />
        )}
        <div className="actions">
          <button className="primary" type="submit">
            {files ? 'Search files' : 'Search shared text'}
          </button>
          <button type="button" onClick={restart}>
            Refresh search
          </button>
        </div>
      </form>
      {(data?.indexing ?? status.data) && (
        <IndexingNotice status={(data?.indexing ?? status.data)!} />
      )}
      {status.error && !data && (
        <p role="status">Indexing status is unavailable. Direct browsing remains available.</p>
      )}
      <h2 tabIndex={-1} ref={heading}>
        Search results
      </h2>
      {busy && <p role="status">Searching…</p>}
      {error && (
        <div role="alert" className="notice error">
          <p>{error}</p>
          <button onClick={() => setRefresh((n) => n + 1)}>Retry search page</button>
          <button onClick={restart}>Start a fresh search</button>
        </div>
      )}
      {data && (
        <>
          <p>
            Results for “{data.query}”.{' '}
            {data.selection_limited
              ? 'Only the selected relevance window is shown. Narrow the filters to explore further.'
              : ''}
          </p>
          <div className="collection">
            {data.ranking === 'simple-file-contents-v1'
              ? data.items.map((item) => (
                  <article className="search-result" key={item.file_id}>
                    <small>
                      {item.kind} file · Matching file contents · {item.extraction} extraction
                    </small>
                    <h3>
                      <Link to={item.browser_url}>{item.path}</Link>
                    </h3>
                    <p>
                      {item.title ?? 'Comment'} · {item.location.map((a) => a.title).join(' › ')}
                    </p>
                    <p className="byline">
                      Original publication by {item.author.nickname} · Revision published by{' '}
                      {item.publisher.nickname} ·{' '}
                      <time dateTime={item.published_at}>
                        {new Date(item.published_at).toLocaleString()}
                      </time>
                    </p>
                    <p>
                      <small>Partial literal text excerpt</small>
                      <br />
                      {item.excerpt}
                    </p>
                    {item.extraction === 'partial' && (
                      <p>Unprocessed suffix excluded from search.</p>
                    )}
                    <Link to={item.browser_url}>Open exact text preview</Link>{' '}
                    <Link to={item.browser_context_url}>Open context</Link>
                  </article>
                ))
              : data.items.map((item) => (
                  <article className="search-result" key={item.result_id}>
                    <small>
                      {item.kind === 'comment'
                        ? 'Comment'
                        : item.kind === 'discussion'
                          ? 'Discussion'
                          : item.kind === 'summary'
                            ? 'Discussion summary'
                            : 'Text artifact'}
                    </small>
                    <h3>
                      <Link to={item.browser_url}>
                        {item.title ?? 'Comment by ' + item.author.nickname}
                      </Link>
                    </h3>
                    <p>{item.location.map((a) => a.title).join(' › ')}</p>
                    <p className="byline">
                      By {item.author.nickname} · Revision published by {item.publisher.nickname} ·{' '}
                      <time dateTime={item.published_at}>
                        {new Date(item.published_at).toLocaleString()}
                      </time>
                    </p>
                    <p className="fineprint">
                      Matching{' '}
                      {item.matching_fields
                        .map((field) =>
                          field === 'change_note' ? 'revision note' : 'main content',
                        )
                        .join(' and ')}
                      {item.change_account ? ' · Explicit change account' : ''}
                    </p>
                    <p>
                      <small>
                        {item.excerpt.field === 'change_note' ? 'Revision note excerpt' : 'Excerpt'}
                      </small>
                      <br />
                      {item.excerpt.text}
                    </p>
                    <Link to={item.browser_context_url}>Open context</Link>
                  </article>
                ))}
          </div>
          {!data.items.length && (
            <p>
              {data.indexing.coverage === 'current_supported_text' ||
              data.indexing.coverage === 'retained_prefixes_ready'
                ? 'No matching results in this selection.'
                : 'No indexed matches in this selection yet. Indexing is incomplete.'}
            </p>
          )}
          {data.next_cursor && (
            <button
              onClick={() => {
                const next = new URLSearchParams(location.search);
                next.set('cursor', data.next_cursor!);
                void navigate('/loom/search?' + next);
              }}
            >
              Next search results
            </button>
          )}
          {data.window_exhausted && (
            <p>
              End of this selected search window. This does not mean all history has been searched.
            </p>
          )}
        </>
      )}
    </section>
  );
}

export function SearchAdministration({ context }: { context: Context }) {
  const health = useQuery<SearchHealthView>('/api/v1/admin/search/health', SearchHealth);
  const [after, setAfter] = useState(''),
    [version, setVersion] = useState(0),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false);
  const failed = useQuery<{
    items: {
      id: string;
      failure: string;
      attempts: number;
      claim_generation: number;
      generation: number;
    }[];
    next_after: string | null;
  }>('/api/v1/admin/search/failures' + (after ? '?after=' + after : ''), FailedSearchJobs);
  const owner = useRef(identityGeneration()),
    live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const owned = () => live.current && owner.current === identityGeneration();
  async function action(path: string, body: unknown) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await commandRequest(path, { body, self: context.self });
      if (owned()) {
        setNotice('Search maintenance request accepted. Refresh health to inspect progress.');
        health.refreshIfCurrent();
        failed.refreshIfCurrent();
        setVersion((n) => n + 1);
      }
    } catch (e) {
      if (owned()) setError((e as Error).message);
    } finally {
      if (owned()) setBusy(false);
    }
  }
  return (
    <details className="card search-admin">
      <summary>Search indexing administration</summary>
      {health.error && <p role="alert">{health.error}</p>}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {health.data && (
        <>
          <p>
            Generation {health.data.generation} · Worker{' '}
            {health.data.worker_available ? 'available' : 'unavailable'} · Initial scan{' '}
            {health.data.scan_complete ? 'finished' : 'in progress'}
          </p>
          <p>
            {Object.entries(health.data.jobs)
              .map(([state, n]) => `${n} ${state}`)
              .join(' · ')}
          </p>
          {health.data.capacity_limited && (
            <p role="alert">Synthetic search capacity reached. Direct retrieval is independent.</p>
          )}
          <details key={version}>
            <summary>Rebuild derived index</summary>
            <p>
              Starts a resumable scan of retained sources. Search coverage will be incomplete until
              it finishes. Source publications and Saved items are preserved.
            </p>
            <button
              disabled={busy}
              onClick={() =>
                void action('/api/v1/admin/search/rebuild', {
                  expected_generation: health.data!.generation,
                })
              }
            >
              Start search rebuild
            </button>
          </details>
        </>
      )}
      <button
        onClick={() => {
          health.refresh();
          failed.refresh();
        }}
      >
        Refresh search health
      </button>
      <h3>Failed search jobs</h3>
      {failed.error && <p role="alert">{failed.error}</p>}
      {failed.data?.items.map((job) => (
        <div key={job.id}>
          <p>
            {job.failure} · {job.attempts} attempts · generation {job.generation}
          </p>
          <details>
            <summary>Job reference</summary>
            {job.id}
          </details>
          <button
            disabled={busy || job.generation !== health.data?.generation}
            onClick={() =>
              void action('/api/v1/admin/search/retry', {
                id: job.id,
                claim_generation: job.claim_generation,
              })
            }
          >
            Retry failed job
          </button>
        </div>
      ))}
      {failed.data && !failed.data.items.length && <p>No failed jobs on this page.</p>}
      {failed.data?.next_after && (
        <button onClick={() => setAfter(failed.data!.next_after!)}>More failed jobs</button>
      )}
    </details>
  );
}
