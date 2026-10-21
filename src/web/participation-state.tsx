import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import {
  identityGeneration,
  type Intent,
  type IntentStore,
  type Self,
} from './participation-client.js';
import type { OnboardingView } from '../contracts/participation.js';
import { useAuthorization, type AuthorizedValue } from './AuthorizationBoundary.js';

export function useQuery<T>(path: string, schema?: import('@sinclair/typebox').TSchema) {
  const authority = useAuthorization();
  const generation = authority.capture();
  const requestGeneration = useRef<number | undefined>(
    authority.getSnapshot().state === 'withdrawn' ? undefined : generation,
  );
  const [result, setData] = useState<AuthorizedValue<T>>(),
    [error, setError] = useState(''),
    [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    const controller = new AbortController(),
      owner = identityGeneration(),
      authorization = authority.capture();
    setData(undefined);
    setError('');
    // Recovery may mount a query after withdrawal. Neither that mount nor an
    // older command's refresh callback can authorize another metadata request.
    if (!authority.current(requestGeneration.current)) return;
    const options = {
      signal: controller.signal,
      ...(schema ? { schema } : {}),
    };
    // The boundary classifies refusal evidence independently of hook liveness.
    const request =
      authority.sourcePolicy === 'projections'
        ? authority.readProjection<T>(path, options)
        : authority.readAuthorized<T>(path, options);
    void request.then(
      (value) => {
        if (active && owner === identityGeneration() && authority.current(value.generation)) {
          // A fresh mixed projection may advance its own lease. Its next page
          // remains usable without authorizing another query's old callback.
          requestGeneration.current = value.generation;
          setData(value);
        }
      },
      (failure) => {
        if (active && failure.name !== 'AbortError' && authority.current(authorization)) {
          setError(failure.message);
        }
      },
    );
    return () => {
      active = false;
      controller.abort();
    };
  }, [path, reload, schema, authority]);
  const automaticGeneration = requestGeneration.current;
  const refresh = () => {
    if (authority.current(generation)) {
      requestGeneration.current = generation;
      setReload((value) => value + 1);
    }
  };
  return {
    data: result && authority.current(result.generation) ? result.value : undefined,
    generation: result?.generation,
    error,
    refresh,
    // Private success may refresh an already authorized query, but cannot turn
    // a recovery action issued after withdrawal into metadata authorization.
    refreshIfCurrent: () => {
      if (authority.current(automaticGeneration)) refresh();
    },
  };
}
export interface Context {
  controlsProjection?: 'private-controls-1';
  self: Self;
  community: OnboardingView;
  store: IntentStore;
  refreshCommunity: () => void;
}

export function intentUrl(record: Intent) {
  if (record.kind === 'file.upload') {
    const target = record.body.target as { kind: string; resource_id: string };
    return target.kind === 'artifact'
      ? `/loom/resource/${target.resource_id}?edit`
      : `/loom/area/${target.resource_id}?compose=artifacts`;
  }
  if (record.kind === 'summary.prepare') return record.slot.slice('summary.prepare:'.length);
  if (record.kind === 'summary.editors' || record.kind === 'artifact.editors')
    return `/loom/resource/${record.body.resource_id}`;
  if (record.kind === 'saved.set') return '/loom/saved';
  if (record.kind === 'moderation.set')
    return '/loom/moderation?intent=' + encodeURIComponent(record.key);
  if (record.kind === 'following.set') return '/loom/following';
  if (record.kind === 'organization.change')
    return '/loom/organize?intent=' + encodeURIComponent(record.key);
  const intent = 'intent=' + encodeURIComponent(record.key),
    body = record.body;
  if (record.kind === 'reply.create')
    return `/loom/discussion/${body.discussion_id}?focus=${body.parent_id}&${intent}`;
  if (record.kind === 'summary.create')
    return `/loom/discussion/${body.discussion_id}?summary=create&${intent}`;
  if (record.kind === 'revision.publish' || record.kind === 'summary.revise')
    return `/loom/resource/${body.resource_id}?edit=1&${intent}`;
  if (
    (record.kind === 'discussion.create' || record.kind === 'artifact.create') &&
    record.body.proposal_context
  ) {
    const area = (record.body.proposal_context as { affected_area_id?: string }).affected_area_id;
    return `${area ? '/loom/area/' + area : '/loom/overview'}?proposal=1&${intent}`;
  }
  if (record.kind === 'discussion.create' || record.kind === 'artifact.create')
    return `/loom/area/${body.area_id}?compose=${record.kind === 'discussion.create' ? 'discussions' : 'artifacts'}&${intent}`;
  return '/loom/admin?' + intent;
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
  function update(work: (record: Intent | undefined) => Promise<Intent | undefined>) {
    const pending = queue.current.then(async () => {
      if (owner.current !== identityGeneration())
        throw new DOMException('Identity changed.', 'AbortError');
      const previous = current.current;
      const next = await work(previous);
      current.current = next;
      if (live.current && owner.current === identityGeneration()) {
        setRecord(next);
        if (
          next &&
          (next.blocked_by || (previous && next.key !== previous.key)) &&
          new URLSearchParams(location.search).get('intent') !== next.key
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
        Another view changed the original submission. Check it in Local drafts before choosing to
        publish these changes as a new submission.
      </p>
      <Link to="/loom/help">Inspect local drafts</Link>{' '}
      <button onClick={review}>Continue with separate draft</button>
    </div>
  ) : null;
}
