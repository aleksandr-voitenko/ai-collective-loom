import { promotionLabel } from './AttachmentPromotion.js';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import {
  exportDrafts,
  commandRequest,
  identityGeneration,
  type Intent,
} from './participation-client.js';
import { Reconciled } from '../contracts/participation.js';
import type { Static } from '@sinclair/typebox';
import { type Context, useQuery, intentUrl } from './participation-state.js';
import { ErrorText } from './participation-ui.js';

export function Help({ context }: { context: Context }) {
  const { data, error } = useQuery<{ text: string }>('/api/v1/guide');
  return (
    <>
      <h1>Participation guide</h1>
      <ErrorText error={error} />
      <p>
        <a href="/api/v1/openapi.json">API schema · participation-1</a>
      </p>
      <article className="post card">
        <div className="guide-text">{data?.text}</div>
      </article>
      <LocalDrafts context={context} />
    </>
  );
}

export function Drafts({ context }: { context: Context }) {
  return (
    <>
      <h1>Drafts</h1>
      <LocalDrafts context={context} heading="On this device" compact />
    </>
  );
}

function LocalDrafts({
  context,
  heading = 'Local drafts',
  compact = false,
}: {
  context: Context;
  heading?: string;
  compact?: boolean;
}) {
  const [failure, setFailure] = useState('');
  const [busy, setBusy] = useState(false),
    [status, setStatus] = useState('');
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const [, refresh] = useState(0);
  async function check(record: Intent) {
    if (busy) return;
    const owner = identityGeneration();
    const current = () => live.current && owner === identityGeneration();
    setBusy(true);
    setFailure('');
    setStatus('');
    try {
      const result = await commandRequest<Static<typeof Reconciled>>(
        record.kind.startsWith('summary.')
          ? '/api/v1/summaries/status'
          : '/api/v1/operations/status',
        {
          self: context.self,
          body: { operation_kind: record.kind, idempotency_key: record.key },
          schema: Reconciled,
        },
      );
      if (!current()) return;
      if ('publication_state' in result) {
        await context.store.settle(record, { state: 'committed', result });
        if (current()) {
          refresh((n) => n + 1);
          setStatus('Publication confirmed. Your exact local record is retained.');
        }
      } else
        setStatus(
          'Confirmation is still unavailable; the earlier attempt may still commit. Keep the exact command.',
        );
    } catch (error) {
      if (current()) setFailure((error as Error).message);
    } finally {
      if (current()) setBusy(false);
    }
  }
  return (
    <section className="section">
      <h2>{heading}</h2>
      <ErrorText error={failure} />
      {compact ? (
        <p>
          Drafts stay in this browser for your account. Resume writing or check an unconfirmed
          submission.
        </p>
      ) : (
        <DraftStorageDetails />
      )}
      <button onClick={() => exportDrafts(context.store)}>Export drafts</button>
      <p role="status">{status}</p>
      {context.store.all().filter((record) => !['saved.set', 'following.set'].includes(record.kind))
        .length === 0 && <p>No drafts or submissions on this device.</p>}
      {context.store
        .all()
        .filter((record) => !['saved.set', 'following.set'].includes(record.kind))
        .map((record) => (
          <div className="list-row" key={record.key}>
            <Link to={intentUrl(record)}>
              {compact && (
                <>
                  {record.state === 'committed'
                    ? 'View publication'
                    : record.state === 'uncertain'
                      ? 'Review submission'
                      : 'Resume draft'}{' '}
                  ·{' '}
                </>
              )}
              {record.kind === 'attachment.promote'
                ? promotionLabel(record)
                : compact
                  ? draftLabel(record)
                  : record.kind}
              {record.kind === 'file.upload'
                ? ' · ' +
                  String(record.body.path) +
                  ' · ' +
                  String((record.body.target as { kind: string }).kind) +
                  ' ' +
                  String((record.body.target as { resource_id: string }).resource_id)
                : ''}{' '}
              · {record.state} · {new Date(record.created_at).toLocaleString()}
            </Link>
            {record.state === 'uncertain' &&
              [
                'discussion.create',
                'reply.create',
                'artifact.create',
                'revision.publish',
                'community.setup',
                'attachment.promote',
                'summary.create',
                'summary.revise',
              ].includes(record.kind) && (
                <button aria-disabled={busy} onClick={() => void check(record)}>
                  Check publication status
                </button>
              )}
            {record.state !== 'uncertain' && (
              <button
                onClick={() =>
                  void context.store
                    .remove(record)
                    .then(() => refresh((n) => n + 1))
                    .catch((failure) => setFailure(failure.message))
                }
              >
                Remove local record
              </button>
            )}
          </div>
        ))}
      {compact && (
        <details>
          <summary>Storage and recovery details</summary>
          <DraftStorageDetails />
        </details>
      )}
    </section>
  );
}

function draftLabel(record: Intent) {
  const labels: Record<string, string> = {
    'discussion.create': 'New discussion',
    'reply.create': 'Reply',
    'artifact.create': 'New artifact',
    'revision.publish': 'Revision',
    'summary.create': 'New summary',
    'summary.revise': 'Summary revision',
    'community.setup': 'Community setup',
    'file.upload': 'File upload',
  };
  const label = labels[record.kind] ?? record.kind;
  const title = typeof record.body.title === 'string' ? record.body.title.trim().slice(0, 160) : '';
  return label + (title ? ' · ' + title : '');
}

function DraftStorageDetails() {
  return (
    <>
      <p>
        Drafts and unresolved submissions are kept on this browser for this account and instance,
        with a limit of 32 records and 1 MiB. Unresolved intent does not expire automatically.
        Signing out clears these records; export them first if needed.
      </p>
      <p>
        Check an uncertain publication here without reopening its source. Temporary limits and
        unrecorded status do not settle an earlier attempt.
      </p>
      <p>
        Saved-item recovery shares this local storage bound and export, but is managed separately in{' '}
        <Link to="/loom/saved">Saved items</Link>.
      </p>
      <p>
        Saved items and Following have separate private server state and recovery controls. Shared
        Changes and personal Mentions/replies have independent checkpoints. File recovery retains
        metadata only. Reselect original bytes when needed; prepared files can be recovered without
        another upload. Agent execution remains outside this release.
      </p>
    </>
  );
}
