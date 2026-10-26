import { useEffect, useRef, useState } from 'react';
import {
  FilePage,
  AttachmentPage,
  type FilePageValue,
  type AttachmentPageValue,
} from '../contracts/files.js';
import type { ReferenceTargetValue } from '../contracts/participation.js';
import { ResolvedTarget, type ResolvedTargetView } from '../contracts/references.js';
import { useAuthorization } from './AuthorizationBoundary.js';
import { identityGeneration } from './participation-client.js';

/** Selection reads only an exact manifest. It never downloads, previews or saves a file. */
export function ReferenceFilePicker({
  target,
  onSelect,
}: {
  target: ReferenceTargetValue;
  onSelect: (target: ResolvedTargetView) => void;
}) {
  const authority = useAuthorization();
  const [open, setOpen] = useState(false),
    [page, setPage] = useState<FilePageValue | AttachmentPageValue>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  const live = useRef(false),
    sequence = useRef(0),
    position = useRef({ prefix: '', cursor: '' });
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      sequence.current++;
    };
  }, []);
  async function load(prefix = '', cursor = '') {
    const seq = ++sequence.current,
      owner = identityGeneration();
    position.current = { prefix, cursor };
    setBusy(true);
    setError('');
    setOpen(true);
    try {
      const artifact = target.kind === 'artifact';
      const result = await authority.read<FilePageValue | AttachmentPageValue>(
        `/api/v1/${artifact ? 'artifacts' : 'contributions'}/${target.resource_id}/revisions/${target.revision_id}/${artifact ? 'files' : 'attachments'}?` +
          new URLSearchParams({ prefix, ...(cursor ? { cursor } : {}) }),
        { schema: artifact ? FilePage : AttachmentPage },
      );
      if (live.current && seq === sequence.current && owner === identityGeneration()) {
        setPage(result);
        heading.current?.focus();
      }
    } catch (reason) {
      if (live.current && seq === sequence.current && owner === identityGeneration())
        setError((reason as Error).message);
    } finally {
      if (live.current && seq === sequence.current && owner === identityGeneration())
        setBusy(false);
    }
  }
  async function select(file_id: string, path: string) {
    const seq = ++sequence.current,
      owner = identityGeneration();
    setBusy(true);
    setError('');
    try {
      const result = await authority.read<ResolvedTargetView>(
        '/api/v1/references/target?' + new URLSearchParams({ ...target, file_id, path }),
        { schema: ResolvedTarget },
      );
      if (live.current && seq === sequence.current && owner === identityGeneration())
        onSelect(result);
    } catch (reason) {
      if (live.current && seq === sequence.current && owner === identityGeneration())
        setError((reason as Error).message);
    } finally {
      if (live.current && seq === sequence.current && owner === identityGeneration())
        setBusy(false);
    }
  }
  return (
    <div aria-label="Select a published file" aria-busy={busy}>
      <button
        type="button"
        aria-disabled={busy}
        onClick={() => {
          if (!busy) void load();
        }}
      >
        Choose a file from this revision
      </button>
      {open && (
        <>
          <h4 ref={heading} tabIndex={-1}>
            Published files in this exact revision
          </h4>
          {error && (
            <>
              <p role="alert">{error}</p>
              <button
                type="button"
                aria-disabled={busy}
                onClick={() => {
                  if (!busy) void load(position.current.prefix, position.current.cursor);
                }}
              >
                Retry file selection page
              </button>
            </>
          )}
          {busy && <p role="status">Checking published files…</p>}
          {page && (
            <>
              <p>
                Folder: {page.prefix || '/'} · Exact revision {target.revision_id}
              </p>
              {page.prefix && (
                <button
                  type="button"
                  aria-disabled={busy}
                  onClick={() => {
                    if (!busy) void load(page.prefix.split('/').slice(0, -1).join('/'));
                  }}
                >
                  Parent folder
                </button>
              )}
              <ul>
                {page.items.map((item) => (
                  <li key={item.path}>
                    <button
                      type="button"
                      aria-disabled={busy}
                      onClick={() => {
                        if (!busy)
                          void (item.kind === 'folder'
                            ? load(item.path)
                            : select(item.file_id, item.path));
                      }}
                    >
                      {item.kind === 'folder' ? 'Open folder ' : 'Select file '}
                      {item.path}
                    </button>
                  </li>
                ))}
              </ul>
              {page.next_cursor && (
                <button
                  type="button"
                  aria-disabled={busy || !!error}
                  onClick={() => {
                    if (!busy && !error) void load(page.prefix, page.next_cursor!);
                  }}
                >
                  Next files
                </button>
              )}
              {page.complete && <p>End of this folder.</p>}
            </>
          )}
        </>
      )}
    </div>
  );
}
