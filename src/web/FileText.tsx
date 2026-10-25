import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import {
  FileTextView,
  FileTextHealth,
  type FileTextValue,
  type FileTextHealthValue,
} from '../contracts/file-text.js';
import { useQuery, type Context } from './participation-state.js';
import { useAuthorization } from './AuthorizationBoundary.js';
import { commandRequest, identityGeneration } from './participation-client.js';
import { ResolvedTarget, type ResolvedTargetView } from '../contracts/references.js';
import { ReferenceViews } from './References.js';

export function FileTextControl({
  base,
  browser,
  path,
}: {
  base: string;
  browser: string;
  path: string;
}) {
  const status = useQuery<FileTextValue>(base + '/text/status', FileTextView);
  return (
    <span className="file-text-control">
      {status.data && (
        <span>
          Text: {status.data.processing.replaceAll('_', ' ')}
          {status.data.reason ? ' · ' + status.data.reason.replaceAll('_', ' ') : ''}.{' '}
        </span>
      )}
      {status.error && <span role="status">Text status could not be checked. </span>}
      {status.data && ['complete', 'partial'].includes(status.data.processing) ? (
        <Link to={browser}>Text preview {path}</Link>
      ) : (
        <Link to={browser}>Text processing {path}</Link>
      )}
    </span>
  );
}

export function FileTextPage({
  kind,
  resource,
  revision,
  file,
}: {
  kind: 'artifact' | 'contribution';
  resource: string;
  revision: string;
  file: string;
}) {
  const location = useLocation(),
    navigate = useNavigate(),
    authority = useAuthorization();
  const cursor = new URLSearchParams(location.search).get('cursor');
  const base = `/api/v1/${kind === 'artifact' ? 'artifacts' : 'contributions'}/${resource}/revisions/${revision}/${kind === 'artifact' ? 'files' : 'attachments'}/${file}`;
  const publication = useQuery<ResolvedTargetView>(
    '/api/v1/references/target?' +
      new URLSearchParams({
        kind,
        resource_id: resource,
        revision_id: revision,
        file_id: file,
      }),
    ResolvedTarget,
  );
  const query = useQuery<FileTextValue>(
    base + '/text' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''),
    FileTextView,
  );
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [status, setStatus] = useState('');
  const live = useRef(true),
    heading = useRef<HTMLHeadingElement>(null),
    statusSequence = useRef(0);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  useEffect(() => {
    if (query.data || query.error) heading.current?.focus();
  }, [query.data, query.error]);
  async function download() {
    const owner = identityGeneration();
    setBusy(true);
    setError('');
    try {
      const bytes = await authority.read<Blob>(base + '/download', { responseType: 'blob' });
      if (!live.current || owner !== identityGeneration()) return;
      const url = URL.createObjectURL(bytes),
        link = document.createElement('a');
      link.href = url;
      link.download = query.data!.path.split('/').at(-1)!;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (reason) {
      if (live.current && owner === identityGeneration()) setError((reason as Error).message);
    } finally {
      if (live.current && owner === identityGeneration()) setBusy(false);
    }
  }
  async function checkStatus() {
    const owner = identityGeneration(),
      sequence = ++statusSequence.current;
    setError('');
    try {
      const result = await authority.read<FileTextValue>(base + '/text/status', {
        schema: FileTextView,
      });
      if (live.current && owner === identityGeneration() && sequence === statusSequence.current)
        setStatus('Exact file processing: ' + result.processing.replaceAll('_', ' '));
    } catch (reason) {
      if (live.current && owner === identityGeneration() && sequence === statusSequence.current)
        setError((reason as Error).message);
    }
  }
  return (
    <section className="file-preview">
      <h1 tabIndex={-1} ref={heading}>
        Literal text preview
      </h1>
      <p>
        Exact resource {resource} · Revision {revision} · File {file}
      </p>
      <button onClick={() => void navigate(-1)}>Back</button>{' '}
      <Link to={`/loom/resource/${resource}/${revision}`}>Open exact publication</Link>
      {publication.data && (
        <>
          <p>
            File: {publication.data.target.path} ·{' '}
            {publication.data.representation.title ?? 'Contribution'}
          </p>
          <Link to={publication.data.context_url}>Owning publication context</Link>
          <ReferenceViews key={file} target={publication.data.target} />
        </>
      )}
      {publication.error && (
        <>
          <p role="alert">{publication.error}</p>
          <button onClick={publication.refresh}>Retry file context</button>
        </>
      )}
      {(query.error || error) && <p role="alert">{query.error || error}</p>}
      {status && <p role="status">{status}</p>}
      {!query.data && !query.error && <p role="status">Checking exact file…</p>}
      {query.data && (
        <>
          <h2>{query.data.path}</h2>
          <p role="status">
            Processing: {query.data.processing.replaceAll('_', ' ')}
            {query.data.reason ? ' · ' + query.data.reason.replaceAll('_', ' ') : ''}. Index:{' '}
            {query.data.indexing.replaceAll('_', ' ')}. Worker: {query.data.worker}.
          </p>
          <p>
            Literal UTF-8, preserving BOM and newlines. {query.data.retained_bytes} retained bytes
            of {query.data.original_bytes} original bytes. This inspection does not mark the
            publication read.
          </p>
          {query.data.processing === 'partial' && (
            <p className="notice">
              Only a bounded prefix was processed. Search cannot match the unprocessed suffix.
              Download the original for all bytes.
            </p>
          )}
          {query.data.text !== null && (
            <pre className="file-literal" tabIndex={0} aria-label="Literal file text">
              {query.data.text}
            </pre>
          )}
          {query.data.text === '' && <p>Empty UTF-8 file.</p>}
          {query.data.next_cursor && (
            <button
              onClick={() =>
                void navigate(
                  location.pathname + '?cursor=' + encodeURIComponent(query.data!.next_cursor!),
                )
              }
            >
              Next text page
            </button>
          )}
          {query.data.retained_text_complete && (
            <p>
              End of retained text.
              {query.data.source_complete
                ? ' The whole file was processed.'
                : ' The original has an unprocessed suffix.'}
            </p>
          )}
          <button disabled={busy} onClick={() => void download()}>
            Download original {query.data.path}
          </button>
        </>
      )}
      {cursor && <Link to={location.pathname}>First text page</Link>}
      <button onClick={query.refresh}>
        {query.error ? 'Retry exact text preview' : 'Refresh text processing'}
      </button>
      <button onClick={() => void checkStatus()}>Check file status</button>
    </section>
  );
}

