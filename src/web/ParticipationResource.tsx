import { ArtifactProvenance, ProvenanceDetails } from './AttachmentPromotion.js';
import { FileBrowser } from './Files.js';
import { useState } from 'react';
import { useLocation, Link } from 'react-router';
import { type RevisionView, Revision, type ResourceView } from '../contracts/participation.js';
import { type Context, useQuery } from './participation-state.js';
import { OrganizationActions } from './Organization.js';
import { ChangeDetails, ChangeDiscoveryViewComponent } from './Changes.js';
import { ReferenceViews } from './References.js';
import { SaveControl } from './SavedItems.js';
import { FollowControl } from './Following.js';
import { AuthorizationBoundary } from './AuthorizationBoundary.js';
import { ReadingText } from './Reading.js';
import { SuppressLink } from './Moderation.js';
import { CoverageDetails } from './Summaries.js';
import { Avatar, Collection, ErrorText } from './participation-ui.js';
import { Composer } from './ParticipationComposer.js';
import { Editors } from './ParticipationEditors.js';

export function ResourcePage(props: {
  id: string;
  revision: string | undefined;
  context: Context;
}) {
  const location = useLocation();
  const attribution = !!props.revision && new URLSearchParams(location.search).has('attribution');
  return (
    <AuthorizationBoundary
      key={props.id + ':' + props.revision + ':' + attribution}
      scope={'resource:' + props.id}
      sourcePolicy={attribution ? 'projections' : 'withdraw'}
    >
      <ResourceContent {...props} attribution={attribution} />
    </AuthorizationBoundary>
  );
}

export function ResourceContent({
  id,
  revision,
  context,
  attribution = false,
}: {
  id: string;
  revision: string | undefined;
  context: Context;
  attribution?: boolean;
}) {
  const { data, error, refresh } = useQuery<RevisionView>(
    `/api/v1/resources/${id}${revision ? '/revisions/' + revision : ''}`,
    Revision,
  );
  const presentation = data && (
    <ResourcePresentation
      data={data}
      id={id}
      revision={revision}
      context={context}
      attribution={attribution}
    />
  );
  // Attribution owns only its fresh response. A source denial removes the whole
  // old resource presentation; its body and controls return only after a new read.
  return (
    <>
      {error ? (
        <>
          <ErrorText error={error} />
          <button onClick={refresh}>Retry revision</button>
          <p>Retained revisions may still be available. Each revision has its own access check.</p>
          <ResourceHistory id={id} />
        </>
      ) : data ? (
        attribution ? (
          // Only revision and attribution query values share the projection host.
          // Opaque controls keep conservative withdrawal for their own denials.
          <AuthorizationBoundary>{presentation}</AuthorizationBoundary>
        ) : (
          presentation
        )
      ) : (
        <p role="status">Loading revision…</p>
      )}
      {attribution && revision && (
        <section aria-label="Source attribution">
          <Link to={`/loom/resource/${id}/${revision}`}>Close source attribution</Link>
          <ProvenanceDetails
            url={`/api/v1/artifacts/${id}/revisions/${revision}/provenance`}
            reauthorizeArtifact={refresh}
          />
        </section>
      )}
    </>
  );
}

function ResourceHistory({ id }: { id: string }) {
  const [history, setHistory] = useState(false);
  return (
    <>
      <button onClick={() => setHistory((value) => !value)}>Revision history</button>
      {history && <RevisionHistory id={id} />}
    </>
  );
}

