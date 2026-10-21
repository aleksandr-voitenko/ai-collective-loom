import { FileEditor } from "./Files.js";
import { type FileSetValue, normalizeFileSet } from "../contracts/files.js";
import { useState, useRef, useEffect, useCallback } from "react";
import { useLocation, Link } from "react-router";
import { type AuthoredContent, type CommittedView, type RevisionView, Revision, Committed } from "../contracts/participation.js";
import { parseAuthored, validateChangeFields } from "../contracts/authored.js";
import { identityGeneration, type Intent, commandRequest, isDefinitiveRejection, ApiError } from "./participation-client.js";
import { type Context, useIntent, SeparateDraft } from "./participation-state.js";
import { AuthoredText } from "./AuthoredText.js";
import { ChangeNoteEditor, ChangeAccountEditor } from "./Changes.js";
import { ReferenceEditor, ReferenceViews } from "./References.js";
import type { ReferenceValue, ChangeAccountValue, NoteContent, ExactChangeTargetValue } from "../contracts/participation.js";
import { useAuthorization } from './AuthorizationBoundary.js';
import { CoverageEditor } from './Summaries.js';
import type { CoverageDeclarationValue } from '../contracts/summaries.js';
import { Collection, ErrorText } from "./participation-ui.js";
import { composerOperation, buildDraftBody, draftCorrection, correctDraft, type ComposerOperation, type DraftFields, type DraftPatch } from "./composer-draft.js";

