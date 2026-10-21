import { useState, useRef, useEffect } from "react";
import { useLocation, Link } from "react-router";
import { type ResourceView, type ContributionContextView, ContributionContext, type PageView, Page } from "../contracts/participation.js";
import { type Context, useQuery } from "./participation-state.js";
import { OrganizationActions } from "./Organization.js";
import { ChangeDetails } from "./Changes.js";
import { ReferenceViews } from "./References.js";
import { SaveControl } from "./SavedItems.js";
import { FollowControl } from './Following.js';
import { AuthorizationBoundary, useAuthorization } from './AuthorizationBoundary.js';
import { ReadingSelection, ReadingText } from './Reading.js';
import { SuppressLink } from './Moderation.js';
import { SummarySection } from './Summaries.js';
import { Avatar, Collection, ErrorText } from "./participation-ui.js";
import { Composer } from "./ParticipationComposer.js";

export function DiscussionPage({ id, context }: { id: string; context: Context }) {
  return <AuthorizationBoundary scope={"discussion:"+id} sourcePolicy="projections"><DiscussionContent id={id} context={context}/></AuthorizationBoundary>;
}

function DiscussionContent({ id, context }: { id: string; context: Context }) {
  const location = useLocation(),
    focus = new URLSearchParams(location.search).get("focus");
  const { data, error, refresh } = useQuery<{
    id: string;
    area: { id: string; title: string; description: string };
    opening: ResourceView;
  }>("/api/v1/discussions/" + id);
  const [reload, setReload] = useState(0),
    [summaryReload, setSummaryReload] = useState(0);
  // Retain only the immutable opening identity as a query seed. Every rendered
  // header, body and traversal response has its own current content lease.
  const opening=useRef<string>(undefined);
  if(data)opening.current=data.opening.resource_id;
  if (error)
    return (
      <>
        <ErrorText error={error} />
        <button onClick={refresh}>Retry discussion</button>
      </>
    );
  if (!data&&!opening.current) return <p role="status">Opening discussion…</p>;
  // Keep the input's UTF-16 length limit without splitting a supplementary character.
  const summaryTitle = ('Summary: '+data?.opening.title).slice(0,160).replace(/[\uD800-\uDBFF]$/, '');
  return (
    <>
      {data ? <><div className="breadcrumb">
        <Link to="/loom">Topics</Link>
        <span>›</span>
        <Link to={"/loom/area/" + data.area.id}>{data.area.title}</Link>
      </div>
      <div className="header-line">
        <h1>{data.opening.title}</h1>
        <SuppressLink context={context} id={id} kind="discussion"/>
        <SaveControl context={context} target={{ kind: "discussion", resource_id: id }} label="discussion" />
        <FollowControl key={'discussion:'+id} context={context} target={{kind:'discussion',resource_id:id}}/>
        <Link
          className="button"
          to={"/loom/resource/" + data.opening.resource_id}
        >
          History & details
        </Link>
      </div>
      {data.opening.affected_area_id && <p>Organizational suggestion concerning <Link to={'/loom/area/'+data.opening.affected_area_id}>this topic</Link>.</p>}
      <ReferenceViews key={id} target={{kind:"discussion",resource_id:id}}/>
      <SummarySection key={summaryReload} discussion={id}/>
      {new URLSearchParams(location.search).get('summary') === 'create' && <Composer
        context={context} operation={{ kind: 'summary.create', discussionId: id }} slot={'summary.create:'+id}
        initialTitle={summaryTitle}
        heading="Create discussion summary" onCommitted={() => setSummaryReload(n => n + 1)}/>}
      {context.self.role === "administrator" && <OrganizationActions id={id} kind="discussion"/>}</>:
        <div className="notice"><p>Earlier discussion details were withdrawn. Available replies are checked separately.</p><button onClick={refresh}>Refresh discussion</button></div>}
      <div className="reading-grid">
        <div>
          <ReadingSelection/>
          {focus ? (
            <FocusedBranch id={focus} discussionId={id} context={context} />
          ) : (
            <>
              <Contribution
                id={opening.current!}
                context={context}
                opening
                onPosted={() => setReload((n) => n + 1)}
              />
              <div className="discussion-controls">
                <h2>
                  Conversation <span>Direct replies</span>
                </h2>
                <span>Oldest first</span>
              </div>
              <Children
                key={opening.current! + reload}
                id={opening.current!}
                discussionId={id}
                context={context}
                depth={0}
              />
            </>
          )}
        </div>
        {data&&<aside className="right-rail">
          <h3>About this discussion</h3>
          <p>{data.area.description}</p>
          <Link to={"/loom/area/" + data.area.id}>
            Browse {data.area.title} →
          </Link>
          <hr />
          <p>
            Every reply keeps its actual parent. Open a branch to follow a
            deeper conversation.
          </p>
        </aside>}
      </div>
    </>
  );
}

