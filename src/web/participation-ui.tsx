import { type ReactNode, useState, useRef } from "react";
import { Link } from "react-router";
import { type PageView, Page, type ResourceView } from "../contracts/participation.js";
import { useQuery } from "./participation-state.js";
import { useAuthorization } from './AuthorizationBoundary.js';

export function Icon({
  name,
}: {
  name: "topic" | "artifact" | "discussion" | "help" | "saved" | "search";
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="icon"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <path
        d={
          name === 'search' ? 'M21 21l-6-6M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0' : name === "topic"
            ? "M4 3h6v6H4zM14 15h6v6h-6zM7 9v9h7"
            : name === "artifact"
              ? "M6 3h8l4 4v14H6zM14 3v5h4M9 12h6M9 16h6"
              : name === "discussion"
                ? "M3 4h18v13H8l-5 4z"
                : name === "saved" ? "M6 3h12v18l-6-4-6 4z" : "M12 16v1M10 8a2 2 0 1 1 3 2c-1 .5-1 1-1 3M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0"
        }
      />
    </svg>
  );
}

export function Avatar({ person }: { person: { nickname: string; kind: string } }) {
  return (
    <span
      className={"avatar " + person.kind}
      aria-label={person.kind === "agent" ? "Agent" : "Human"}
    >
      {person.nickname.slice(0, 2).toUpperCase()}
    </span>
  );
}

export function ErrorText({ error }: { error: string }) {
  return error ? (
    <p className="notice error" role="alert">
      {error}
    </p>
  ) : null;
}

export function Collection({
  path,
  render,
}: {
  path: string;
  render: (item: PageView["items"][number]) => ReactNode;
}) {
  const [cursor, setCursor] = useState(""),
    [previous, setPrevious] = useState<string[]>([]);
  const authority=useAuthorization();
  const { data: response, generation, error, refresh } = useQuery<PageView>(
    path + (cursor ? "?cursor=" + encodeURIComponent(cursor) : ""),
    Page,
  );
  const retained = useRef<{value:PageView;generation:number|undefined}>(undefined);
  if (response) retained.current = {value:response,generation};
  const data = response ?? (retained.current&&authority.current(retained.current.generation)?retained.current.value:undefined);
  return (
    <>
      <ErrorText error={error} />
      {error && <><button onClick={refresh}>Retry this page</button><button onClick={() => { setCursor(""); setPrevious([]); refresh(); }}>Refresh this collection</button></>}
      {!response && !error && <p role="status">Loading…</p>}
      {data && (
        <>
          <div className="collection">
            {data.items.length ? (
              data.items.map((item, index) => (
                <div key={index}>{render(item)}</div>
              ))
            ) : (
              <div className="empty-state">
                <h3>
                  {data.complete
                    ? "Nothing here yet"
                    : "More of this collection is available"}
                </h3>
                <p>
                  {data.complete
                    ? "Start something worth returning to."
                    : "Continue to inspect the next bounded page."}
                </p>
              </div>
            )}
          </div>
          <div className="pagination">
            <span>
              {data.items.length} shown ·{" "}
              {!response ? error ? "Previous page · refresh required" : "Previous page · loading" : data.complete ? "End of collection" : "More available"}
            </span>
            <div>
              <button
                disabled={!previous.length || !response}
                onClick={() => {
                  setCursor(previous.at(-1)!);
                  setPrevious((value) => value.slice(0, -1));
                }}
              >
                ← Previous
              </button>
              <button
                disabled={!data.next_cursor || !response}
                onClick={() => {
                  setPrevious((value) => [...value, cursor]);
                  setCursor(data.next_cursor!);
                }}
              >
                Next →
              </button>
            </div>
          </div>
        </>
      )}
    </>
  );
}

export function ResourceRow({
  resource,
  showLocation = false,
}: {
  resource: ResourceView;
  showLocation?: boolean;
}) {
  return (
    <Link
      className="list-row"
      to={
        resource.discussion_id
          ? `/loom/discussion/${resource.discussion_id}`
          : `/loom/resource/${resource.resource_id}`
      }
    >
      <Icon name={resource.kind === "artifact" ? "artifact" : "discussion"} />
      <div>
        <h3>{resource.title ?? "Reply"}</h3>
        <small>
          {resource.publisher.nickname} ·{" "}
          {resource.kind === "artifact"
            ? "Text · r" + resource.revision_number
            : "Discussion"}
          {showLocation ? " · " + resource.area_title : ""}
        </small>
      </div>
      <time>
        {new Date(resource.created_at).toLocaleDateString(undefined, {
          day: "numeric",
          month: "short",
        })}
      </time>
    </Link>
  );
}
