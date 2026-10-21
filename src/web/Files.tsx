import { useEffect, useRef, useState } from 'react';
import {
  FilePage,
  UploadStatus,
  fileLimits,
  normalizeFilePath,
  normalizeFileSet,
  type FilePageValue,
  type FileSetValue,
  type UploadInputValue,
  type UploadStatusValue,
} from '../contracts/files.js';
import {
  commandRequest,
  identityGeneration,
  isDefinitiveRejection,
  type Intent,
} from './participation-client.js';
import { useAuthorization } from './AuthorizationBoundary.js';
import { useQuery, type Context } from './participation-state.js';

export async function fileDigest(file: Blob) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()))]
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('');
}

export function FileEditor({
  context,
  target,
  value,
  disabled,
  onChange,
  onPending,
}: {
  context: Context;
  target: UploadInputValue['target'];
  value: FileSetValue | undefined;
  disabled: boolean;
  onChange: (value: FileSetValue) => Promise<boolean>;
  onPending: (pending: boolean) => void;
}) {
  const [records, setRecords] = useState(() =>
    context.store
      .all()
      .filter(
        (r) =>
          r.kind === 'file.upload' &&
          (r.body.target as UploadInputValue['target']).resource_id.toLowerCase() ===
            target.resource_id.toLowerCase(),
      ),
  );
  const [selected, setSelected] = useState<File>(),
    [path, setPath] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [statuses, setStatuses] = useState<Record<string, UploadStatusValue>>({}),
    [ignored, setIgnored] = useState<string[]>([]);
  const bytes = useRef(new Map<string, File>()),
    live = useRef(true),
    latest = useRef({ value, onChange });
  latest.current = { value, onChange };
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const refresh = () =>
    setRecords(
      context.store
        .all()
        .filter(
          (r) =>
            r.kind === 'file.upload' &&
            (r.body.target as UploadInputValue['target']).resource_id.toLowerCase() ===
              target.resource_id.toLowerCase(),
        ),
    );
  useEffect(() => {
    window.addEventListener('storage', refresh);
    return () => window.removeEventListener('storage', refresh);
  }, []);
  const pending =
    records.some((r) => r.state !== 'committed' && !ignored.includes(r.key)) || !!selected || busy;
  useEffect(() => {
    onPending(pending);
  }, [pending]);
  async function action(work: () => Promise<void>) {
    const owner = identityGeneration();
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (failure) {
      if (live.current && owner === identityGeneration()) setError((failure as Error).message);
    } finally {
      if (live.current && owner === identityGeneration()) {
        setBusy(false);
        refresh();
      }
    }
  }
  async function retain() {
    if (!selected || disabled) return;
    const file = selected,
      owner = identityGeneration();
    if (file.size > fileLimits.fileBytes) throw new Error('Choose a file no larger than 4 MiB.');
    const normalized = normalizeFilePath(path),
      digest = await fileDigest(file);
    if (!live.current || owner !== identityGeneration()) return;
    const record = await context.store.save(
      context.store.create(
        'file.upload:' + target.resource_id + ':' + crypto.randomUUID(),
        'file.upload',
        '/api/v1/file-uploads',
        {
          target,
          path: normalized,
          size: file.size,
          sha256: digest,
          media_type: /^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/.test(file.type)
            ? file.type
            : 'application/octet-stream',
        },
      ),
    );
    if (!live.current || owner !== identityGeneration()) return;
    bytes.current.set(record.key, file);
    setSelected(undefined);
    setPath('');
  }
  async function usePrepared(record: Intent, status: UploadStatusValue) {
    const current = latest.current,
      member = { path: String(record.body.path), source: { upload_id: status.upload_id } };
    const existing = current.value?.files ?? [];
    const set = normalizeFileSet({
      version: 'artifact-files-v1',
      files: existing.some(
        (m) => 'upload_id' in m.source && m.source.upload_id === status.upload_id,
      )
        ? existing
        : [...existing, member],
    });
    if (await current.onChange(set)) {
      if (record.state === 'uncertain') await context.store.settle(record, { state: 'committed' });
      bytes.current.delete(record.key);
    }
  }
  async function recover(record: Intent) {
    const owner = identityGeneration();
    const result = await commandRequest<UploadStatusValue | { operation_state: string }>(
      '/api/v1/file-uploads/status',
      { self: context.self, body: { idempotency_key: record.key } },
    );
    if (live.current && owner === identityGeneration()) {
      if ('upload_id' in result) setStatuses((values) => ({ ...values, [record.key]: result }));
      else
        setError(
          'No recorded upload yet. The original request remains recoverable with its exact metadata.',
        );
    }
  }
  async function upload(record: Intent) {
    const owner = identityGeneration(),
      owned = () => live.current && owner === identityGeneration();
    const intent = await context.store.prepareDispatch(record, record.body);
    let status: UploadStatusValue;
    try {
      status = await commandRequest<UploadStatusValue>('/api/v1/file-uploads', {
        self: context.self,
        body: intent.body,
        schema: UploadStatus,
      });
    } catch (failure) {
      // Only the first metadata dispatch can be settled by its direct refusal.
      // Later byte/finalization failures do not erase a recorded upload intent.
      if (isDefinitiveRejection(failure, record.state !== 'draft'))
        await context.store.settle(intent, { state: 'rejected' });
      throw failure;
    }
    if (!owned()) return;
    setStatuses((values) => ({ ...values, [record.key]: status }));
    if (['waiting', 'uploading'].includes(status.state)) {
      const file = bytes.current.get(record.key);
      if (!file)
        throw new Error(
          'Reselect the original file. File bytes do not survive reload; its length and SHA-256 must match.',
        );
      if (file.size !== status.size || (await fileDigest(file)) !== status.sha256)
        throw new Error('Reselected file differs from the exact upload intent.');
      if (!owned()) return;
      status = await commandRequest<UploadStatusValue>(
        `/api/v1/file-uploads/${status.upload_id}/bytes`,
        { self: context.self, body: {}, binaryBody: file, schema: UploadStatus },
      );
    }
    if (!owned()) return;
    if (status.state !== 'prepared')
      status = await commandRequest<UploadStatusValue>(
        `/api/v1/file-uploads/${status.upload_id}/finalize`,
        { self: context.self, body: {}, schema: UploadStatus },
      );
    if (!owned()) return;
    setStatuses((values) => ({ ...values, [record.key]: status }));
    if (status.state === 'prepared') await usePrepared(intent, status);
  }
  async function reselect(record: Intent, file: File) {
    const owner = identityGeneration();
    if (
      file.size !== record.body.size ||
      (await fileDigest(file)) !== String(record.body.sha256).toLowerCase()
    )
      throw new Error(
        'Reselected bytes differ. Choose the original file; changed bytes need a new upload.',
      );
    if (!live.current || owner !== identityGeneration()) return;
    bytes.current.set(record.key, file);
  }
  return (
    <section aria-label="Artifact files" className="file-editor">
      <h3>Files</h3>
      <p className="fineprint">
        Up to 16 files, 4 MiB each. Uploaded contents are not indexed or previewed. Paths use
        relative folders. Prepared files expire after 24 hours; uncertain publications must be
        reconciled first.
      </p>
      {error && <p role="alert">{error}</p>}
      {(value?.files ?? []).map((member, index) => (
        <div className="file-row" key={index}>
          <label>
            File path
            <input
              aria-label={'File path ' + (index + 1)}
              value={member.path}
              disabled={disabled || busy}
              onChange={(event) => {
                const next = structuredClone(value!);
                next.files[index]!.path = event.target.value;
                void onChange(next);
              }}
            />
          </label>
          <span>
            {'upload_id' in member.source ? 'Prepared upload' : 'Reuse exact revision file'}
          </span>
          <button
            disabled={disabled || busy}
            onClick={() =>
              void onChange({
                version: 'artifact-files-v1',
                files: value!.files.filter((_, i) => i !== index),
              })
            }
          >
            Remove {member.path}
          </button>
        </div>
      ))}
      {!disabled && (
        <>
          <label>
            Select file
            <input
              type="file"
              disabled={busy}
              onChange={(event) => {
                const file = event.target.files?.[0];
                setSelected(file);
                setPath(file?.name ?? '');
                event.target.value = '';
              }}
            />
          </label>
          {selected && (
            <>
              <span>
                {selected.name} · {selected.size} bytes
              </span>
              <label>
                Relative path
                <input value={path} onChange={(event) => setPath(event.target.value)} />
              </label>
              <button disabled={busy} onClick={() => void action(retain)}>
                Keep file selection
              </button>
              <button disabled={busy} onClick={() => setSelected(undefined)}>
                Cancel selection
              </button>
            </>
          )}
        </>
      )}
      {records
        .filter((record) => !ignored.includes(record.key) && record.state !== 'committed')
        .map((record) => (
          <div className="notice" key={record.key}>
            <strong>Prepare {String(record.body.path)}</strong>
            <p>
              {String(record.body.size)} bytes · {target.kind} {target.resource_id}
            </p>
            <p role="status">
              {record.state === 'rejected'
                ? 'Upload was refused before admission. Remove it explicitly before selecting a new upload.'
                : (statuses[record.key]?.state ??
                  'Retained locally; check status or upload explicitly.')}
            </p>
            {statuses[record.key] && (
              <p className="fineprint">
                Prepared deadline: {statuses[record.key]!.prepared_expires_at}
              </p>
            )}
            <label>
              Reselect original {String(record.body.path)}
              <input
                type="file"
                disabled={disabled || busy}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void action(() => reselect(record, file));
                  event.target.value = '';
                }}
              />
            </label>
            <button disabled={busy} onClick={() => void action(() => recover(record))}>
              Check file status
            </button>
            <button
              disabled={disabled || busy || record.state === 'rejected'}
              onClick={() => void action(() => upload(record))}
            >
              Upload and prepare {String(record.body.path)}
            </button>
            {record.state === 'rejected' && (
              <button
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    await context.store.remove(record);
                    bytes.current.delete(record.key);
                  })
                }
              >
                Remove rejected upload
              </button>
            )}
            {statuses[record.key]?.state === 'prepared' && (
              <button
                disabled={disabled || busy}
                onClick={() => void action(() => usePrepared(record, statuses[record.key]!))}
              >
                Use prepared file
              </button>
            )}
            <button
              disabled={disabled || busy}
              onClick={() => setIgnored((values) => [...values, record.key])}
            >
              Omit from this draft
            </button>
          </div>
        ))}
      <p role="status">
        {pending
          ? 'Finish or deliberately omit each selected file before publishing.'
          : value?.files.length
            ? 'File set ready for publication.'
            : 'No files selected.'}
      </p>
      <button
        disabled={busy}
        onClick={() =>
          void action(async () => {
            const owner = identityGeneration();
            const result = await commandRequest<{ removed: number; quarantined: number }>(
              '/api/v1/file-uploads/cleanup',
              { self: context.self, body: {} },
            );
            if (live.current && owner === identityGeneration())
              setError(
                `Expired unassociated uploads removed: ${result.removed}. Awaiting storage repair: ${result.quarantined}. Recovery metadata is retained.`,
              );
          })
        }
      >
        Clean up my expired uploads
      </button>
    </section>
  );
}