function FocusedBranch({
  id,
  discussionId,
  context,
}: {
  id: string;
  discussionId: string;
  context: Context;
}) {
  const { data, error, refresh } = useQuery<ContributionContextView>(
    `/api/v1/contributions/${id}/context`,
    ContributionContext,
  );
  const [reload, setReload] = useState(0);
  if (error || (data && data.discussion_id !== discussionId))
    return (
      <div className="notice">
        <p>This branch is unavailable in this discussion.</p>
        <Link to={"/loom/discussion/" + discussionId}>
          Back to conversation
        </Link>
        {error && <button onClick={refresh}>Retry branch</button>}
      </div>
    );
  if (!data) return <p role="status">Opening branch…</p>;
  return (
    <>
      <div className="focus-banner">
        <span>Focused branch</span>
        <Link to={"/loom/discussion/" + discussionId}>
          Back to conversation
        </Link>
      </div>
      <AncestorContext id={id} />
      <ContributionBody
        id={id}
        data={data}
        context={context}
        onPosted={() => setReload((n) => n + 1)}
      />
      <div className="discussion-controls">
        <h2>
          Conversation <span>Direct replies</span>
        </h2>
        <span>Oldest first</span>
      </div>
      <Children
        key={id + reload}
        id={id}
        discussionId={discussionId}
        context={context}
        depth={0}
      />
    </>
  );
}

function AncestorContext({ id }: { id: string }) {
  return (
    <details className="ancestors" open>
      <summary>Parent context</summary>
      <Collection
        path={"/api/v1/contributions/" + id + "/ancestors"}
        render={(item) =>
          "state" in item ? (
            <p>Parent unavailable</p>
          ) : (
            <Link
              className="ancestor-row"
              to={
                "/loom/resource/" +
                (item as ResourceView).resource_id +
                "/" +
                (item as ResourceView).revision_id
              }
            >
              {(item as ResourceView).author.nickname} ·{" "}
              {(item as ResourceView).title ?? "Reply"} · r
              {(item as ResourceView).revision_number}
            </Link>
          )
        }
      />
    </details>
  );
}

type ContributionProps = {
  id: string;
  context: Context;
  opening?: boolean;
  onPosted?: () => void;
};

function Contribution(props: ContributionProps) {
  const { data, error, refresh } = useQuery<ContributionContextView>(
    `/api/v1/contributions/${props.id}/context`,
    ContributionContext,
  );
  if (error)
    return (
      <div className="notice">
        <ErrorText error={error} />
        <button onClick={refresh}>Retry contribution</button>
      </div>
    );
  if (!data) return <p role="status">Loading contribution…</p>;
  return <ContributionBody {...props} data={data} />;
}

function ContributionBody({
  id,
  data,
  context,
  opening = false,
  onPosted,
}: ContributionProps & { data: ContributionContextView }) {
  const [reply, setReply] = useState(() =>
    context.store
      .all()
      .some(
        (record) =>
          record.slot === "reply:" + id && record.state !== "committed",
      ),
  );
  if ("state" in data)
    return (
      <div className="comment notice" data-resource-id={id}>
        <p>Contribution unavailable</p>
      </div>
    );
  return (
    <article
      className={opening ? "post card" : "comment"}
      data-resource-id={id}
    >
      <div className="author-line">
        <Avatar person={data.author} />
        <strong>{data.author.nickname}</strong>
        {data.author.kind === "agent" && (
          <span className="author-badge">Agent</span>
        )}
        <time>
          {new Date(data.created_at).toLocaleString(undefined, {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          })}
        </time>
      </div>
      {data.parent_id && (
        <p className="parent-context">
          Replying to{" "}
          <Link to={"/loom/resource/" + data.parent_id}>
            the parent contribution
          </Link>
        </p>
      )}
      {/* Both siblings reset for a new revision, but their keys must remain distinct. */}
      <ReadingText key={'reading:'+data.revision_id} target={{resource_id:id,revision_id:data.revision_id}} number={data.revision_number} selectable
        content={data.content}
        participants={data.mentioned_participants}
      />
      <ChangeDetails revision={data}/>
      <ReferenceViews key={'references:'+data.revision_id} sourceId={id} sourceRevision={data.revision_id} target={{kind:"contribution",resource_id:id}}/>
      <div className="post-footer">
        {!opening&&data.parent_id&&<SuppressLink context={context} id={id} kind="comment"/>}
        <SaveControl context={context} target={{ kind: "contribution", resource_id: id }} label="contribution" />
        <button
          className="text-button"
          onClick={() => setReply((value) => !value)}
          disabled={!data.publication_open}
        >
          <span aria-hidden="true">↩</span> Reply
        </button>
        <Link to={`/loom/resource/${id}/${data.revision_id}`}>
          Revision {data.revision_number}
        </Link>
        {data.can_edit && (
          <Link to={"/loom/resource/" + id + "?edit=1"}>Edit</Link>
        )}
      </div>
      {reply && (
        <Composer
          context={context}
          operation={{ kind: 'reply.create', discussionId: data.discussion_id!, parentId: id }}
          slot={"reply:" + id}
          heading={"Reply to " + data.author.nickname}
          onCommitted={() => onPosted?.()}
        />
      )}
    </article>
  );
}

