import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { identityGeneration, request, type Intent, type IntentStore, type Self } from "./participation-client.js";
import type { OnboardingView } from "../contracts/participation.js";

export function useQuery<T>(
  path: string,
  schema?: import("@sinclair/typebox").TSchema,
) {
  const [data, setData] = useState<T>(),
    [error, setError] = useState(""),
    [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    const controller = new AbortController(),
      owner = identityGeneration();
    setData(undefined);
    setError("");
    void request<T>(path, {
      signal: controller.signal,
      ...(schema ? { schema } : {}),
    }).then(
      (value) => {
        if (active && owner === identityGeneration()) setData(value);
      },
      (failure) => {
        if (active && failure.name !== "AbortError") setError(failure.message);
      },
    );
    return () => {
      active = false;
      controller.abort();
    };
  }, [path, reload, schema]);
  return { data, error, refresh: () => setReload((value) => value + 1) };
}
export interface Context {
  self: Self;
  community: OnboardingView;
  store: IntentStore;
  refreshCommunity: () => void;
}

export function intentUrl(record: Intent) {
  if (record.kind === "summary.prepare") return record.slot.slice("summary.prepare:".length);
  if (record.kind === "summary.editors" || record.kind === 'artifact.editors') return `/loom/resource/${record.body.resource_id}`;
  if (record.kind === "saved.set") return "/loom/saved";
  if (record.kind === "organization.change") return "/loom/organize?intent=" + encodeURIComponent(record.key);
  const intent = "intent=" + encodeURIComponent(record.key),
    body = record.body;
  if (record.kind === "reply.create")
    return `/loom/discussion/${body.discussion_id}?focus=${body.parent_id}&${intent}`;
  if (record.kind === "summary.create")
    return `/loom/discussion/${body.discussion_id}?summary=create&${intent}`;
  if (record.kind === "revision.publish" || record.kind === "summary.revise")
    return `/loom/resource/${body.resource_id}?edit=1&${intent}`;
  if ((record.kind === "discussion.create" || record.kind === "artifact.create") && record.body.proposal_context) {
    const area = (record.body.proposal_context as {affected_area_id?:string}).affected_area_id;
    return `${area ? '/loom/area/'+area : '/loom/overview'}?proposal=1&${intent}`;
  }
  if (record.kind === "discussion.create" || record.kind === "artifact.create")
    return `/loom/area/${body.area_id}?compose=${record.kind === "discussion.create" ? "discussions" : "artifacts"}&${intent}`;
  return "/loom/admin?" + intent;
}

// Queue saves from rapid input in one view, while IntentStore serializes and
// compares versions across tabs. Navigation may finish saving the old draft;
// identity changes and unmounted views cannot receive its UI result.
export function useIntent(initial: () => Intent | undefined) {
  const location = useLocation(),
    navigate = useNavigate();
  const [record, setRecord] = useState(initial);
  const current = useRef(record),
    queue = useRef(Promise.resolve()),
    owner = useRef(identityGeneration()),
    live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  function update(
    work: (record: Intent | undefined) => Promise<Intent | undefined>,
  ) {
    const pending = queue.current.then(async () => {
      if (owner.current !== identityGeneration())
        throw new DOMException("Identity changed.", "AbortError");
      const previous = current.current;
      const next = await work(previous);
      current.current = next;
      if (live.current && owner.current === identityGeneration()) {
        setRecord(next);
        if (
          next &&
          (next.blocked_by || (previous && next.key !== previous.key)) &&
          new URLSearchParams(location.search).get("intent") !== next.key
        ) {
          void navigate(intentUrl(next), { replace: true });
        }
      }
      return next;
    });
    queue.current = pending.then(
      () => {},
      () => {},
    );
    return pending;
  }
  return [record, update] as const;
}

export function SeparateDraft({
  record,
  review,
}: {
  record: Intent | undefined;
  review: () => void;
}) {
  return record?.blocked_by ? (
    <div className="notice">
      <strong>Your changes were saved separately.</strong>
      <p>
        Another view changed the original submission. Check it in Local drafts
        before choosing to publish these changes as a new submission.
      </p>
      <Link to="/loom/help">Inspect local drafts</Link>{" "}
      <button onClick={review}>Continue with separate draft</button>
    </div>
  ) : null;
}