export function FileBrowser({ artifact, revision }: { artifact: string; revision: string }) {
  const authority = useAuthorization(),
    [prefix, setPrefix] = useState(''),
    [cursor, setCursor] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null),
    focusOnLoad = useRef(false);
  const path =
    `/api/v1/artifacts/${artifact}/revisions/${revision}/files?` +
    new URLSearchParams({ prefix, ...(cursor ? { cursor } : {}), limit: '12' });
  const { data, error: failure, refresh } = useQuery<FilePageValue>(path, FilePage),
    live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  useEffect(() => {
    if (focusOnLoad.current && (data || failure)) {
      heading.current?.focus();
      focusOnLoad.current = false;
    }
  }, [data, failure]);
  function navigate(folder: string, next = '') {
    focusOnLoad.current = true;
    setPrefix(folder);
    setCursor(next);
  }
  async function download(url: string, name: string) {
    setBusy(true);
    setError('');
    const owner = identityGeneration();
    try {
      const bytes = await authority.read<Blob>(url, { responseType: 'blob' });
      if (!live.current || owner !== identityGeneration()) return;
      const object = URL.createObjectURL(bytes),
        link = document.createElement('a');
      link.href = object;
      link.download = name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(object), 1000);
    } catch (reason) {
      if (live.current && owner === identityGeneration()) setError((reason as Error).message);
    } finally {
      if (live.current && owner === identityGeneration()) setBusy(false);
    }
  }
  return (
    <section aria-label="Revision files">
      <h3 ref={heading} tabIndex={-1}>
        Revision files
      </h3>
      <p>
        Declared snapshot. Availability is checked when downloading. File contents are not indexed.
      </p>
      {(failure || error) && <p role="alert">{failure || error}</p>}
      {failure && <button onClick={refresh}>Retry file list</button>}
      {prefix && (
        <button onClick={() => navigate(prefix.split('/').slice(0, -1).join('/'))}>
          Parent folder
        </button>
      )}
      <p>{prefix || 'Root folder'}</p>
      {!data && !failure && <p role="status">Loading files…</p>}
      <ul className="file-tree">
        {data?.items.map((item) => (
          <li key={item.path}>
            {item.kind === 'folder' ? (
              <button onClick={() => navigate(item.path)}>Open folder {item.path}</button>
            ) : (
              <>
                <span>
                  {item.path} · {item.size} bytes
                </span>
                <button
                  disabled={busy}
                  onClick={() => void download(item.download_url, item.path.split('/').at(-1)!)}
                >
                  Download {item.path}
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
      {data?.next_cursor && (
        <button onClick={() => navigate(prefix, data.next_cursor!)}>Next files</button>
      )}
      {cursor && <button onClick={() => navigate(prefix)}>First files</button>}
    </section>
  );
}
