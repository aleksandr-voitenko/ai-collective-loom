import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { Value } from '@sinclair/typebox/value';
import * as N from '../contracts/notes.js';
import { ReferenceTarget, type ReferenceTargetValue } from '../contracts/participation.js';
import { useAuthorization, type AuthorizedValue } from './AuthorizationBoundary.js';
import {
  commandRequest,
  ApiError,
  identityGeneration,
  isDefinitiveRejection,
  type Intent,
} from './participation-client.js';
import { type Context, useIntent } from './participation-state.js';
import { noteAction } from './note-recovery.js';

export function AddPrivateNote({ target }: { target: ReferenceTargetValue }) {
  const query = new URLSearchParams({
    kind: target.kind,
    resource: target.resource_id,
    ...(target.revision_id ? { revision: target.revision_id } : {}),
  });
  return <Link to={'/loom/notes/new?' + query}>Add private note</Link>;
}
const root = '/api/v1/me/notes';
export function PrivateNotesPage({ context }: { context: Context }) {
  const authority = useAuthorization(),
    location = useLocation(),
    navigate = useNavigate(),
    live = useRef(true),
    owner = useRef(identityGeneration());
  const id = location.pathname.split('/')[3],
    params = new URLSearchParams(location.search),
    selected = params.get('intent');
  const [revision, changed] = useState(0),
    [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false),
    [stale, setStale] = useState(false);
  const initialQuery = location.state as { participant?: string; noteQuery?: string } | null;
  const [query, setQuery] = useState(
    initialQuery?.participant === context.self.participant_id ? (initialQuery.noteQuery ?? '') : '',
  );
  const [page, setPage] = useState<N.NotePageView>(),
    [note, setNote] = useState<N.NoteDetailView>(),
    [sources, setSources] = useState<AuthorizedValue<N.NoteSourcesView>>();
  const readSequence = useRef(0),
    pageSequence = useRef(0),
    previewSequence = useRef(0),
    floor = useRef(0),
    terminal = useRef<N.NoteDeletedView | undefined>(undefined);
  const heading = useRef<HTMLHeadingElement>(null);
  const owned = () => live.current && owner.current === identityGeneration() && authority.active();
  let records: Intent[] = [],
    journalError = '';
  try {
    records = context.store.all().filter((r) => r.kind.startsWith('notes.'));
  } catch (failure) {
    journalError = (failure as Error).message;
  }
  void revision;
  const selectedRecord = records.find((r) => r.key === selected);
  function observe(current: N.NoteIdentityView) {
    if (current.note_id !== id) return;
    floor.current = Math.max(floor.current, current.version);
    readSequence.current++;
    previewSequence.current++;
    setSources(undefined);
    if (current.state === 'deleted' && current.deleted_at) {
      terminal.current = { ...current, state: 'deleted', deleted_at: current.deleted_at };
      setNote(terminal.current);
    } else setNote((old) => (old && old.version >= current.version ? old : undefined));
  }
  useEffect(() => {
    live.current = true;
    const update = (event: Event) => {
      if (!owned()) return;
      if (
        event.type === 'storage' &&
        (event as StorageEvent).key &&
        !(event as StorageEvent).key!.startsWith(context.store.prefix)
      )
        return;
      readSequence.current++;
      pageSequence.current++;
      previewSequence.current++;
      setPage(undefined);
      setSources(undefined);
      setStale(true);
      changed((n) => n + 1);
      const receipt = (event as CustomEvent<{ participant: string; current: N.NoteIdentityView }>)
        .detail;
      if (receipt?.participant === context.self.participant_id) observe(receipt.current);
      else if (event.type === 'storage') {
        setNote(terminal.current);
        if (id && id !== 'new') {
          let unsentCreate = false;
          try {
            // The original create draft may have committed here or in another tab.
            const current = context.store.all().find((record) => record.key === selected);
            unsentCreate =
              floor.current === 0 && current?.kind === 'notes.create' && current.state === 'draft';
          } catch {
            // The rerender reports journal corruption; owner reads remain independent.
          }
          if (!unsentCreate) void readNote();
        }
      }
    };
    window.addEventListener('storage', update);
    window.addEventListener('loom-notes', update);
    return () => {
      live.current = false;
      window.removeEventListener('storage', update);
      window.removeEventListener('loom-notes', update);
    };
  }, []);
  async function readNote() {
    const seq = ++readSequence.current;
    setError('');
    try {
      const result = await authority.privateRead<N.NoteDetailView>(root + '/' + id, {
        schema: N.NoteDetail,
      });
      if (
        !owned() ||
        seq !== readSequence.current ||
        result.version < floor.current ||
        (terminal.current && result.state !== 'deleted')
      )
        return;
      floor.current = result.version;
      setNote(result);
      setStale(false);
      if (result.state === 'deleted') {
        terminal.current = result;
        setSources(undefined);
      }
    } catch (failure) {
      if (owned() && seq === readSequence.current) setError((failure as Error).message);
    }
  }
  async function list(cursor?: string) {
    const seq = ++pageSequence.current;
    setError('');
    setBusy(true);
    try {
      const result = await authority.privateRead<N.NotePageView>(root + '/query', {
        body: { query, limit: 12, ...(cursor ? { cursor } : {}) },
        self: context.self,
        schema: N.NotePage,
      });
      if (!owned() || seq !== pageSequence.current) return;
      setPage(result);
      setStale(false);
      heading.current?.focus();
    } catch (failure) {
      if (owned() && seq === pageSequence.current) setError((failure as Error).message);
    } finally {
      if (owned()) setBusy(false);
    }
  }
  async function preview() {
    const seq = ++previewSequence.current;
    setError('');
    try {
      const result = await authority.readProjection<N.NoteSourcesView>(
        root + '/' + id + '/sources',
        { schema: N.NoteSources },
      );
      if (
        owned() &&
        seq === previewSequence.current &&
        result.value.version >= floor.current &&
        !terminal.current
      )
        setSources(result);
    } catch (failure) {
      if (owned() && seq === previewSequence.current) setError((failure as Error).message);
    }
  }
  useEffect(() => {
    if (
      id &&
      id !== 'new' &&
      !(selectedRecord?.kind === 'notes.create' && selectedRecord.state === 'draft')
    )
      void readNote();
    else if (!id) void list();
    return () => {
      readSequence.current++;
      pageSequence.current++;
      previewSequence.current++;
    };
  }, []);
  async function draft(current?: N.NoteActiveView, prior?: Intent) {
    setError('');
    try {
      let links: ReferenceTargetValue[] = current?.links ?? [];
      if (id === 'new') {
        const target = {
          kind: params.get('kind'),
          resource_id: params.get('resource'),
          ...(params.get('revision') ? { revision_id: params.get('revision') } : {}),
        };
        if (Value.Check(ReferenceTarget, target)) links = [target];
      }
      const noteId = current?.note_id ?? crypto.randomUUID(),
        action = current ? 'update' : 'create';
      // Correction keeps proposed text and links; only an explicit review adopts a current version.
      const fields = prior
        ? { title: prior.body.title, body: prior.body.body, links: prior.body.links }
        : { title: current?.title ?? '', body: current?.body ?? '', links };
      const record = context.store.create(
        'notes:' + noteId,
        'notes.' + action,
        root + '/' + action,
        { note_id: noteId, ...fields, ...(current ? { expected_version: current.version } : {}) },
      );
      const saved = await context.store.saveDraft(record, record.body);
      if (owned()) void navigate('/loom/notes/' + noteId + '?intent=' + saved.key);
    } catch (failure) {
      if (owned()) setError((failure as Error).message);
    }
  }
  async function execute(record: Intent, status = false, first = false) {
    setBusy(true);
    setError('');
    setMessage('');
    let sent = record;
    try {
      if (!status && !first) sent = await context.store.prepareNote(record, record.body, owned);
      if (!owned()) return;
      const result = await commandRequest<N.NoteStatusView>(
        root + '/' + (status ? 'status' : noteAction(sent)),
        {
          body: status ? { action: noteAction(sent), idempotency_key: sent.key } : sent.body,
          self: context.self,
          schema: N.NoteStatus,
        },
      );
      if (!owned()) return;
      if (result.operation_state === 'not_recorded')
        setMessage(
          'No recorded outcome was found. This does not prove rollback; keep the exact command.',
        );
      else {
        // Withdraw old bodies immediately, even if local settlement subsequently fails.
        observe(result.current);
        setPage(undefined);
        pageSequence.current++;
        window.dispatchEvent(
          new CustomEvent('loom-notes', {
            detail: { participant: context.self.participant_id, current: result.current },
          }),
        );
        try {
          await context.store.settleNote(sent, result, owned);
        } catch {
          if (owned())
            setError(
              'Server outcome confirmed, but local recovery could not be updated. Keep the exact command and reconcile again.',
            );
        }
        if (owned() && result.current.note_id === id && result.current.state === 'active')
          void readNote();
        if (owned())
          setMessage(
            result.operation_state === 'applied'
              ? `Private note ${result.action} confirmed. Original version ${result.outcome.result_version}; current ${result.current.state} version ${result.current.version}.`
              : 'The note changed in another client. Your proposed text and links are retained. Refresh the note, then explicitly prepare a corrected save.',
          );
      }
    } catch (failure) {
      if (owned() && failure instanceof ApiError && failure.code === 'note_deleted') {
        // Terminal refusal withdraws stale text immediately; only a fresh owner read
        // supplies the versioned evidence needed to forget uncertain local copies.
        readSequence.current++;
        previewSequence.current++;
        pageSequence.current++;
        setPage(undefined);
        setSources(undefined);
        if (String(sent.body.note_id).toLowerCase() === id) {
          setNote(terminal.current);
          void readNote();
        }
      }
      if (owned() && first && isDefinitiveRejection(failure, false)) {
        try {
          await context.store.settle(sent, { state: 'rejected' });
        } catch {
          /* Unknown custody stays intact if settlement fails. */
        }
      }
      if (owned()) setError((failure as Error).message);
    } finally {
      if (owned()) {
        setBusy(false);
        changed((n) => n + 1);
      }
    }
  }
  const [confirmDelete, setConfirmDelete] = useState(false);
  async function remove() {
    if (note?.state !== 'active') return;
    setBusy(true);
    setError('');
    try {
      const record = context.store.create(
        'notes:' + note.note_id,
        'notes.delete',
        root + '/delete',
        { note_id: note.note_id, expected_version: note.version },
      );
      const saved = await context.store.prepareNote(record, record.body, owned);
      if (owned()) {
        setConfirmDelete(false);
        await execute(saved, false, true);
      }
    } catch (failure) {
      if (owned())
        setError(
          'Deletion was not dispatched: ' +
            (failure as Error).message +
            ' Keep existing recovery records; free safe resolved local copies or export them.',
        );
    } finally {
      if (owned()) setBusy(false);
    }
  }
  async function clearCopies(noteId: string) {
    setError('');
    try {
      await context.store.clearNoteCopies(noteId, terminal.current, owned);
      if (owned()) {
        changed((n) => n + 1);
        setMessage(
          'This journal’s note copies were cleared. Other tabs, devices and exports are not certified erased. Earlier unknown outcomes remain unknown.',
        );
      }
    } catch (failure) {
      if (owned()) setError((failure as Error).message);
    }
  }
  const projection =
    sources && authority.current(sources.generation) && sources.value.version >= floor.current
      ? sources.value
      : undefined;
  return (
    <section className="private-notes">
      <h1 ref={heading} tabIndex={-1}>
        Private notes
      </h1>
      <p>
        Only your account can read these notes through Loom. Notes are separate from shared
        publications, activity and notifications.
      </p>
      <details>
        <summary>Privacy, deletion and local recovery</summary>
        <p>
          Plain text only. Infrastructure, database, backups and credential recovery remain trusted
          powers. Deletion removes current server text, links and search data; minimal identity and
          operation fences remain. It is not immediate secure erasure of disk, WAL, backups or
          copies.
        </p>
        <p>
          Shared device warning: drafts and exact commands may retain note prose in this browser
          until explicitly cleared. Local storage is not encryption. Local drafts export is a
          private recovery file; sign-out offers export and local cleanup. Server deletion cannot
          erase other tabs, devices or exports. There is no note history or undelete.
        </p>
      </details>
      <div className="toolbar">
        <Link to="/loom/notes">Browse private notes</Link>{' '}
        <Link to="/loom/notes/new">New private note</Link>
      </div>
      {(error || journalError) && <p role="alert">{error || journalError}</p>}
      {message && <p role="status">{message}</p>}
      {stale && (
        <p role="status">
          Notes may have changed. Refresh before another choice; unsent drafts are retained.
        </p>
      )}
      {!id && (
        <>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void navigate(location.pathname, {
                replace: true,
                state: { participant: context.self.participant_id, noteQuery: query },
              });
              void list();
            }}
          >
            <label>
              Search private notes
              <input
                maxLength={256}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  pageSequence.current++;
                  setPage(undefined);
                }}
              />
            </label>
            <button disabled={busy}>Search notes</button>
          </form>
          <p>
            Search matches all lexical terms in your current title and body. Empty search lists
            notes in stable ID order. Excerpts are abbreviated.
          </p>
          {page && (
            <>
              <ul>
                {page.items.map((item) => (
                  <li key={item.note_id}>
                    <Link to={'/loom/notes/' + item.note_id}>
                      {item.title || 'Untitled private note'}
                    </Link>
                    <p className="note-text">
                      {item.excerpt}
                      {item.excerpt_abbreviated ? '…' : ''}
                    </p>
                  </li>
                ))}
              </ul>
              {!page.items.length && <p>No matching private notes in this page.</p>}
              <p>
                {page.complete
                  ? 'End of this selected note traversal.'
                  : 'More notes in this traversal.'}
              </p>
              <button
                disabled={busy || !page.next_cursor || stale}
                onClick={() => void list(page.next_cursor!)}
              >
                Next notes page
              </button>
            </>
          )}
        </>
      )}
      {id === 'new' && (
        <>
          <p>
            Create a new owner-private note
            {params.has('resource')
              ? ' with the selected structured source link. No source text is copied.'
              : '.'}
          </p>
          <button disabled={busy} onClick={() => void draft()}>
            Start private note
          </button>
        </>
      )}
      {id && id !== 'new' && (
        <>
          <button disabled={busy} onClick={() => void readNote()}>
            Refresh current note
          </button>
          {note?.state === 'deleted' ? (
            <p role="status">
              This note is deleted. Its identity cannot be reused. Saved local requests may still
              contain text until explicitly cleared.
            </p>
          ) : (
            note?.state === 'active' && (
              <article aria-label="Current private note">
                <h2>{note.title || 'Untitled private note'}</h2>
                <p className="note-text">{note.body}</p>
                <details>
                  <summary>Note identity and version</summary>
                  <p className="destination-id">
                    {note.note_id} · Version {note.version}
                  </p>
                </details>
                <button disabled={busy} onClick={() => void draft(note)}>
                  Edit private note
                </button>
                <button disabled={busy || stale} onClick={() => setConfirmDelete(true)}>
                  Delete private note
                </button>
                <section aria-label="Private links">
                  <h3>Private links</h3>
                  {note.links.map((link, i) => (
                    <p className="destination-id" key={i}>
                      {link.kind} {link.resource_id}
                      {link.revision_id
                        ? ' · Exact revision ' + link.revision_id
                        : ' · Current resource'}
                    </p>
                  ))}
                  {!!note.links.length && (
                    <button onClick={() => void preview()}>Check linked sources</button>
                  )}
                  {projection?.items.map((item, i) => (
                    <p key={i}>
                      {item.source.state === 'available' ? (
                        <Link to={item.source.url}>
                          {item.source.title || 'Open linked source'}
                        </Link>
                      ) : (
                        'Linked source unavailable. Your note and cleanup remain available.'
                      )}
                    </p>
                  ))}
                </section>
              </article>
            )
          )}
          {confirmDelete && note?.state === 'active' && (
            <section role="group" aria-label="Confirm private note deletion">
              <p>
                Delete the current server note and its links/search data? This is terminal. Local
                recovery copies remain until you explicitly clear them.
              </p>
              <button disabled={busy} onClick={() => void remove()}>
                Confirm delete private note
              </button>
              <button disabled={busy} onClick={() => setConfirmDelete(false)}>
                Cancel deletion
              </button>
            </section>
          )}
          {selectedRecord && note?.state !== 'deleted' && (
            <NoteEditor
              key={selectedRecord.key}
              context={context}
              initial={selectedRecord}
              busy={busy}
              send={(record) => execute(record, false, true)}
              changed={() => changed((n) => n + 1)}
            />
          )}
          <button disabled={busy} onClick={() => void clearCopies(id)}>
            {note?.state === 'deleted'
              ? 'Forget local copies of deleted note'
              : 'Clear resolved local note copies'}
          </button>
        </>
      )}
      <section aria-label="Private note recovery">
        <h2>Private note recovery</h2>
        {records.length === 0 && <p>No retained local note commands.</p>}
        {records.map((record) => (
          <div
            className="notice"
            key={record.key}
            role="group"
            aria-label={noteAction(record) + ' note ' + record.key}
          >
            <strong>
              {noteAction(record)} private note · {record.state}
            </strong>
            <p className="destination-id">Note {String(record.body.note_id)}</p>
            <details>
              <summary>Operation details</summary>
              <p className="destination-id">
                Command {record.key} · Expected version {String(record.body.expected_version ?? 0)}
              </p>
              {record.note_receipt && (
                <p>
                  Original {record.note_receipt.operation_state}, version{' '}
                  {record.note_receipt.outcome.result_version}.
                </p>
              )}
            </details>
            {record.state === 'draft' && (
              <Link to={'/loom/notes/' + String(record.body.note_id) + '?intent=' + record.key}>
                Resume note draft
              </Link>
            )}
            {record.state !== 'draft' && (
              <button disabled={busy} onClick={() => void execute(record, true)}>
                Check note outcome
              </button>
            )}
            {record.state === 'uncertain' && (
              <button disabled={busy} onClick={() => void execute(record)}>
                Retry exact note command
              </button>
            )}
            <Link to={'/loom/notes/' + String(record.body.note_id)}>Open current note</Link>
            {record.state === 'rejected' &&
              record.kind !== 'notes.delete' &&
              note?.state === 'active' &&
              note.note_id === record.body.note_id && (
                <button disabled={busy} onClick={() => void draft(note, record)}>
                  Prepare corrected private save
                </button>
              )}
            {record.state === 'rejected' && record.kind === 'notes.create' && !note && (
              <button disabled={busy} onClick={() => void draft(undefined, record)}>
                Prepare new private note from rejected draft
              </button>
            )}
            {record.state !== 'uncertain' && (
              <button
                disabled={busy}
                onClick={() =>
                  void context.store.removeNoteCopy(record, owned).then(
                    () => changed((n) => n + 1),
                    (failure) => setError(failure.message),
                  )
                }
              >
                Remove this local note command
              </button>
            )}
          </div>
        ))}
      </section>
    </section>
  );
}
function NoteEditor({
  context,
  initial,
  busy,
  send,
  changed,
}: {
  context: Context;
  initial: Intent;
  busy: boolean;
  send: (record: Intent) => Promise<void>;
  changed: () => void;
}) {
  const [record, update] = useIntent(() => initial),
    [fields, setFields] = useState(initial.body),
    [error, setError] = useState(''),
    [status, setStatus] = useState('Local draft'),
    live = useRef(true),
    owner = useRef(identityGeneration());
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const owned = () => live.current && owner.current === identityGeneration(),
    editable = record?.state === 'draft';
  function patch(values: Record<string, unknown>) {
    const next = { ...fields, ...values };
    setFields(next);
    setStatus('Saving local draft…');
    void update((current) => context.store.saveDraft(current!, next)).then(
      () => {
        if (owned()) {
          setStatus('Draft saved on this device; not saved to server.');
          changed();
        }
      },
      (failure) => {
        if (owned()) {
          setError(failure.message);
          setStatus('Local save failed; keep this view open.');
        }
      },
    );
  }
  const links = fields.links as ReferenceTargetValue[] | undefined;
  return (
    <section aria-label="Private note editor">
      <h2>{editable ? 'Private note draft' : 'Retained exact note command'}</h2>
      {error && <p role="alert">{error}</p>}
      <p role="status">
        {editable
          ? status
          : 'Exact submitted command retained on this device; consult its recovery outcome below.'}
      </p>
      {record?.kind !== 'notes.delete' && (
        <>
          <label>
            Note title
            <input
              maxLength={256}
              disabled={!editable || busy}
              value={String(fields.title ?? '')}
              onChange={(event) => patch({ title: event.target.value })}
            />
          </label>
          <label htmlFor={'note-body-' + initial.key}>Note text</label>
          <textarea
            id={'note-body-' + initial.key}
            rows={10}
            maxLength={16384}
            disabled={!editable || busy}
            value={String(fields.body ?? '')}
            onChange={(event) => patch({ body: event.target.value })}
          />
          {(links ?? []).map((link, i) => (
            <fieldset key={i}>
              <legend>Private link {i + 1}</legend>
              <label>
                Source kind
                <select
                  disabled={!editable || busy}
                  value={link.kind}
                  onChange={(event) =>
                    patch({
                      links: links!.map((old, j) =>
                        j === i ? { ...old, kind: event.target.value } : old,
                      ),
                    })
                  }
                >
                  {['discussion', 'contribution', 'summary', 'artifact'].map((kind) => (
                    <option key={kind}>{kind}</option>
                  ))}
                </select>
              </label>
              <label>
                Resource ID
                <input
                  disabled={!editable || busy}
                  maxLength={36}
                  value={link.resource_id}
                  onChange={(event) =>
                    patch({
                      links: links!.map((old, j) =>
                        j === i ? { ...old, resource_id: event.target.value } : old,
                      ),
                    })
                  }
                />
              </label>
              <label>
                Exact revision (optional)
                <input
                  disabled={!editable || busy}
                  maxLength={36}
                  value={link.revision_id ?? ''}
                  onChange={(event) =>
                    patch({
                      links: links!.map((old, j) =>
                        j === i
                          ? {
                              kind: old.kind,
                              resource_id: old.resource_id,
                              ...(event.target.value ? { revision_id: event.target.value } : {}),
                            }
                          : old,
                      ),
                    })
                  }
                />
              </label>
              <button
                disabled={!editable || busy}
                onClick={() => patch({ links: links!.filter((_, j) => j !== i) })}
              >
                Remove private link {i + 1}
              </button>
            </fieldset>
          ))}
          <button
            disabled={!editable || busy || (links?.length ?? 0) >= 8}
            onClick={() =>
              patch({ links: [...(links ?? []), { kind: 'artifact', resource_id: '' }] })
            }
          >
            Add private link
          </button>
        </>
      )}
      {record?.blocked_by && (
        <>
          <p>Another view changed this command. Your unsent changes were saved separately.</p>
          <button
            onClick={() =>
              void update(async (current) => {
                const next = { ...current! };
                delete next.blocked_by;
                return context.store.save(next);
              }).catch((failure) => setError(failure.message))
            }
          >
            Review and allow separate draft
          </button>
        </>
      )}
      <button
        disabled={!editable || busy || !!record?.blocked_by}
        onClick={() => {
          setError('');
          void update((current) => context.store.prepareNote(current!, fields, owned)).then(
            (saved) => {
              if (saved && owned()) void send(saved);
            },
            (failure) => {
              if (owned()) setError(failure.message);
            },
          );
        }}
      >
        Save private note
      </button>
    </section>
  );
}
