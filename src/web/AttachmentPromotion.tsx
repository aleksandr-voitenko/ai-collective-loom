import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router';
import {
  AttachmentSelection,
  PromotionInput,
  PromotionProvenance,
  type AttachmentSelectionValue,
  type PromotionInputValue,
  type PromotionProvenanceValue,
} from '../contracts/files.js';
import { Committed, type CommittedView } from '../contracts/participation.js';
import { Value } from '@sinclair/typebox/value';
import {
  commandRequest,
  identityGeneration,
  isDefinitiveRejection,
  type Intent,
} from './participation-client.js';
import {
  useIntent,
  useQuery,
  intentUrl,
  SeparateDraft,
  type Context,
} from './participation-state.js';
import { useAuthorization } from './AuthorizationBoundary.js';
import { TopicDirectory } from './Organization.js';

export function PromotionPage({ context }: { context: Context }) {
  const query = new URLSearchParams(useLocation().search),
    chosen = query.get('intent');
  const source = {
    contribution_id: query.get('contribution') ?? '',
    revision_id: query.get('revision') ?? '',
    file_id: query.get('file') ?? '',
  };
  const slot = `attachment.promote:${source.contribution_id}:${source.revision_id}:${source.file_id}`;
  const [record, update] = useIntent(() =>
    context.store
      .all()
      .find(
        (r) =>
          r.kind === 'attachment.promote' &&
          (chosen ? r.key === chosen : r.slot === slot && r.state === 'draft'),
      ),
  );
  const [title, setTitle] = useState(String(record?.body.title ?? '')),
    [area, setArea] = useState(String(record?.body.area_id ?? '')),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const live = useRef(true),
    owner = useRef(identityGeneration());
  const owned = () => live.current && owner.current === identityGeneration();
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const selected = (record?.body.source ?? source) as PromotionInputValue['source'];
  const body = () => ({ source: selected, area_id: area, title });
  async function persist(patch: Record<string, unknown>) {
    try {
      await update((current) =>
        context.store.saveDraft(
          current ??
            context.store.create(
              slot,
              'attachment.promote',
              '/api/v1/attachment-promotions',
              body(),
            ),
          { ...(current?.body ?? body()), ...patch },
        ),
      );
    } catch (failure) {
      if (owned()) setError((failure as Error).message);
    }
  }
  async function execute(status: boolean) {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    let intent = record,
      uncertain = record?.state !== 'draft';
    try {
      if (!status)
        intent = await update(async (current) => {
          uncertain = current?.state === 'uncertain';
          const draft =
            current ??
            context.store.create(
              slot,
              'attachment.promote',
              '/api/v1/attachment-promotions',
              body(),
            );
          if (draft.blocked_by || draft.state === 'rejected')
            throw new Error('Review a separate corrected draft before publishing.');
          if (!uncertain && !Value.Check(PromotionInput, { ...body(), idempotency_key: draft.key }))
            throw new Error('Choose a destination and a nonempty artifact title.');
          return context.store.prepareDispatch(draft, body());
        });
      if (!intent || !owned()) return;
      const response = await commandRequest<CommittedView | { operation_state: 'not_recorded' }>(
        status ? '/api/v1/operations/status' : '/api/v1/attachment-promotions',
        {
          self: context.self,
          body: status
            ? { operation_kind: 'attachment.promote', idempotency_key: intent.key }
            : intent.body,
          ...(!status ? { schema: Committed } : {}),
        },
      );
      if (!owned()) return;
      if ('operation_state' in response) {
        if (owned())
          setNotice('No recorded outcome yet. Keep this exact promotion; it may still commit.');
      } else {
        const saved = intent;
        await update((current) =>
          context.store
            .settle(saved, { state: 'committed', result: response })
            .then((next) => (current?.key === saved.key ? next : current)),
        );
        if (owned())
          setNotice('The independent artifact is published. The source attachment is unchanged.');
      }
    } catch (failure) {
      // A failed status read never settles the write. A retry refusal cannot
      // convert an earlier admitted/unknown attempt into a new logical intent.
      if (owned() && !status && intent && isDefinitiveRejection(failure, uncertain)) {
        const saved = intent;
        try {
          await update(() => context.store.settle(saved, { state: 'rejected' }));
        } catch (storageFailure) {
          if (owned()) setError((storageFailure as Error).message);
          return;
        }
      }
      if (owned()) setError((failure as Error).message);
    } finally {
      if (owned()) setBusy(false);
    }
  }
  const records = context.store.all().filter((r) => r.kind === 'attachment.promote');
  const editable = !record || record.state === 'draft';
  return (
    <section className="section">
      <h1>Create artifact from attachment</h1>
      <p>
        This creates a new publication with independent editors, revisions and moderation. It does
        not move, change or delete the source attachment.
      </p>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <SeparateDraft
        record={record}
        review={() => {
          if (record)
            void update(() =>
              context.store.save((({ blocked_by: _, ...next }) => next)(record)),
            ).catch((e) => setError(e.message));
        }}
      />
      {editable && (
        <>
          <label>
            Artifact title
            <input
              value={title}
              disabled={busy}
              maxLength={160}
              onChange={(e) => {
                setTitle(e.target.value);
                void persist({ title: e.target.value });
              }}
            />
          </label>
          <label>
            Destination area ID
            <input
              value={area}
              disabled={busy}
              onChange={(e) => {
                setArea(e.target.value);
                void persist({ area_id: e.target.value });
              }}
            />
          </label>
          <PromotionReview
            source={selected}
            area={area}
            title={title}
            busy={busy || !!record?.blocked_by}
            confirm={() => void execute(false)}
            choose={(id) => {
              setArea(id);
              void persist({ area_id: id });
            }}
          />
        </>
      )}
      {record && !editable && (
        <div className="notice">
          <strong>{promotionLabel(record)}</strong>
          <p>{record.state}</p>
          {record.state === 'uncertain' && (
            <>
              <button disabled={busy} onClick={() => void execute(true)}>
                Check promotion status
              </button>
              <button disabled={busy} onClick={() => void execute(false)}>
                Retry this exact promotion
              </button>
            </>
          )}
          {record.state === 'rejected' && (
            <button
              disabled={busy}
              onClick={() =>
                void update((current) => context.store.replace(current!, current!.body)).catch(
                  (e) => setError(e.message),
                )
              }
            >
              Prepare corrected promotion
            </button>
          )}
          {record.result && (
            <Link
              to={'/loom/resource/' + record.result.resource_id + '/' + record.result.revision_id}
            >
              Open independent artifact
            </Link>
          )}
        </div>
      )}
      <h2>Saved promotions</h2>
      {records.map((r) => (
        <div className="list-row" key={r.key}>
          <Link to={intentUrl(r)}>
            {promotionLabel(r)} · {r.state}
          </Link>
        </div>
      ))}
    </section>
  );
}