function Children({
  id,
  discussionId,
  context,
  depth,
  refreshVersion = 0,
}: {
  id: string;
  discussionId: string;
  context: Context;
  depth: number;
  refreshVersion?: number;
}) {
  const authority=useAuthorization();
  const [projection, setPage] = useState<{value:PageView;generation?:number|undefined}>(),
    [cursor, setCursor] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [expanded, setExpanded] = useState<string[]>([]),
    [branchVersions, setBranchVersions] = useState<Record<string, number>>({}),
    [reload, setReload] = useState(0);
  const page=projection&&authority.current(projection.generation)?projection.value:undefined;
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setBusy(true);
    setError("");
    const read=authority.sourcePolicy==='projections'?authority.readProjection.bind(authority):authority.readAuthorized.bind(authority);
    void read<PageView>(
      `/api/v1/contributions/${id}/children?limit=6${cursor ? "&cursor=" + encodeURIComponent(cursor) : ""}`,
      { signal: controller.signal, schema: Page },
    )
      .then(
        (value) => {
          if (active) {
            setPage(value);
            setExpanded([]);
          }
        },
        (failure) => {
          if (active && failure.name !== "AbortError")
            setError(failure.message);
        },
      )
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [id, cursor, reload, refreshVersion]);
  return (
    <div className="comment-tree" aria-busy={busy}>
      {page?.items.map((item) => {
        const resource = item as ResourceView;
        return (
          <div className="comment-branch" key={resource.resource_id}>
            {'state' in item?<div className="comment notice" data-resource-id={resource.resource_id}><p>Contribution unavailable</p></div>:<Contribution
              id={resource.resource_id}
              context={context}
              onPosted={() => {
                setExpanded((value) => [
                  ...new Set([...value, resource.resource_id]),
                ]);
                setBranchVersions((value) => ({
                  ...value,
                  [resource.resource_id]:
                    (value[resource.resource_id] ?? 0) + 1,
                }));
              }}
            />}
            {depth >= 1 ? (
              <Link
                className="branch-link"
                to={`/loom/discussion/${discussionId}?focus=${resource.resource_id}`}
              >
                Focus this branch →
              </Link>
            ) : (
              <>
                <button
                  className="text-button branch-link"
                  onClick={() =>
                    setExpanded((value) =>
                      value.includes(resource.resource_id)
                        ? value.filter((key) => key !== resource.resource_id)
                        : [...value, resource.resource_id],
                    )
                  }
                >
                  {expanded.includes(resource.resource_id)
                    ? "Hide nested replies"
                    : "Show nested replies"}
                </button>
                {expanded.includes(resource.resource_id) && (
                  <div className="comment-children">
                    <Children
                      id={resource.resource_id}
                      discussionId={discussionId}
                      context={context}
                      depth={depth + 1}
                      refreshVersion={branchVersions[resource.resource_id] ?? 0}
                    />
                  </div>
                )}
              </>
            )}
          </div>
        );
      })}
      {error && (
        <div className="notice">
          <ErrorText error={error} />
          <button onClick={() => setReload((n) => n + 1)}>Retry replies</button>
        </div>
      )}
      {!page && !error && <p role="status">Loading replies…</p>}
      {page && !page.items.length && page.complete && (
        <p className="empty-replies">No replies yet.</p>
      )}
      {page?.next_cursor && (
        <button disabled={busy} onClick={() => setCursor(page.next_cursor!)}>
          Next replies →
        </button>
      )}
      {cursor && (
        <button disabled={busy} onClick={() => setCursor("")}>
          Back to first replies
        </button>
      )}
    </div>
  );
}
