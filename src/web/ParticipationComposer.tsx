import { useEffect, useRef } from 'react';
import {
  PublicationConfirmation,
  SubmissionRecovery,
  SubmissionCorrection,
} from './ComposerFeedback.js';
import { usePublicationComposer, type ComposerOptions } from './usePublicationComposer.js';
import { MentionEditor } from './MentionEditor.js';
import { EditingIntent } from './EditingIntent.js';
import { FileEditor } from './Files.js';
import { Page, type PageView } from '../contracts/participation.js';
import { useQuery, SeparateDraft } from './participation-state.js';
import { AuthoredText } from './AuthoredText.js';
import { ChangeNoteEditor, ChangeAccountEditor } from './Changes.js';
import { ReferenceEditor } from './References.js';
import { CoverageEditor } from './Summaries.js';
import { Collection, ErrorText, Icon } from './participation-ui.js';

export function Composer(props: ComposerOptions) {
  const { context, heading, onClose } = props;
  const {
    reviewSeparate,
    changeTitle,
    removeMention,
    pickMention,
    changeFiles,
    changeReferences,
    checkRecovery,
    retryComparison,
    resolveMentionNames,
    togglePicker,
    selectText,
    changeNote,
    changeAccount,
    changeCoverage,
    previewContent,
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
  } = usePublicationComposer(props);
  return (
    <section
      ref={section}
      className={record?.state === 'committed' ? 'composer composer-confirmed' : 'composer card'}
      aria-label={heading}
    >
      {record?.state !== 'committed' && <h2>{heading}</h2>}
      {(kind === 'revision.publish' || kind === 'summary.revise') &&
        typeof fixed.resource_id === 'string' &&
        typeof base === 'string' && (
          <EditingIntent
            context={context}
            resource={fixed.resource_id}
            base={base}
            canEdit={true}
          />
        )}
      <div ref={feedback} tabIndex={-1}>
        <ErrorText error={error} />
      </div>
      <SeparateDraft record={record} review={reviewSeparate} />
      <p
        role="status"
        className={
          record?.state === 'committed'
            ? 'composer-status composer-status-confirmed'
            : 'composer-status'
        }
      >
        {record?.state === 'committed' ? 'Publication confirmed.' : status}
      </p>
      {record?.state === 'committed' ? (
        <PublicationConfirmation
          kind={kind}
          result={record.result!}
          status={status}
          busy={busy}
          onStartNextRevision={
            ['summary.revise', 'revision.publish'].includes(kind)
              ? () => void startNextRevision()
              : undefined
          }
          onWriteAnother={
            !summaryDiscussion && kind !== 'revision.publish' && kind !== 'reply.create'
              ? writeAnother
              : undefined
          }
          onClose={onClose}
        />
      ) : (
        <>
          {busy && <p role="status">Waiting for confirmation…</p>}
          {record?.state === 'uncertain' && !busy && (
            <SubmissionRecovery
              kind={kind}
              attemptKey={record.key}
              parentId={fixed.parent_id}
              recoveryRef={recovery}
              onCheck={() => {
                checkRecovery();
              }}
              onRetry={() => void send()}
            />
          )}
          {titleField && (
            <label>
              Title
              <input
                ref={titleInput}
                value={title}
                maxLength={160}
                disabled={locked}
                onChange={(event) => changeTitle(event.target.value)}
              />
            </label>
          )}
          <label>
            {kind === 'reply.create' ? 'Your reply' : 'Text'}
            <MentionEditor
              label={kind === 'reply.create' ? 'Your reply' : 'Text'}
              inputRef={textArea}
              value={{ text, mentions }}
              names={mentionNames}
              disabled={locked}
              onChange={editText}
              onSelection={(value) => {
                selectText(value);
              }}
            />
          </label>
          {!locked && mentions.some((mention) => !mentionNames[mention.participant_id]) && (
            <MentionNameLookup onNames={resolveMentionNames} />
          )}
          {mentions.length > 0 && (
            <div className="mention-chips">
              <span className="fineprint">
                {mentions.length} explicit participant{' '}
                {mentions.length === 1 ? 'mention' : 'mentions'}.
              </span>
              {!locked &&
                mentions.map((mention) => (
                  <button
                    key={mention.token}
                    title={mention.participant_id}
                    onClick={() => removeMention(mention.token)}
                  >
                    Remove mention{' '}
                    {mentionNames[mention.participant_id]
                      ? '@' + mentionNames[mention.participant_id]
                      : '@participant'}
                  </button>
                ))}
            </div>
          )}
          {!locked && (
            <>
              <div className="composer-tools">
                <button className="text-button" aria-expanded={picker} onClick={togglePicker}>
                  <Icon name="mention" /> Mention a participant
                </button>
                <details className="formatting-help">
                  <summary>Formatting help</summary>
                  <p>Use Markdown in your text. Open Preview to check the result.</p>
                  <ul>
                    <li>
                      <code>**bold**</code> and <code>*italic*</code>
                    </li>
                    <li>
                      <code>[label](https://example.org)</code> for a link
                    </li>
                    <li>
                      <code>`code`</code> or a block between lines of <code>```</code>
                    </li>
                    <li>
                      Start a line with <code>&gt; </code> for a quote or <code>- </code> for a
                      list.
                    </li>
                  </ul>
                  <p>
                    Plain @names do not notify anyone. Use “Mention a participant” to select a
                    recipient. Attachments are added separately below.
                  </p>
                </details>
              </div>
              {picker && (
                <Collection
                  path="/api/v1/participants"
                  render={(item) => {
                    const person = item as { id: string; nickname: string };
                    return (
                      <button className="list-row" onClick={() => pickMention(person)}>
                        @{person.nickname}
                      </button>
                    );
                  }}
                />
              )}
            </>
          )}
          {canFiles && (
            <details className="composer-options" open={!!fileSet?.files.length || filesPending}>
              <summary>
                Attachments{fileSet?.files.length ? ` (${fileSet.files.length})` : ''}
              </summary>
              <FileEditor
                context={context}
                target={{
                  kind:
                    kind === 'artifact.create'
                      ? 'area'
                      : kind === 'discussion.create'
                        ? 'opening'
                        : kind === 'reply.create'
                          ? 'reply'
                          : canNote
                            ? 'artifact'
                            : 'contribution',
                  resource_id: String(fixed.resource_id ?? fixed.parent_id ?? fixed.area_id),
                }}
                value={fileSet}
                disabled={locked}
                onPending={setFilesPending}
                onChange={changeFiles}
              />
            </details>
          )}
          <details className="composer-options" open={references.length > 0 || !!note || !!account}>
            <summary>
              References & change details
              {references.length ? ` (${references.length} references)` : ''}
            </summary>
            <ReferenceEditor
              references={references}
              disabled={locked}
              onChange={changeReferences}
            />
            {canNote ? (
              <ChangeNoteEditor value={note} disabled={locked} onChange={changeNote} />
            ) : (
              <ChangeAccountEditor
                value={account}
                source={typeof fixed.resource_id === 'string' ? fixed.resource_id : undefined}
                base={typeof base === 'string' ? base : undefined}
                disabled={locked}
                onChange={changeAccount}
              />
            )}
          </details>
          {summaryDiscussion && (
            <CoverageEditor
              context={context}
              discussion={summaryDiscussion}
              resource={typeof fixed.resource_id === 'string' ? fixed.resource_id : undefined}
              base={typeof base === 'string' ? base : undefined}
              value={coverage}
              disabled={locked}
              onChange={changeCoverage}
            />
          )}
          {record?.state === 'rejected' && (
            <SubmissionCorrection
              compare={compare}
              correction={correction}
              comparisonError={comparisonError}
              summaryDiscussion={summaryDiscussion}
              busy={busy}
              onRetryComparison={retryComparison}
              onCorrect={correct}
            />
          )}
          <p role="status" className="fineprint draft-save-status">
            {saveState}
          </p>
          <div className="composer-actions">
            {(!record || record.state === 'draft') && (
              <button
                className="primary"
                disabled={
                  locked ||
                  references.length > 16 ||
                  filesPending ||
                  (!text.trim() && (!canNote || !fileSet?.files.length)) ||
                  (titleField && !title.trim()) ||
                  (!!summaryDiscussion && !coverage) ||
                  (!!account &&
                    ('revisions' in account
                      ? account.revisions.length === 0
                      : account.carry_forward_revision_id !== base)) ||
                  (!!note && !note.text.trim())
                }
                onClick={() => void send()}
              >
                {busy ? 'Publishing…' : kind === 'reply.create' ? 'Post reply' : 'Publish'}
              </button>
            )}
            {onClose && (
              <button disabled={busy || closing} onClick={() => void closeComposer()}>
                {closing ? 'Saving draft…' : 'Close composer'}
              </button>
            )}
          </div>
          <details>
            <summary>Preview</summary>
            <AuthoredText
              content={previewContent()}
              participants={Object.entries(mentionNames).map(([id, nickname]) => ({
                id,
                nickname,
              }))}
            />
          </details>
        </>
      )}
    </section>
  );
}

function MentionNameLookup({ onNames }: { onNames: (names: Record<string, string>) => void }) {
  const { data, error, refresh } = useQuery<PageView>('/api/v1/participants', Page);
  const callback = useRef(onNames);
  callback.current = onNames;
  useEffect(() => {
    if (data)
      callback.current(
        Object.fromEntries(
          data.items.map((item) => {
            const person = item as { id: string; nickname: string };
            return [person.id, person.nickname];
          }),
        ),
      );
  }, [data]);
  return error ? <button onClick={refresh}>Retry mention names</button> : null;
}