export function Composer({
  context,
  operation,
  slot,
  initialText = "",
  initialTitle = "",
  initialMentions = [],
  initialFormat = "loom-markdown-v1",
  initialReferences = [],
  initialChangeAccount = null,
  initialFileSet,
  initialCoverage,
  heading,
  onCommitted,
}: {
  context: Context;
  operation: ComposerOperation;
  slot: string;
  initialText?: string;
  initialTitle?: string;
  initialMentions?: AuthoredContent["mentions"];
  initialFormat?: AuthoredContent["format"];
  initialReferences?: ReferenceValue[];
  initialChangeAccount?: ChangeAccountValue | null;
  initialFileSet?:FileSetValue|undefined;
  initialCoverage?: CoverageDeclarationValue | undefined;
  heading: string;
  onCommitted?: (value: CommittedView) => void;
}) {
  const { kind } = operation;
  const { path, fixed, titleField, canFiles, canNote, summaryDiscussion } = composerOperation(operation);
  const authority=useAuthorization();
  const location = useLocation();
  const chosen = new URLSearchParams(location.search).get("intent");
  const [record, update] = useIntent(() =>
    context.store
      .all()
      .find((value) =>
        chosen
          ? value.key === chosen &&
            value.kind === kind &&
            value.path === path &&
            (["area_id", "resource_id", "discussion_id", "parent_id"] as const).every(
              (key) => !(key in fixed) || value.body[key] === fixed[key],
            )
          : value.slot === slot,
      ),
  );
  const original = record?.body.content as AuthoredContent | undefined;
  const [text, setText] = useState(original?.text ?? initialText),
    [title, setTitle] = useState(String(record?.body.title ?? initialTitle)),
    [mentions, setMentions] = useState(original?.mentions ?? initialMentions);
  const [format, setFormat] = useState(original?.format ?? initialFormat),
    // A retained v1 request has no declarations, even if the fetched current
    // source has since become v2. Never borrow newer fields for its frozen view.
    [references, setReferences] = useState(original ? original.format !== "loom-markdown-v1" ? original.references : [] : initialReferences);
  const [note,setNote] = useState<NoteContent|null>(record ? (record.body.change_note as NoteContent|null|undefined) ?? null : null);
  const [account,setAccount] = useState<ChangeAccountValue|null>(record ? (record.body.change_account as ChangeAccountValue|null|undefined) ?? null : initialChangeAccount);
  const [fileSet,setFileSet]=useState<FileSetValue|undefined>(record?record.body.file_set as FileSetValue|undefined:initialFileSet);
  const [filesPending,setFilesPending]=useState(false);
  const [base, setBase] = useState<unknown>(
    record?.body.expected_revision_id ?? fixed.expected_revision_id,
  );
  const [coverage, setCoverage] = useState<CoverageDeclarationValue | undefined>(record ? record.body.coverage as CoverageDeclarationValue | undefined : initialCoverage);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [status, setStatus] = useState(""),
    [compare, setCompare] = useState<RevisionView>(),
    [comparisonError, setComparisonError] = useState(""),
    [comparisonAttempt, setComparisonAttempt] = useState(0),
    [picker, setPicker] = useState(false);
  const live = useRef(true),
    textArea = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const locked =
    busy || (!!record && (record.state !== "draft" || !!record.blocked_by));
  const fields: DraftFields = { text, title, mentions, format, references, base, coverage, note, account, fileSet };
  const { comparisonRevision, comparisonReady, adoptsBaseReferences, requiresComparison } =
    draftCorrection({ operation, record, comparison: compare });
  useEffect(() => {
    setCompare(undefined);
    setComparisonError("");
    if (record?.state !== "rejected" || !comparisonRevision || typeof fixed.resource_id !== "string") return;
    let active = true;
    const owner = identityGeneration(), controller = new AbortController();
    void authority.read<RevisionView>(
      `/api/v1/resources/${fixed.resource_id}/revisions/${comparisonRevision}`,
      { schema: Revision, signal: controller.signal },
    )
      .then((value) => {
        if (active && owner === identityGeneration()) setCompare(value);
      })
      .catch((failure) => {
        if (active && owner === identityGeneration() && failure.name !== "AbortError")
          setComparisonError("The comparison revision could not be loaded. Your draft is preserved.");
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [record?.state, record?.key, comparisonRevision, fixed.resource_id, comparisonAttempt]);
  function draftBody(patch: DraftPatch = {}) {
    return buildDraftBody({ operation, fields, patch });
  }
  async function persist(patch: DraftPatch = {}) {
    try {
      const body = draftBody(patch);
      const next = await update((current) =>
        context.store.saveDraft(
          current ?? context.store.create(slot, kind, path, body),
          body,
        ),
      );
      if (live.current) {
        setError("");
      }
      return next;
    } catch (failure) {
      setError((failure as Error).message);
      return undefined;
    }
  }
  async function confirm(found: CommittedView, intent: Intent) {
    await update(async (current) => {
      const next = await context.store.settle(intent, {
        state: "committed",
        result: found,
      });
      return current?.key === intent.key ? next : current;
    });
    if (live.current) {
      setStatus(
        kind === "reply.create"
          ? "Your reply was posted."
          : "Your publication is saved.",
      );
      onCommitted?.(found);
    }
  }
  async function send() {
    if (busy || record?.blocked_by) return;
    setBusy(true);
    setError("");
    let intent: Intent | undefined,
      wasUncertain = false;
    try {
      intent = await update(async (current) => {
        wasUncertain = current?.state === "uncertain";
        const body = draftBody();
        const draft = current ?? context.store.create(slot, kind, path, body);
        if(!wasUncertain && fileSet)normalizeFileSet(fileSet);
        parseAuthored(
          (wasUncertain ? draft.body.content : body.content) as AuthoredContent,
        );
        validateChangeFields((wasUncertain ? draft.body.content : body.content) as AuthoredContent,
          (wasUncertain ? draft.body : body) as {change_note?:NoteContent|null;change_account?:ChangeAccountValue|null});
        // Version comparison and the state transition occur under the journal
        // lock. A stale Publish click cannot send a changed or newly keyed body.
        return context.store.prepareDispatch(draft, body);
      });
      if (!intent) return;
      await confirm(
        await commandRequest<CommittedView>(path, {
          self: context.self,
          body: intent.body,
          schema: Committed,
        }),
        intent,
      );
    } catch (failure) {
      const rejected = intent && isDefinitiveRejection(failure, wasUncertain);
      if (rejected && intent) {
        const revision = (failure as ApiError).currentRevision;
        const next = {
          ...intent,
          state: "rejected" as const,
          ...(revision ? { conflict_revision_id: revision } : {}),
        };
        try {
          await update(() => context.store.settle(intent!, next));
        } catch (storageFailure) {
          if (live.current) setError((storageFailure as Error).message);
          return;
        }
      }
      if (live.current)
        setError(
          (failure as Error).name === "AbortError"
            ? "Account changed. The original submission remains unresolved."
            : (failure as Error).message,
        );
    } finally {
      if (live.current) setBusy(false);
    }
  }
  const check = useCallback(async () => {
    if (!record || busy || record.state !== "uncertain") return;
    const owner = identityGeneration();
    setBusy(true);
    setError("");
    try {
      const result = await commandRequest<CommittedView | { operation_state: string }>(
        summaryDiscussion ? "/api/v1/summaries/status" : "/api/v1/operations/status",
        {
          self: context.self,
          body: { operation_kind: record.kind, idempotency_key: record.key },
        },
      );
      if ("publication_state" in result) await confirm(result, record);
      else if (live.current)
        setStatus(
          "Confirmation is still unavailable. The original request may still commit.",
        );
    } catch (failure) {
      if (isDefinitiveRejection(failure, true)) {
        try { await update(() => context.store.settle(record, {state:'rejected'})); }
        catch { /* Keep the exact uncertain record if local settlement failed. */ }
      }
      if (live.current && owner === identityGeneration()) setError((failure as Error).message);
    } finally {
      if (live.current && owner === identityGeneration()) setBusy(false);
    }
  }, [record, busy]);
  useEffect(() => {
    const online = () => void check();
    window.addEventListener("online", online);
    return () => window.removeEventListener("online", online);
  }, [check]);
  async function correct() {
    if (!record || record.state !== "rejected" || busy || (requiresComparison && !comparisonReady)) return;
    const owner = identityGeneration();
    setBusy(true);
    try {
      const corrected = correctDraft({ operation, fields, record, comparison: compare });
      if (!corrected) return;
      await update((current) => context.store.correct(current!, corrected.body));
      if (live.current && owner === identityGeneration()) {
        if (comparisonRevision) setBase(corrected.fields.base);
        if (summaryDiscussion) setCoverage(undefined);
        setFormat(corrected.fields.format); setAccount(corrected.fields.account);setFileSet(corrected.fields.fileSet);
        if (adoptsBaseReferences) setReferences(corrected.fields.references);
        setCompare(undefined);
        setError("");
      }
    } catch (failure) {
      if (live.current && owner === identityGeneration()) setError((failure as Error).message);
    } finally {
      if (live.current && owner === identityGeneration()) setBusy(false);
    }
  }
  async function startNextRevision() {
    if (!['summary.revise','revision.publish'].includes(kind) || record?.state !== 'committed' || busy || typeof fixed.resource_id !== 'string') return;
    const owner = identityGeneration();
    setBusy(true);
    setError('');
    try {
      const latest = await authority.read<RevisionView>(`/api/v1/resources/${fixed.resource_id}`, { schema: Revision });
      if (!live.current || owner !== identityGeneration()) return;
      if (!latest.can_edit) throw new Error('This resource is no longer available for editing.');
      // The explicit new draft uses current authored content and carries only its
      // existing declaration. Saving must succeed before retiring the old request.
      await update(current => context.store.replace(current!, {
        resource_id: latest.resource_id,
        expected_revision_id: latest.revision_id,
        title: latest.title,
        content: latest.content,
        ...(latest.file_set?{file_set:{version:latest.file_set.version,files:latest.file_set.files}}:{}),
        ...(latest.kind === 'summary' ? {coverage: { carry_forward_revision_id: latest.revision_id }} : {}),
        ...(latest.content.format === 'loom-markdown-v3' ? {change_note:null,change_account:latest.change_account?.state === 'declared' ? {carry_forward_revision_id:latest.revision_id}:null} : {}),
      }));
    } catch (failure) {
      if (live.current && owner === identityGeneration()) setError((failure as Error).message);
    } finally {
      if (live.current && owner === identityGeneration()) setBusy(false);
    }
  }
  function editText(value: string) {
    setText(value);
    if (!locked && record?.state !== "rejected")
      persist({ text: value });
  }
  const declareCoverage=useRef<(next:CoverageDeclarationValue)=>Promise<boolean>>(async()=>false);
  // Attach a delayed preparation only to the latest draft, not the click's text.
  declareCoverage.current=async next=>{const saved=await persist({ coverage: next });if(saved&&live.current)setCoverage(next);return !!saved;};
  const changeActions=useRef<(nextNote:NoteContent|null,nextAccount:ChangeAccountValue|null,target?:ExactChangeTargetValue)=>void>(()=>{});
  changeActions.current=(nextNote,nextAccount,target)=>{
    if(locked||!live.current)return;
    const nextReferences=target&&!references.some(r=>r.target.resource_id===target.resource_id&&r.target.revision_id===target.revision_id)
      ? [...references,{reference_id:crypto.randomUUID(),target,relationship:null,rationale:null}] : references;
    setFormat('loom-markdown-v3');setNote(nextNote);setAccount(nextAccount);setReferences(nextReferences);
    void persist({ references: nextReferences, note: nextNote, account: nextAccount });
  };
  return (
    <section className="composer card" aria-label={heading}>
      <h2>{heading}</h2>
      <ErrorText error={error} />
      <SeparateDraft
        record={record}
        review={() =>
          void update(async (current) => {
            const { blocked_by: _, ...next } = current!;
            return context.store.save(next);
          }).catch((failure) => setError(failure.message))
        }
      />
      {status && <p role="status">{status}</p>}
      {record?.state === "committed" ? (
        <div className="notice neutral">
          <p>
            Published.{" "}
            <Link
              to={`/loom/resource/${record.result!.resource_id}/${record.result!.revision_id}`}
            >
              Inspect exact revision
            </Link>
          </p>
          {['summary.revise','revision.publish'].includes(kind) && <>
            <button disabled={busy} onClick={() => void startNextRevision()}>Start another revision</button>
            <p className="fineprint">Start from current content, keep existing declarations, and author a new optional note. The previous note is not copied.</p>
          </>}
          {!summaryDiscussion && kind !== "revision.publish" && <button
            onClick={() =>
              void update((current) =>
                context.store.replace(current!, draftBody({ text: "", title: "", mentions: [], references: [], note: null, account: null,
                  ...(canFiles ? { fileSet: {version:"artifact-files-v1",files:[]} } : {}) })),
              ).catch((failure) => setError(failure.message))
            }
          >
            Write another
          </button>}
        </div>
      ) : (
        <>
          {busy && <p role="status">Waiting for confirmation…</p>}
          {record?.state === "uncertain" && !busy && (
            <div className="notice">
              <strong>
                We couldn’t confirm whether your{" "}
                {kind === "reply.create" ? "reply" : "publication"} was posted.
              </strong>
              <p>Your original text and target are saved on this browser.</p>
              <button onClick={() => void check()}>Check status</button>
              <button onClick={() => void send()}>
                Retry same {kind === "reply.create" ? "reply" : "publication"}
              </button>
              <details>
                <summary>Submission details</summary>
                <code>{record.key}</code>
                <p>
                  {typeof fixed.parent_id === "string"
                    ? "Parent: " + fixed.parent_id
                    : ""}
                </p>
              </details>
            </div>
          )}
          {titleField && (
            <label>
              Title
              <input
                value={title}
                maxLength={160}
                disabled={locked}
                onChange={(event) => {
                  setTitle(event.target.value);
                  if (record?.state !== "rejected")
                    persist({ title: event.target.value });
                }}
              />
            </label>
          )}
          <label>
            {kind === "reply.create" ? "Your reply" : "Text"}
            <textarea
              aria-label={kind === "reply.create" ? "Your reply" : "Text"}
              ref={textArea}
              rows={7}
              value={text}
              disabled={locked}
              onChange={(event) => editText(event.target.value)}
            />
          </label>
          {mentions.length > 0 && (
            <div className="fineprint">
              {mentions.length} explicit participant{" "}
              {mentions.length === 1 ? "mention" : "mentions"}.
              {!locked &&
                mentions.map((mention) => (
                  <button
                    key={mention.token}
                    onClick={() => {
                      const next = mentions.filter(
                          (m) => m.token !== mention.token,
                        ),
                        value = text.replaceAll(
                          `[[mention:${mention.token}]]`,
                          "",
                        );
                      setMentions(next);
                      setText(value);
                      if (record?.state !== "rejected")
                        persist({ text: value, mentions: next });
                    }}
                  >
                    Remove mention {mention.token}
                  </button>
                ))}
            </div>
          )}
          {!locked && (
            <>
              <div className="composer-tools">
                <button
                  className="text-button"
                  onClick={() => setPicker((value) => !value)}
                >
                  ＠ Mention a participant
                </button>
                <span>Markdown supported · text only</span>
              </div>
              {picker && (
                <Collection
                  path="/api/v1/participants"
                  render={(item) => {
                    const person = item as { id: string; nickname: string };
                    return (
                      <button
                        className="list-row"
                        onClick={() => {
                          const token =
                              "m" +
                              crypto
                                .randomUUID()
                                .replaceAll("-", "")
                                .slice(0, 12),
                            next = [
                              ...mentions,
                              { token, participant_id: person.id },
                            ],
                            value = text + ` [[mention:${token}]]`;
                          setMentions(next);
                          setText(value);
                          persist({ text: value, mentions: next });
                          setPicker(false);
                          textArea.current?.focus();
                        }}
                      >
                        @{person.nickname}
                      </button>
                    );
                  }}
                />
              )}
            </>
          )}
          {canFiles&&<FileEditor context={context} target={{kind:kind==='artifact.create'?'area':'artifact',resource_id:String(fixed.resource_id??fixed.area_id)}} value={fileSet} disabled={locked} onPending={setFilesPending} onChange={async next=>{const saved=await persist({ fileSet: next });if(saved&&live.current)setFileSet(next);return !!saved;}}/>}
          <ReferenceEditor references={references} disabled={locked} onChange={next => {
            setReferences(next); if(format !== "loom-markdown-v3") setFormat("loom-markdown-v2");
            void persist({ references: next });
          }}/>
          {canNote ? <ChangeNoteEditor value={note} disabled={locked} onChange={next=>changeActions.current(next,account)}/>
            : <ChangeAccountEditor value={account} source={typeof fixed.resource_id === "string" ? fixed.resource_id : undefined} base={typeof base === "string" ? base : undefined} disabled={locked} onChange={(next,target)=>changeActions.current(note,next,target)}/>}
          {summaryDiscussion && <CoverageEditor context={context} discussion={summaryDiscussion}
            resource={typeof fixed.resource_id === 'string' ? fixed.resource_id : undefined}
            base={typeof base === 'string' ? base : undefined} value={coverage} disabled={locked}
            onChange={next=>declareCoverage.current(next)}/>}
          {record?.state === "rejected" && (
            <div className="notice">
              <strong>Your draft is preserved.</strong>
              {comparisonReady && compare && (
                <>
                  <p>
                    Current revision {compare.revision_number} by{" "}
                    {compare.publisher.nickname}
                  </p>
                  <AuthoredText
                    content={compare.content}
                    participants={compare.mentioned_participants}
                  />
                  <ReferenceViews sourceId={compare.resource_id} sourceRevision={compare.revision_id}
                    target={{ kind: compare.kind === "summary" ? "summary" : compare.kind === "artifact" ? "artifact" : "contribution", resource_id: compare.resource_id, revision_id: compare.revision_id }}/>
                </>
              )}
              <p>
                Review your text and the current version, then prepare a
                corrected submission to unlock editing. Your changes will be
                saved as a new draft.
              </p>
              {requiresComparison && !comparisonReady && !comparisonError && <p role="status">Loading the comparison revision before correction…</p>}
              {comparisonError && <><p role="alert">{comparisonError}</p>
                <button disabled={busy} onClick={() => setComparisonAttempt(value => value + 1)}>Retry comparison revision</button></>}
              {adoptsBaseReferences && compare?.content.format !== "loom-markdown-v1" &&
                <p>The comparison revision’s references will be copied into your corrected draft. Review or remove them before publishing.</p>}
              {summaryDiscussion && <p>A corrected summary draft needs an explicit source declaration. Later material is never added automatically.</p>}
              <button disabled={busy || (requiresComparison && !comparisonReady)} onClick={correct}>Prepare corrected submission</button>
            </div>
          )}
          {(!record || record.state === "draft") && (
            <button
              className="primary"
              disabled={locked || filesPending || (!text.trim() && !fileSet?.files.length) || (titleField && !title.trim()) || (!!summaryDiscussion && !coverage) || (!!account && ("revisions" in account ? account.revisions.length === 0 : account.carry_forward_revision_id !== base)) || (!!note && !note.text.trim())}
              onClick={() => void send()}
            >
              {busy
                ? "Publishing…"
                : kind === "reply.create"
                  ? "Post reply"
                  : "Publish"}
            </button>
          )}
          <details>
            <summary>Preview</summary>
            <AuthoredText
              content={draftBody().content as AuthoredContent}
            />
          </details>
        </>
      )}
    </section>
  );
}
