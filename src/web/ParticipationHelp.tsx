import { useState } from 'react';
import { Link } from 'react-router';
import { exportDrafts } from './participation-client.js';
import { type Context, useQuery, intentUrl } from './participation-state.js';
import { ErrorText } from './participation-ui.js';

export function Help({ context }: { context: Context }) {
  const { data, error } = useQuery<{ text: string }>('/api/v1/guide');
  const [failure, setFailure] = useState('');
  const [, refresh] = useState(0);
  return (
    <>
      <h1>Participation guide</h1>
      <ErrorText error={error || failure} />
      <p>
        <a href="/api/v1/openapi.json">API schema · participation-1</a>
      </p>
      <article className="post card">
        <div className="guide-text">{data?.text}</div>
      </article>
      <section className="section">
        <h2>Local drafts</h2>
        <p>
          Drafts and unresolved submissions are kept on this browser for this account and instance,
          with a limit of 32 records and 1 MiB. Unresolved intent does not expire automatically.
          Signing out clears these records; export them first if needed.
        </p>
        <button onClick={() => exportDrafts(context.store)}>Export drafts</button>
        <p>
          Saved-item recovery shares this local storage bound and export, but is managed separately
          in <Link to="/loom/saved">Saved items</Link>.
        </p>
        {context.store
          .all()
          .filter((record) => !['saved.set', 'following.set'].includes(record.kind))
          .map((record) => (
            <div className="list-row" key={record.key}>
              <Link to={intentUrl(record)}>
                {record.kind}
                {record.kind === 'file.upload'
                  ? ' · ' +
                    String(record.body.path) +
                    ' · ' +
                    String((record.body.target as { resource_id: string }).resource_id)
                  : ''}{' '}
                · {record.state} · {new Date(record.created_at).toLocaleString()}
              </Link>
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
        <p>
          Saved items and Following have separate private server state and recovery controls. Shared
          Changes and personal Mentions/replies have independent checkpoints. File recovery retains
          metadata only. Reselect original bytes when needed; prepared files can be recovered
          without another upload. Agent execution remains outside this release.
        </p>
      </section>
    </>
  );
}