export function promotionLabel(record: Intent) {
  const source = record.body.source as PromotionInputValue['source'];
  return `Create “${String(record.body.title)}” in area ${String(record.body.area_id)} from contribution ${source.contribution_id}, revision ${source.revision_id}, attachment ${source.file_id}`;
}

function PromotionReview({
  source,
  area,
  title,
  busy,
  confirm,
  choose,
}: {
  source: PromotionInputValue['source'];
  area: string;
  title: string;
  busy: boolean;
  confirm: () => void;
  choose: (id: string) => void;
}) {
  const authority = useAuthorization();
  const result = useQuery<AttachmentSelectionValue>(
    `/api/v1/contributions/${source.contribution_id}/revisions/${source.revision_id}/attachments/${source.file_id}`,
    AttachmentSelection,
  );
  const [review, setReview] = useState(false),
    dialog = useRef<HTMLDialogElement>(null),
    trigger = useRef<HTMLButtonElement>(null);
  const data = result.data;
  useEffect(() => {
    if (review && data) dialog.current?.showModal();
    else dialog.current?.close();
  }, [review, data]);
  const close = () => {
    setReview(false);
    dialog.current?.close();
    trigger.current?.focus();
  };
  return (
    <>
      {result.error && <p role="alert">{result.error}</p>}
      {result.error && <button onClick={result.refresh}>Retry attachment selection</button>}
      {data && (
        <>
          <p>
            {data.file.path} · {data.file.size} bytes · SHA-256 {data.file.sha256}
          </p>
          <p>
            Source contribution {data.contribution_id}, exact revision {data.revision_id}.
            Contributor {data.contributor_id}; revision publisher {data.revision_publisher_id}.
          </p>
          <TopicDirectory
            selectionLabel="Choose artifact destination"
            select={(a) => {
              if (authority.current(result.generation)) choose(a.resource_id);
            }}
          />
          <button
            ref={trigger}
            disabled={busy || !title.trim() || !area}
            onClick={() => setReview(true)}
          >
            Review artifact promotion
          </button>
          <dialog ref={dialog} onCancel={close} aria-label="Confirm independent artifact">
            <h2>Confirm independent artifact</h2>
            <p>
              Create “{title}” in area {area} from {data.file.path}, attachment {data.file.file_id},
              contribution {data.contribution_id}, revision {data.revision_id}.
            </p>
            <p>
              Original contributor {data.contributor_id}; revision publisher{' '}
              {data.revision_publisher_id}. You become the artifact creator and editor. The source
              stays unchanged and has its own visibility.
            </p>
            <button
              disabled={busy}
              onClick={() => {
                if (authority.current(result.generation)) {
                  close();
                  confirm();
                }
              }}
            >
              Create independent artifact
            </button>
            <button onClick={close}>Cancel</button>
          </dialog>
        </>
      )}
    </>
  );
}

export function ArtifactProvenance({ url }: { url: string }) {
  const [open, setOpen] = useState(false);
  return (
    <section>
      <button onClick={() => setOpen((v) => !v)}>Source attribution</button>
      {open && <ProvenanceDetails url={url} />}
    </section>
  );
}
function ProvenanceDetails({ url }: { url: string }) {
  const { data, error, refresh } = useQuery<PromotionProvenanceValue>(url, PromotionProvenance);
  return (
    <>
      {error && (
        <>
          <p role="alert">{error}</p>
          <button onClick={refresh}>Retry source attribution</button>
        </>
      )}
      {data && (
        <>
          <p>Promoted by {data.promoter_id}. This artifact is independently governed.</p>
          {data.source.state === 'available' ? (
            <p>
              Original contributor {data.source.contributor_id}; revision publisher{' '}
              {data.source.revision_publisher_id}; uploader {data.source.uploader_id}.{' '}
              <Link to={`/loom/resource/${data.source.contribution_id}/${data.source.revision_id}`}>
                Exact source revision
              </Link>{' '}
              · attachment {data.source.file_id}
            </p>
          ) : (
            <p>Source attribution details are currently unavailable.</p>
          )}
        </>
      )}
    </>
  );
}
