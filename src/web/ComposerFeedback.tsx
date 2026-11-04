import type { Ref } from 'react';
import { Link } from 'react-router';
import type { CommittedView, RevisionView } from '../contracts/participation.js';
import type { ComposerOperation, draftCorrection } from './composer-draft.js';
import { AuthoredText } from './AuthoredText.js';
import { ReferenceViews } from './References.js';

// The composer owns journal transitions and focus effects. These panels render
// its current observations and invoke explicit actions without adding state or wrappers.
export function PublicationConfirmation({
  kind,
  result,
  status,
  busy,
  onStartNextRevision,
  onWriteAnother,
  onClose,
}: {
  kind: ComposerOperation['kind'];
  result: CommittedView;
  status: string;
  busy: boolean;
  onStartNextRevision: (() => void) | undefined;
  onWriteAnother: (() => void) | undefined;
  onClose: (() => void) | undefined;
}) {
  return (
    <div className="publication-confirmed">
      <p>
        <span>
          {status ||
            (kind === 'reply.create' ? 'Your reply was posted.' : 'Your publication is saved.')}
        </span>{' '}
        <Link to={`/loom/resource/${result.resource_id}/${result.revision_id}`}>
          Inspect exact revision
        </Link>
      </p>
      {onStartNextRevision && (
        <>
          <button disabled={busy} onClick={onStartNextRevision}>
            Start another revision
          </button>
          <p className="fineprint">
            Start from current content, keep existing declarations, and author a new optional note.
            The previous note is not copied.
          </p>
        </>
      )}
      {onClose && <button onClick={onClose}>Close composer</button>}
      {onWriteAnother && <button onClick={onWriteAnother}>Write another</button>}
    </div>
  );
}

export function SubmissionRecovery({
  kind,
  attemptKey,
  parentId,
  recoveryRef,
  onCheck,
  onRetry,
}: {
  kind: ComposerOperation['kind'];
  attemptKey: string;
  parentId: string | undefined;
  recoveryRef: Ref<HTMLDivElement>;
  onCheck: () => void;
  onRetry: () => void;
}) {
  return (
    <div
      className="notice"
      ref={recoveryRef}
      role="group"
      aria-label="Submission recovery"
      tabIndex={-1}
    >
      <strong>
        We couldn’t confirm whether your {kind === 'reply.create' ? 'reply' : 'publication'} was
        posted.
      </strong>
      <p>Your original text and target are saved on this browser.</p>
      <button onClick={onCheck}>Check status</button>
      <button onClick={onRetry}>
        Retry same {kind === 'reply.create' ? 'reply' : 'publication'}
      </button>
      <details>
        <summary>Submission details</summary>
        <code>{attemptKey}</code>
        <p>{typeof parentId === 'string' ? 'Parent: ' + parentId : ''}</p>
      </details>
    </div>
  );
}

export function SubmissionCorrection({
  compare,
  correction,
  comparisonError,
  summaryDiscussion,
  busy,
  onRetryComparison,
  onCorrect,
}: {
  compare: RevisionView | undefined;
  correction: ReturnType<typeof draftCorrection>;
  comparisonError: string;
  summaryDiscussion: string | undefined;
  busy: boolean;
  onRetryComparison: () => void;
  onCorrect: () => void;
}) {
  const { comparisonReady, requiresComparison, adoptsBaseReferences, adoptsFileReferences } =
    correction;
  return (
    <div className="notice">
      <strong>Your draft is preserved.</strong>
      {comparisonReady && compare && (
        <>
          <p>
            Current revision {compare.revision_number} by {compare.publisher.nickname}
          </p>
          <AuthoredText content={compare.content} participants={compare.mentioned_participants} />
          <ReferenceViews
            sourceId={compare.resource_id}
            sourceRevision={compare.revision_id}
            target={{
              kind:
                compare.kind === 'summary'
                  ? 'summary'
                  : compare.kind === 'artifact'
                    ? 'artifact'
                    : 'contribution',
              resource_id: compare.resource_id,
              revision_id: compare.revision_id,
            }}
          />
        </>
      )}
      <p>
        Review your text and the current version, then prepare a corrected submission to unlock
        editing. Your changes will be saved as a new draft.
      </p>
      {requiresComparison && !comparisonReady && !comparisonError && (
        <p role="status">Loading the comparison revision before correction…</p>
      )}
      {comparisonError && (
        <>
          <p role="alert">{comparisonError}</p>
          <button disabled={busy} onClick={onRetryComparison}>
            Retry comparison revision
          </button>
        </>
      )}
      {adoptsBaseReferences && compare?.content.format !== 'loom-markdown-v1' && (
        <p>
          The comparison revision’s references will be copied into your corrected draft. Review or
          remove them before publishing.
        </p>
      )}
      {adoptsFileReferences && (
        <p>
          The comparison revision’s exact file references will also be copied. Your attempted
          references stay in the draft; a conflicting older assertion is copied with a new identity.
          Review the combined list and keep at most 16 before publishing.
        </p>
      )}
      {summaryDiscussion && (
        <p>
          A corrected summary draft needs an explicit source declaration. Later material is never
          added automatically.
        </p>
      )}
      <button disabled={busy || (requiresComparison && !comparisonReady)} onClick={onCorrect}>
        Prepare corrected submission
      </button>
    </div>
  );
}
