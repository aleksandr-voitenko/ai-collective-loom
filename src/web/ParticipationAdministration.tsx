import { useState } from "react";
import { useLocation } from "react-router";
import { type AuthoredContent, type CommittedView, type OnboardingView, Onboarding } from "../contracts/participation.js";
import { type Intent, commandRequest, isDefinitiveRejection } from "./participation-client.js";
import { type Context, useIntent, SeparateDraft, useQuery } from "./participation-state.js";
import { useAuthorization } from './AuthorizationBoundary.js';
import { SearchAdministration } from './Search.js';
import { ErrorText } from "./participation-ui.js";
import { Admission } from "./ParticipationAdmission.js";

export function Administration({ context }: { context: Context }) {
  const authority=useAuthorization();
  const generation=authority.capture();
  const refreshCommunityIfCurrent=()=>{
    if(authority.current(generation)&&authority.getSnapshot().state!=='withdrawn')context.refreshCommunity();
  };
  const chosen = new URLSearchParams(useLocation().search).get("intent");
  const [setupIntent, update] = useIntent(
    () =>
      context.store.all().find((r) => r.slot === "setup" && r.key === chosen) ??
      context.store.all().find((r) => r.slot === "setup"),
  );
  const [name, setName] = useState(
      String(setupIntent?.body.community_name ?? "Research commons"),
    ),
    [ordinary, setOrdinary] = useState(
      String(setupIntent?.body.ordinary_area_name ?? "General"),
    ),
    [proposal, setProposal] = useState(
      String(setupIntent?.body.proposal_area_name ?? "Community organization"),
    ),
    [overview, setOverview] = useState(
      (setupIntent?.body.overview as AuthoredContent | undefined)?.text ??
        "Welcome to our shared workspace.\n\nUse General for questions and ongoing work. Propose organizational changes in Community organization.",
    ),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const locked =
    busy ||
    (!!setupIntent &&
      (setupIntent.state !== "draft" || !!setupIntent.blocked_by));
  function setupBody() {
    return {
      community_name: name,
      ordinary_area_name: ordinary,
      proposal_area_name: proposal,
      overview: { format: "loom-markdown-v1", text: overview, mentions: [] },
    };
  }
  async function draft(patch: Record<string, unknown> = {}) {
    const body = { ...setupBody(), ...patch };
    try {
      if (setupIntent && setupIntent.state !== "draft")
        throw new Error("Prepare a correction before editing this request.");
      return await update((current) =>
        context.store.saveDraft(
          current ??
            context.store.create(
              "setup",
              "community.setup",
              "/api/v1/community/setup",
              body,
            ),
          body,
        ),
      );
    } catch (failure) {
      setError((failure as Error).message);
      return undefined;
    }
  }
  async function setup(check = false) {
    if (busy || setupIntent?.state === "rejected" || setupIntent?.blocked_by)
      return;
    let record: Intent | undefined,
      wasUncertain = false;
    setBusy(true);
    try {
      if (!setupIntent) await draft();
      record = await update(async (current) => {
        if (!current) throw new Error("Save the setup draft before sending.");
        wasUncertain = current.state === "uncertain";
        if (check) return current;
        return context.store.prepareDispatch(current, setupBody());
      });
      if (!record || (check && !wasUncertain)) return;
      setError("");
      const result = check
        ? await commandRequest<CommittedView | { operation_state: string }>(
            "/api/v1/operations/status",
            {
              self: context.self,
              body: {
                operation_kind: record.kind,
                idempotency_key: record.key,
              },
            },
          )
        : await commandRequest<CommittedView>(record.path, {
            self: context.self,
            body: record.body,
          });
      if ("publication_state" in result) {
        await update(async () => {
          await context.store.complete(record!);
          return undefined;
        });
        refreshCommunityIfCurrent();
      } else setError("Setup is still unconfirmed. Keep this original intent.");
    } catch (failure) {
      if (record && !check && isDefinitiveRejection(failure, wasUncertain)) {
        const rejected = { ...record, state: "rejected" as const };
        try {
          await update(() => context.store.settle(record!, rejected));
        } catch (storageFailure) {
          setError((storageFailure as Error).message);
          return;
        }
      }
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function correct() {
    if (!setupIntent) return;
    try {
      await update((current) => context.store.correct(current!));
      setError("");
    } catch (failure) {
      setError((failure as Error).message);
    }
  }
  return (
    <>
      <h1>Administration</h1>
      <p className="subtitle">Set up the community and admit participants.</p>
      {authority.getSnapshot().state==='withdrawn'&&<div role="status" className="notice"><p>Administrator metadata was withdrawn. Your private drafts and exact recovery remain available. Refresh the affected section to check access again.</p><button onClick={context.refreshCommunity}>Refresh administration</button></div>}
      <SearchAdministration context={context}/>
      <ErrorText error={error} />
      <SeparateDraft
        record={setupIntent}
        review={() =>
          void update(async (current) => {
            const { blocked_by: _, ...next } = current!;
            return context.store.save(next);
          }).catch((failure) => setError(failure.message))
        }
      />
      {context.community.settings_version === 0 ? (
        <section className="card admin-card">
          <h2>Initialize the community</h2>
          <label>
            Community name
            <input
              value={name}
              disabled={locked}
              onChange={(e) => {
                setName(e.target.value);
                draft({ community_name: e.target.value });
              }}
            />
          </label>
          <label>
            Ordinary topic
            <input
              value={ordinary}
              disabled={locked}
              onChange={(e) => {
                setOrdinary(e.target.value);
                draft({ ordinary_area_name: e.target.value });
              }}
            />
          </label>
          <label>
            Proposal topic
            <input
              value={proposal}
              disabled={locked}
              onChange={(e) => {
                setProposal(e.target.value);
                draft({ proposal_area_name: e.target.value });
              }}
            />
          </label>
          <label>
            Community overview
            <textarea
              rows={7}
              value={overview}
              disabled={locked}
              onChange={(e) => {
                setOverview(e.target.value);
                draft({
                  overview: {
                    format: "loom-markdown-v1",
                    text: e.target.value,
                    mentions: [],
                  },
                });
              }}
            />
          </label>
          {setupIntent?.state === "rejected" ? (
            <div className="notice">
              <p>Setup was rejected. Your draft is preserved.</p>
              <button onClick={correct}>Prepare corrected setup</button>
            </div>
          ) : (
            <button
              className="primary"
              disabled={busy || !!setupIntent?.blocked_by}
              onClick={() => void setup()}
            >
              {setupIntent?.state === "uncertain"
                ? "Retry same setup"
                : "Initialize community"}
            </button>
          )}
          {setupIntent?.state === "uncertain" && (
            <button disabled={busy} onClick={() => void setup(true)}>
              Check setup status
            </button>
          )}
        </section>
      ) : (
        <Settings context={{...context,refreshCommunity:refreshCommunityIfCurrent}} />
      )}
      <Admission context={context} />
    </>
  );
}

function Settings({ context }: { context: Context }) {
  const community=useQuery<OnboardingView>('/api/v1/community',Onboarding);
  return <><button onClick={community.refresh}>Refresh configuration</button><ErrorText error={community.error}/>
    {community.data&&<Configuration key={community.generation} context={{...context,community:community.data}}
      onSaved={()=>{community.refreshIfCurrent();context.refreshCommunity();}}/>}</>;
}

function Configuration({ context, onSaved }: { context: Context; onSaved: () => void }) {
  const [overview, setOverview] = useState(
      context.community.overview.resource_id ?? "",
    ),
    [proposal, setProposal] = useState(
      context.community.proposal_area.resource_id ?? "",
    ),
    [error, setError] = useState("");
  async function save() {
    try {
      await commandRequest("/api/v1/community/settings", {
        self: context.self,
        body: {
          idempotency_key: crypto.randomUUID(),
          expected_version: context.community.settings_version,
          community_name: context.community.community_name,
          overview_id: overview || null,
          proposal_area_id: proposal || null,
        },
      });
      onSaved();
    } catch (failure) {
      setError((failure as Error).message);
    }
  }
  return (
    <details className="card admin-card">
      <summary>Community configuration</summary>
      <ErrorText error={error} />
      <label>
        Overview artifact ID
        <input value={overview} onChange={(e) => setOverview(e.target.value)} />
      </label>
      <label>
        Proposal area ID
        <input value={proposal} onChange={(e) => setProposal(e.target.value)} />
      </label>
      <button onClick={() => void save()}>Save configuration</button>
    </details>
  );
}
