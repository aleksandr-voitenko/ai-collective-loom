import { FileBrowser } from "./Files.js";
import { useState } from "react";
import { useLocation, Link } from "react-router";
import { type RevisionView, Revision, type ResourceView } from "../contracts/participation.js";
import { type Context, useQuery } from "./participation-state.js";
import { OrganizationActions } from "./Organization.js";
import { ChangeDetails, ChangeDiscoveryViewComponent } from "./Changes.js";
import { ReferenceViews } from "./References.js";
import { SaveControl } from "./SavedItems.js";
import { FollowControl } from './Following.js';
import { AuthorizationBoundary } from './AuthorizationBoundary.js';
import { ReadingText } from './Reading.js';
import { SuppressLink } from './Moderation.js';
import { CoverageDetails } from './Summaries.js';
import { Avatar, Collection, ErrorText } from "./participation-ui.js";
import { Composer } from "./ParticipationComposer.js";
import { Editors } from "./ParticipationEditors.js";

export function ResourcePage(props:{id:string;revision:string|undefined;context:Context}){
  return <AuthorizationBoundary scope={"resource:"+props.id}><ResourceContent {...props}/></AuthorizationBoundary>;
}

export function ResourceContent({
  id,
  revision,
  context,
}: {
  id: string;
  revision: string | undefined;
  context: Context;
}) {
  const { data, error, refresh } = useQuery<RevisionView>(
    `/api/v1/resources/${id}${revision ? "/revisions/" + revision : ""}`,
    Revision,
  );
  const [edit, setEdit] = useState(
      new URLSearchParams(useLocation().search).has("edit"),
    ),
    [history, setHistory] = useState(false);
  const historyView = (
    <>
      <button onClick={() => setHistory((value) => !value)}>
        Revision history
      </button>
      {history && <RevisionHistory id={id} />}
    </>
  );
  if (error)
    return (
      <>
        <ErrorText error={error} />
        <button onClick={refresh}>Retry revision</button>
        <p>
          Retained revisions may still be available. Each revision has its own
          access check.
        </p>
        {historyView}
      </>
    );
  if (!data) return <p role="status">Loading revision…</p>;
  return (
    <>
      <div className="breadcrumb">
        <Link to="/loom">Topics</Link>
        <span>›</span>
        {data.discussion_id ? (
          <Link to={"/loom/discussion/" + data.discussion_id}>
            Conversation
          </Link>
        ) : (
          <Link to="/loom/artifacts">Artifacts</Link>
        )}
      </div>
      <div className="header-line">
        <div>
          <h1>{data.title ?? "Reply"}</h1>
          {!revision&&(data.kind==='artifact'||data.kind==='summary'||data.parent_id)&&
            <SuppressLink context={context} id={id} kind={data.kind==='artifact'?'artifact':data.kind==='summary'?'summary':'comment'}/>}
          <p className="subtitle">
            {revision ? "Exact revision" : "Current revision"}{" "}
            {data.revision_number} · published by {data.publisher.nickname}
          </p>
        </div>
        {data.kind === 'summary' ? <span className="fineprint">Saving summaries is not supported in this release.</span> : <SaveControl context={context} target={revision
          ? { kind: "revision", resource_id: id, revision_id: revision }
          : { kind: data.kind === "artifact" ? "artifact" : "contribution", resource_id: id }} />}
        <button onClick={() => setHistory((value) => !value)}>
          Revision history
        </button>
      </div>
      {revision && data.revision_id !== data.current_revision_id && (
        <div className="notice neutral">
          You are reading an earlier revision.{" "}
          <Link to={"/loom/resource/" + id}>View current revision</Link>
        </div>
      )}
      <article className="post card">
        <div className="author-line">
          <Avatar person={data.author} />
          <strong>{data.author.nickname}</strong>
          {data.author.kind === "agent" && (
            <span className="author-badge">Agent</span>
          )}
        </div>
        {data.content.text.length>0&&<ReadingText key={data.revision_id} target={{resource_id:id,revision_id:data.revision_id}} number={data.revision_number}
          content={data.content}
          participants={data.mentioned_participants}
        />
        }
        {data.file_set&&<FileBrowser key={data.revision_id} artifact={id} revision={data.revision_id}/>}
        <ChangeDetails revision={data}/>
        <ChangeDiscoveryViewComponent key={id+data.revision_id} resource={id} revision={data.revision_id} kind={data.kind === "summary" ? "summary" : data.kind === "artifact" ? "artifact" : "contribution"}/>
        <ReferenceViews key={id+data.revision_id+(revision??'current')} sourceId={id} sourceRevision={data.revision_id}
          target={{kind:data.kind === "summary" ? "summary" : data.kind === "artifact" ? "artifact" : "contribution",resource_id:id,...(revision?{revision_id:revision}:{})}}/>
        {data.parent_id && (
          <p className="parent-context">
            In reply to{" "}
            <Link to={"/loom/resource/" + data.parent_id}>
              the actual parent
            </Link>
          </p>
        )}
        <div className="post-footer">
          {!revision && data.kind !== 'summary' && <SaveControl context={context} target={{ kind: "revision", resource_id: id, revision_id: data.revision_id }} />}
          {data.can_edit && (
            <button
              className="text-button"
              onClick={() => setEdit((value) => !value)}
            >
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
      {data.kind === 'summary' && <CoverageDetails key={data.revision_id} id={id} revision={data.revision_id}/>}
      {edit && (
        <Composer
          context={context}
          kind={data.kind === 'summary' ? 'summary.revise' : 'revision.publish'}
          path={data.kind === 'summary' ? '/api/v1/summary-revisions' : '/api/v1/revisions'}
          slot={"edit:" + id}
          fixed={{
            resource_id: id,
            expected_revision_id: data.revision_id,
            title: data.title,
          }}
          titleField={data.title !== null}
          initialTitle={data.title ?? ""}
          initialText={data.content.text}
          initialMentions={data.content.mentions}
          initialFormat={data.content.format}
          initialReferences={data.content.format !== "loom-markdown-v1" ? data.content.references : []}
          initialChangeAccount={data.change_account?.state === "declared" ? {carry_forward_revision_id:data.revision_id} : null}
          initialFileSet={data.file_set?{version:data.file_set.version,files:data.file_set.files}:undefined}
          resourceKind={data.kind}
          summaryDiscussion={data.kind === 'summary' ? data.discussion_id! : undefined}
          initialCoverage={data.kind === 'summary' ? {carry_forward_revision_id:data.revision_id} : undefined}
          heading="Edit text"
        />
      )}
      {history && <RevisionHistory id={id} />}
      {data.kind === "artifact" && context.self.role === "administrator" && <OrganizationActions id={id} kind="artifact"/>}
      {data.kind === 'artifact' && <FollowControl key={'artifact:'+id} context={context} target={{kind:'artifact',resource_id:id}}/>}
      {(data.kind === "artifact" || data.kind === 'summary') && <Editors id={id} context={context} kind={data.kind} />}
    </>
  );
}

function RevisionHistory({ id }: { id: string }) {
  return (
    <section className="section">
      <h2>Retained revisions</h2>
      <Collection
        path={"/api/v1/resources/" + id + "/history"}
        render={(item) => {
          const revision = item as ResourceView;
          return (
            <Link
              className="list-row"
              to={`/loom/resource/${id}/${revision.revision_id}`}
            >
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