export function FileTextAdministration({ context }: { context: Context }) {
  const [open, setOpen] = useState(false);
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>File text processing administration</summary>
      {open && <FileTextAdministrationControls context={context} />}
    </details>
  );
}
function FileTextAdministrationControls({ context }: { context: Context }) {
  const [after, setAfter] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const health = useQuery<FileTextHealthValue>(
    '/api/v1/admin/file-text/health' + (after ? '?after=' + after : ''),
    FileTextHealth,
  );
  const live = useRef(true),
    owner = useRef(identityGeneration());
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  async function action(path: string, body: unknown) {
    setBusy(true);
    setError('');
    try {
      await commandRequest(path, { body, self: context.self });
      if (live.current && owner.current === identityGeneration()) health.refreshIfCurrent();
    } catch (reason) {
      if (live.current && owner.current === identityGeneration())
        setError((reason as Error).message);
    } finally {
      if (live.current && owner.current === identityGeneration()) setBusy(false);
    }
  }
  return (
    <section aria-label="File text processing controls">
      {(error || health.error) && <p role="alert">{error || health.error}</p>}
      {health.data && (
        <>
          <p>
            Generation {health.data.generation} · Worker {health.data.worker} ·{' '}
            {health.data.retained_bytes} text bytes retained · {health.data.reserved_bytes} reserved
          </p>
          <details>
            <summary>Rebuild file derivatives</summary>
            <p>
              Reprocess exact retained contexts in bounded batches. Sources and original bytes are
              preserved.
            </p>
            <button
              disabled={busy}
              onClick={() =>
                void action('/api/v1/admin/file-text/rebuild', {
                  expected_generation: health.data!.generation,
                })
              }
            >
              Start file text rebuild
            </button>
          </details>
          {health.data.items.map((job) => (
            <p key={job.file_id}>
              {job.reason} · {job.file_id}{' '}
              <button
                disabled={busy}
                onClick={() =>
                  void action('/api/v1/admin/file-text/retry', {
                    file_id: job.file_id,
                    claim_generation: job.claim_generation,
                  })
                }
              >
                Retry file processing
              </button>
            </p>
          ))}
          {health.data.next_after && (
            <button onClick={() => setAfter(health.data!.next_after!)}>More failed files</button>
          )}
        </>
      )}
      <button onClick={health.refresh}>Refresh file processing health</button>
    </section>
  );
}