function ResourcePresentation({
  data,
  id,
  revision,
  context,
  attribution,
}: {
  data: RevisionView;
  id: string;
  revision: string | undefined;
  context: Context;
  attribution: boolean;
}) {
  const [edit, setEdit] = useState(new URLSearchParams(useLocation().search).has('edit')),
    [history, setHistory] = useState(false);
  return (
    <>
      <div className="breadcrumb">
        <Link to="/loom">Topics</Link>
        <span>›</span>
        {data.discussion_id ? (
          <Link to={'/loom/discussion/' + data.discussion_id}>Conversation</Link>
        ) : (
          <Link to="/loom/artifacts">Artifacts</Link>
        )}
      </div>
      <div className="header-line">
        <div>
          <h1>{data.title ?? 'Reply'}</h1>
          {!revision && (data.kind === 'artifact' || data.kind === 'summary' || data.parent_id) && (
            <SuppressLink
              context={context}
              id={id}
              kind={
                data.kind === 'artifact'
                  ? 'artifact'
                  : data.kind === 'summary'
                    ? 'summary'
                    : 'comment'
              }
            />
          )}
          <p className="subtitle">
            {revision ? 'Exact revision' : 'Current revision'} {data.revision_number} · published by{' '}
            {data.publisher.nickname}
          </p>
        </div>
        {data.kind === 'summary' ? (
          <span className="fineprint">Saving summaries is not supported in this release.</span>
        ) : (
          <SaveControl
            context={context}
            target={
              revision
                ? { kind: 'revision', resource_id: id, revision_id: revision }
                : { kind: data.kind === 'artifact' ? 'artifact' : 'contribution', resource_id: id }
            }
          />
        )}
        <button onClick={() => setHistory((value) => !value)}>Revision history</button>
      </div>
      {revision && data.revision_id !== data.current_revision_id && (
        <div className="notice neutral">
          You are reading an earlier revision.{' '}
          <Link to={'/loom/resource/' + id}>View current revision</Link>
        </div>
      )}
      <article className="post card">
        <div className="author-line">
          <Avatar person={data.author} />
          <strong>{data.author.nickname}</strong>
          {data.author.kind === 'agent' && <span className="author-badge">Agent</span>}
        </div>
        {data.content.text.length > 0 && (
          <ReadingText
            key={data.revision_id}
            target={{ resource_id: id, revision_id: data.revision_id }}
            number={data.revision_number}
            content={data.content}
            participants={data.mentioned_participants}
          />
        )}
        {data.attachment_set && (
          <FileBrowser
            key={'attachments:' + data.revision_id}
            contribution={id}
            revision={data.revision_id}
          />
        )}
        {data.provenance_url && !attribution && (
          <ArtifactProvenance resource={id} revision={data.revision_id} />
        )}
        {data.file_set && (
          <FileBrowser
            key={'files:' + data.revision_id}
            artifact={id}
            revision={data.revision_id}
          />
        )}
        <ChangeDetails revision={data} />
        <ChangeDiscoveryViewComponent
          key={id + data.revision_id}
          resource={id}
          revision={data.revision_id}
          kind={
            data.kind === 'summary'
              ? 'summary'
              : data.kind === 'artifact'
                ? 'artifact'
                : 'contribution'
          }
        />
        <ReferenceViews
          key={id + data.revision_id + (revision ?? 'current')}
          sourceId={id}
          sourceRevision={data.revision_id}
          target={{
            kind:
              data.kind === 'summary'
                ? 'summary'
                : data.kind === 'artifact'
                  ? 'artifact'
                  : 'contribution',
            resource_id: id,
            ...(revision ? { revision_id: revision } : {}),
          }}
        />
        {data.parent_id && (
          <p className="parent-context">
            In reply to <Link to={'/loom/resource/' + data.parent_id}>the actual parent</Link>
          </p>
        )}
        <div className="post-footer">
          {!revision && data.kind !== 'summary' && (
            <SaveControl
              context={context}
              target={{ kind: 'revision', resource_id: id, revision_id: data.revision_id }}
            />
          )}
          {data.can_edit && (
            <button className="text-button" onClick={() => setEdit((value) => !value)}>
              Edit this text
            </button>
          )}
          {data.discussion_id && data.kind !== 'summary' && (
            <Link to={`/loom/discussion/${data.discussion_id}?focus=${id}`}>
              Reply in this branch
            </Link>
          )}
        </div>
      </article>
      {data.kind === 'summary' && (
        <CoverageDetails key={data.revision_id} id={id} revision={data.revision_id} />
      )}
      {edit && (
        <Composer
          context={context}
          operation={
            data.kind === 'summary'
              ? {
                  kind: 'summary.revise',
                  resourceId: id,
                  revisionId: data.revision_id,
                  title: data.title,
                  discussionId: data.discussion_id!,
                }
              : {
                  kind: 'revision.publish',
                  resourceId: id,
                  revisionId: data.revision_id,
                  title: data.title,
                  resourceKind: data.kind === 'artifact' ? 'artifact' : 'contribution',
                }
          }
          slot={'edit:' + id}
          initialTitle={data.title ?? ''}
          initialText={data.content.text}
          initialMentions={data.content.mentions}
          initialFormat={data.content.format}
          initialReferences={
            data.content.format !== 'loom-markdown-v1' ? data.content.references : []
          }
          initialChangeAccount={
            data.change_account?.state === 'declared'
              ? { carry_forward_revision_id: data.revision_id }
              : null
          }
          initialFileSet={
            (data.file_set ?? data.attachment_set)
              ? {
                  version: (data.file_set ?? data.attachment_set)!.version,
                  files: (data.file_set ?? data.attachment_set)!.files,
                }
              : undefined
          }
          initialCoverage={
            data.kind === 'summary' ? { carry_forward_revision_id: data.revision_id } : undefined
          }
          heading="Edit text"
        />
      )}
      {history && <RevisionHistory id={id} />}
      {data.kind === 'artifact' && context.self.role === 'administrator' && (
        <OrganizationActions id={id} kind="artifact" />
      )}
      {data.kind === 'artifact' && (
        <FollowControl
          key={'artifact:' + id}
          context={context}
          target={{ kind: 'artifact', resource_id: id }}
        />
      )}
      {(data.kind === 'artifact' || data.kind === 'summary') && (
        <Editors id={id} context={context} kind={data.kind} />
      )}
    </>
  );
}

function RevisionHistory({ id }: { id: string }) {
  return (
    <section className="section">
      <h2>Retained revisions</h2>
      <Collection
        path={'/api/v1/resources/' + id + '/history'}
        render={(item) => {
          const revision = item as ResourceView;
          return (
            <Link className="list-row" to={`/loom/resource/${id}/${revision.revision_id}`}>
              <span>Revision {revision.revision_number}</span>
              <span>{revision.publisher.nickname}</span>
              <time>{new Date(revision.created_at).toLocaleString()}</time>
            </Link>
          );
        }}
      />
    </section>
  );
}
