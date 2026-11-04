import { useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react';
import { useLocation } from 'react-router';
import { type PublicationFileSet, normalizeFileSet } from '../contracts/files.js';
import {
  type AuthoredContent,
  type CommittedView,
  type RevisionView,
  Revision,
  Committed,
} from '../contracts/participation.js';
import { parseAuthored, validateChangeFields } from '../contracts/authored.js';
import {
  identityGeneration,
  type Intent,
  commandRequest,
  isDefinitiveRejection,
  ApiError,
} from './participation-client.js';
import { type Context, useIntent } from './participation-state.js';
import type {
  ReferenceValue,
  ChangeAccountValue,
  NoteContent,
  ExactChangeTargetValue,
} from '../contracts/participation.js';
import { useAuthorization } from './AuthorizationBoundary.js';
import type { CoverageDeclarationValue } from '../contracts/summaries.js';
import { mentionPresentation, insertMention } from './composer-mentions.js';
import {
  composerOperation,
  buildDraftBody,
  draftCorrection,
  correctDraft,
  type ComposerOperation,
  type DraftFields,
  type DraftPatch,
} from './composer-draft.js';

export type ComposerOptions = {
  context: Context;
  operation: ComposerOperation;
  slot: string;
  initialText?: string;
  initialTitle?: string;
  initialMentions?: AuthoredContent['mentions'];
  initialFormat?: AuthoredContent['format'];
  initialReferences?: ReferenceValue[];
  initialChangeAccount?: ChangeAccountValue | null;
  initialFileSet?: PublicationFileSet | undefined;
  initialCoverage?: CoverageDeclarationValue | undefined;
  heading: string;
  onCommitted?: (value: CommittedView) => void;
  focusOnOpen?: boolean;
  onClose?: () => void;
};

// Keep draft custody, request settlement and focus ownership in the same mounted lifetime.
export function usePublicationComposer({
  context,
  operation,
  slot,
  initialText = '',
  initialTitle = '',
  initialMentions = [],
  initialFormat = 'loom-markdown-v1',
  initialReferences = [],
  initialChangeAccount = null,
  initialFileSet,
  initialCoverage,
  onCommitted,
  focusOnOpen = false,
  onClose,
}: ComposerOptions) {
  const { kind } = operation;
  const { path, fixed, titleField, canFiles, canNote, summaryDiscussion } =
    composerOperation(operation);
  const authority = useAuthorization();
  const location = useLocation();
  const chosen = new URLSearchParams(location.search).get('intent');
  const [record, update] = useIntent(() =>
    context.store
      .all()
      .find((value) =>
        chosen
          ? value.key === chosen &&
            value.kind === kind &&
            value.path === path &&
            (['area_id', 'resource_id', 'discussion_id', 'parent_id'] as const).every(
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
    [references, setReferences] = useState(
      original
        ? original.format !== 'loom-markdown-v1'
          ? original.references
          : []
        : initialReferences,
    );
  const [note, setNote] = useState<NoteContent | null>(
    record ? ((record.body.change_note as NoteContent | null | undefined) ?? null) : null,
  );
  const [account, setAccount] = useState<ChangeAccountValue | null>(
    record
      ? ((record.body.change_account as ChangeAccountValue | null | undefined) ?? null)
      : initialChangeAccount,
  );
  const [fileSet, setFileSet] = useState<PublicationFileSet | undefined>(
    record
      ? ((record.body.file_set ?? record.body.attachment_set) as PublicationFileSet | undefined)
      : initialFileSet,
  );
  const [filesPending, setFilesPending] = useState(false);
  const [base, setBase] = useState<unknown>(
    record?.body.expected_revision_id ?? fixed.expected_revision_id,
  );
  const [coverage, setCoverage] = useState<CoverageDeclarationValue | undefined>(
    record ? (record.body.coverage as CoverageDeclarationValue | undefined) : initialCoverage,
  );
  const saveSequence = useRef(0);
  const [saveState, setSaveState] = useState(
    record?.state === 'draft' ? 'Saved on this device' : '',
  );
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [closing, setClosing] = useState(false),
    [status, setStatus] = useState(''),
    [compare, setCompare] = useState<RevisionView>(),
    [comparisonError, setComparisonError] = useState(''),
    [comparisonAttempt, setComparisonAttempt] = useState(0),
    [picker, setPicker] = useState(false);
  const live = useRef(true),
    section = useRef<HTMLElement>(null),
    titleInput = useRef<HTMLInputElement>(null),
    textArea = useRef<HTMLTextAreaElement>(null),
    selection = useRef<{ start: number; end: number } | undefined>(undefined),
    pendingCaret = useRef<number | undefined>(undefined),
    feedbackTrigger = useRef<Element | null>(null),
    [mentionNames, setMentionNames] = useState<Record<string, string>>({}),
    feedback = useRef<HTMLDivElement>(null),
    recovery = useRef<HTMLDivElement>(null),
    wasBusy = useRef(false),
    revealRecovery = useRef(false);
  useEffect(() => {
    if (focusOnOpen && !locked && authority.active()) {
      (titleInput.current ?? textArea.current)?.focus();
      section.current?.scrollIntoView?.({ block: 'start' });
    }
  }, []);
  useEffect(() => {
    if (
      error &&
      !busy &&
      record?.state !== 'uncertain' &&
      authority.active() &&
      revealRecovery.current
    ) {
      if (
        document.activeElement === document.body ||
        document.activeElement === feedbackTrigger.current
      )
        feedback.current?.focus();
      revealRecovery.current = false;
    }
  }, [error, busy]);
  useLayoutEffect(() => {
    if (pendingCaret.current !== undefined) {
      const caret = mentionPresentation({ text, mentions }, mentionNames).displayOffset(
        pendingCaret.current,
      );
      textArea.current?.setSelectionRange(caret, caret);
      pendingCaret.current = undefined;
    }
  }, [text, mentionNames]);
  useEffect(() => {
    const completed = wasBusy.current && !busy;
    wasBusy.current = busy;
    if (!completed) return;
    const reveal = revealRecovery.current;
    revealRecovery.current = false;
    if (!reveal || record?.state !== 'uncertain' || !authority.active()) return;
    // A removed submit/status button leaves focus on the body. Reveal its
    // recovery, but do not pull focus back from another task or a restored draft.
    if (
      document.activeElement === document.body ||
      recovery.current?.contains(document.activeElement)
    )
      recovery.current?.focus();
  }, [busy, record?.state]);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const locked = busy || closing || (!!record && (record.state !== 'draft' || !!record.blocked_by));
  const fields: DraftFields = {
    text,
    title,
    mentions,
    format,
    references,
    base,
    coverage,
    note,
    account,
    fileSet,
  };
  const correction = draftCorrection({ operation, record, comparison: compare });
  const { comparisonRevision, comparisonReady, requiresComparison } = correction;
  useEffect(() => {
    setCompare(undefined);
    setComparisonError('');
    if (
      record?.state !== 'rejected' ||
      !comparisonRevision ||
      typeof fixed.resource_id !== 'string'
    )
      return;
    let active = true;
    const owner = identityGeneration(),
      controller = new AbortController();
    void authority
      .read<RevisionView>(
        `/api/v1/resources/${fixed.resource_id}/revisions/${comparisonRevision}`,
        { schema: Revision, signal: controller.signal },
      )
      .then((value) => {
        if (active && owner === identityGeneration()) setCompare(value);
      })
      .catch((failure) => {
        if (active && owner === identityGeneration() && failure.name !== 'AbortError')
          setComparisonError(
            'The comparison revision could not be loaded. Your draft is preserved.',
          );
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
    const sequence = ++saveSequence.current;
    const owner = identityGeneration();
    const current = () =>
      live.current && owner === identityGeneration() && sequence === saveSequence.current;
    setSaveState('Saving…');
    try {
      const body = draftBody(patch);
      const next = await update((current) =>
        context.store.saveDraft(current ?? context.store.create(slot, kind, path, body), body),
      );
      if (current()) {
        setError('');
        setSaveState('Saved on this device');
      }
      return next;
    } catch (failure) {
      if (current()) {
        setError((failure as Error).message);
        setSaveState('Couldn’t save on this device');
      }
      return undefined;
    }
  }
  async function confirm(found: CommittedView, intent: Intent) {
    await update(async (current) => {
      const next = await context.store.settle(intent, {
        state: 'committed',
        result: found,
      });
      return current?.key === intent.key ? next : current;
    });
    if (live.current) {
      setStatus(kind === 'reply.create' ? 'Your reply was posted.' : 'Your publication is saved.');
      onCommitted?.(found);
    }
  }
  async function send() {
    if (busy || record?.blocked_by) return;
    revealRecovery.current = true;
    feedbackTrigger.current = document.activeElement;
    setBusy(true);
    setError('');
    let intent: Intent | undefined,
      wasUncertain = false;
    try {
      intent = await update(async (current) => {
        wasUncertain = current?.state === 'uncertain';
        const body = draftBody();
        const draft = current ?? context.store.create(slot, kind, path, body);
        if (!wasUncertain && fileSet) normalizeFileSet(fileSet);
        parseAuthored((wasUncertain ? draft.body.content : body.content) as AuthoredContent);
        validateChangeFields(
          (wasUncertain ? draft.body.content : body.content) as AuthoredContent,
          (wasUncertain ? draft.body : body) as {
            change_note?: NoteContent | null;
            change_account?: ChangeAccountValue | null;
          },
        );
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
          state: 'rejected' as const,
          ...((failure as ApiError).code === 'file_reference_format_required'
            ? { required_format: 'loom-markdown-v4' as const }
            : {}),
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
          (failure as Error).name === 'AbortError'
            ? 'Account changed. The original submission remains unresolved.'
            : (failure as Error).message,
        );
    } finally {
      if (live.current) setBusy(false);
    }
  }
  const check = useCallback(async () => {
    if (!record || busy || record.state !== 'uncertain') return;
    const owner = identityGeneration();
    setBusy(true);
    setError('');
    try {
      const result = await commandRequest<CommittedView | { operation_state: string }>(
        summaryDiscussion ? '/api/v1/summaries/status' : '/api/v1/operations/status',
        {
          self: context.self,
          body: { operation_kind: record.kind, idempotency_key: record.key },
        },
      );
      if ('publication_state' in result) await confirm(result, record);
      else if (live.current)
        setStatus('Confirmation is still unavailable. The original request may still commit.');
    } catch (failure) {
      if (isDefinitiveRejection(failure, true)) {
        try {
          await update(() => context.store.settle(record, { state: 'rejected' }));
        } catch {
          /* Keep the exact uncertain record if local settlement failed. */
        }
      }
      if (live.current && owner === identityGeneration()) setError((failure as Error).message);
    } finally {
      if (live.current && owner === identityGeneration()) setBusy(false);
    }
  }, [record, busy]);
  useEffect(() => {
    const online = () => void check();
    window.addEventListener('online', online);
    return () => window.removeEventListener('online', online);
  }, [check]);
  async function correct() {
    if (!record || record.state !== 'rejected' || busy || (requiresComparison && !comparisonReady))
      return;
    const owner = identityGeneration();
    setBusy(true);
    try {
      const corrected = correctDraft({ operation, fields, record, comparison: compare });
      if (!corrected) return;
      await update((current) => context.store.correct(current!, corrected.body));
      if (live.current && owner === identityGeneration()) {
        if (comparisonRevision) setBase(corrected.fields.base);
        if (summaryDiscussion) setCoverage(undefined);
        setFormat(corrected.fields.format);
        setAccount(corrected.fields.account);
        setFileSet(corrected.fields.fileSet);
        setReferences(corrected.fields.references);
        setCompare(undefined);
        setError('');
      }
    } catch (failure) {
      if (live.current && owner === identityGeneration()) setError((failure as Error).message);
    } finally {
      if (live.current && owner === identityGeneration()) setBusy(false);
    }
  }
  async function startNextRevision() {
    if (
      !['summary.revise', 'revision.publish'].includes(kind) ||
      record?.state !== 'committed' ||
      busy ||
      typeof fixed.resource_id !== 'string'
    )
      return;
    const owner = identityGeneration();
    setBusy(true);
    setError('');
    try {
      const latest = await authority.read<RevisionView>(`/api/v1/resources/${fixed.resource_id}`, {
        schema: Revision,
      });
      if (!live.current || owner !== identityGeneration()) return;
      if (!latest.can_edit) throw new Error('This resource is no longer available for editing.');
      // The explicit new draft uses current authored content and carries only its
      // existing declaration. Saving must succeed before retiring the old request.
      await update((current) =>
        context.store.replace(current!, {
          resource_id: latest.resource_id,
          expected_revision_id: latest.revision_id,
          title: latest.title,
          content: latest.content,
          ...(latest.file_set
            ? { file_set: { version: latest.file_set.version, files: latest.file_set.files } }
            : {}),
          ...(latest.attachment_set
            ? {
                attachment_set: {
                  version: latest.attachment_set.version,
                  files: latest.attachment_set.files,
                },
              }
            : {}),
          ...(latest.kind === 'summary'
            ? { coverage: { carry_forward_revision_id: latest.revision_id } }
            : {}),
          ...(['loom-markdown-v3', 'loom-markdown-v4'].includes(latest.content.format)
            ? {
                change_note: null,
                change_account:
                  latest.change_account?.state === 'declared'
                    ? { carry_forward_revision_id: latest.revision_id }
                    : null,
              }
            : {}),
        }),
      );
    } catch (failure) {
      if (live.current && owner === identityGeneration()) setError((failure as Error).message);
    } finally {
      if (live.current && owner === identityGeneration()) setBusy(false);
    }
  }
  function editText(value: { text: string; mentions: AuthoredContent['mentions'] }) {
    if (locked) return;
    setText(value.text);
    setMentions(value.mentions);
    if (record?.state !== 'rejected') void persist(value);
    else setSaveState('Unsaved correction — prepare a corrected submission to keep it');
  }
  async function closeComposer() {
    if (busy || closing) return;
    feedbackTrigger.current = document.activeElement;
    revealRecovery.current = true;
    setClosing(true);
    try {
      if (!locked && (record || text || title || fileSet?.files.length)) {
        const saved = await persist();
        if (!saved) return;
      }
      if (live.current && authority.active()) onClose?.();
    } finally {
      if (live.current) setClosing(false);
    }
  }
  const declareCoverage = useRef<(next: CoverageDeclarationValue) => Promise<boolean>>(
    async () => false,
  );
  // Attach a delayed preparation only to the latest draft, not the click's text.
  declareCoverage.current = async (next) => {
    const saved = await persist({ coverage: next });
    if (saved && live.current) setCoverage(next);
    return !!saved;
  };
  const changeActions = useRef<
    (
      nextNote: NoteContent | null,
      nextAccount: ChangeAccountValue | null,
      target?: ExactChangeTargetValue,
    ) => void
  >(() => {});
  changeActions.current = (nextNote, nextAccount, target) => {
    if (locked || !live.current) return;
    const nextReferences =
      target &&
      !references.some(
        (r) =>
          r.target.resource_id === target.resource_id &&
          r.target.revision_id === target.revision_id &&
          !r.target.file_id,
      )
        ? [
            ...references,
            { reference_id: crypto.randomUUID(), target, relationship: null, rationale: null },
          ]
        : references;
    setFormat(
      format === 'loom-markdown-v4' || nextNote?.format === 'loom-markdown-v4'
        ? 'loom-markdown-v4'
        : 'loom-markdown-v3',
    );
    setNote(nextNote);
    setAccount(nextAccount);
    setReferences(nextReferences);
    void persist({ references: nextReferences, note: nextNote, account: nextAccount });
  };
  function writeAnother() {
    void update((current) =>
      context.store.replace(
        current!,
        draftBody({
          text: '',
          title: '',
          mentions: [],
          references: [],
          note: null,
          account: null,
          ...(canFiles
            ? {
                fileSet: {
                  version: canNote ? 'artifact-files-v1' : 'contribution-attachments-v1',
                  files: [],
                },
              }
            : {}),
        }),
      ),
    ).catch((failure) => setError(failure.message));
  }
  function reviewSeparate() {
    void update(async (current) => {
      const { blocked_by: _, ...next } = current!;
      return context.store.save(next);
    }).catch((failure) => setError(failure.message));
  }
  function changeTitle(value: string) {
    setTitle(value);
    if (record?.state !== 'rejected') void persist({ title: value });
  }
  function removeMention(token: string) {
    const next = mentions.filter((m) => m.token !== token),
      value = text.replaceAll(`[[mention:${token}]]`, '');
    setMentions(next);
    setText(value);
    if (record?.state !== 'rejected') void persist({ text: value, mentions: next });
  }
  function pickMention(person: { id: string; nickname: string }) {
    try {
      const token = 'm' + crypto.randomUUID().replaceAll('-', '').slice(0, 12);
      const mention = { token, participant_id: person.id };
      const inserted = insertMention(
        draftBody().content as AuthoredContent,
        mention,
        selection.current ?? { start: text.length, end: text.length },
      );
      const next = [...mentions, mention];
      setMentions(next);
      setMentionNames((names) => ({ ...names, [person.id]: person.nickname }));
      setText(inserted.text);
      pendingCaret.current = inserted.caret;
      void persist({ text: inserted.text, mentions: next });
      setStatus(
        inserted.separateParagraph
          ? 'Mention added in a new paragraph outside quoted or code text.'
          : 'Mention added.',
      );
      setPicker(false);
      textArea.current?.focus();
      selection.current = { start: inserted.caret, end: inserted.caret };
    } catch (failure) {
      setError((failure as Error).message);
      feedback.current?.focus();
    }
  }
  async function changeFiles(next: PublicationFileSet) {
    const saved = await persist({ fileSet: next });
    if (saved && live.current) setFileSet(next);
    return !!saved;
  }
  function changeReferences(next: ReferenceValue[]) {
    setReferences(next);
    if (next.some((ref) => ref.target.file_id)) setFormat('loom-markdown-v4');
    else if (!['loom-markdown-v3', 'loom-markdown-v4'].includes(format))
      setFormat('loom-markdown-v2');
    void persist({ references: next });
  }
  return {
    reviewSeparate,
    changeTitle,
    removeMention,
    pickMention,
    changeFiles,
    changeReferences,
    checkRecovery: () => {
      revealRecovery.current = true;
      void check();
    },
    retryComparison: () => setComparisonAttempt((value) => value + 1),
    resolveMentionNames: (names: Record<string, string>) =>
      setMentionNames((current) => ({ ...current, ...names })),
    togglePicker: () => setPicker((value) => !value),
    selectText: (value: { start: number; end: number }) => {
      selection.current = value;
    },
    changeNote: (next: NoteContent | null) => changeActions.current(next, account),
    changeAccount: (next: ChangeAccountValue | null, target?: ExactChangeTargetValue) =>
      changeActions.current(note, next, target),
    changeCoverage: (next: CoverageDeclarationValue) => declareCoverage.current(next),
    previewContent: () => draftBody().content as AuthoredContent,
    kind,
    fixed,
    titleField,
    canFiles,
    canNote,
    summaryDiscussion,
    record,
    text,
    title,
    mentions,
    references,
    note,
    account,
    fileSet,
    filesPending,
    setFilesPending,
    base,
    coverage,
    saveState,
    error,
    busy,
    closing,
    status,
    compare,
    comparisonError,
    picker,
    section,
    titleInput,
    textArea,
    mentionNames,
    feedback,
    recovery,
    locked,
    correction,
    send,
    correct,
    startNextRevision,
    editText,
    closeComposer,
    writeAnother,
  };
}
