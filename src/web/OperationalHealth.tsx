import { useState } from 'react';
import {
  OperationalHealth as HealthSchema,
  type OperationalHealthView,
  type OperationalFailuresView,
  type OutcomePageView,
} from '../contracts/operations.js';
import { useQuery, type Context } from './participation-state.js';
import {
  useBoundedAdministrationPage,
  AdministrationPageControls,
} from './AdministrationBrowsing.js';
import { ErrorText } from './participation-ui.js';

const readable = (text: string) => text.replaceAll('_', ' ');
function Worker({
  value,
}: {
  value: NonNullable<OperationalHealthView['authored']['value']>['worker'];
}) {
  return (
    <p>
      Worker observation: <strong>{readable(value.state)}</strong>. Last heartbeat:{' '}
      {value.heartbeat_at ?? 'never observed'}; recent window {value.threshold_seconds} seconds. A
      heartbeat does not establish coverage.
    </p>
  );
}
function Failures({
  subject,
  context,
}: {
  subject: 'authored' | 'files' | 'activity';
  context: Context;
}) {
  const page = useBoundedAdministrationPage<OperationalFailuresView>(
    '/api/v1/admin/operational-health/' + subject + '/failures',
    context.self,
  );
  return (
    <>
      <AdministrationPageControls page={page} name={subject + ' failures'} />
      {page.error && page.data && <p>Previous job page is stale; retry preserves its position.</p>}
      <p>
        Live job traversal, 25 jobs per page. Refresh after processing or recovery changes; an empty
        page does not establish discovery coverage.
      </p>
      {page.data?.items.map((row) => (
        <p key={row.id}>
          {readable(row.code)} · <code>{row.id}</code>
        </p>
      ))}
    </>
  );
}
function FailureDetails({
  subject,
  context,
}: {
  subject: 'authored' | 'files' | 'activity';
  context: Context;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Inspect {subject} failures</summary>
      {open && <Failures subject={subject} context={context} />}
    </details>
  );
}
function Outcomes({ context }: { context: Context }) {
  const page = useBoundedAdministrationPage<OutcomePageView>(
    '/api/v1/admin/operational-health/outcomes',
    context.self,
  );
  return (
    <section aria-label="Observed request outcomes">
      <h3>Observed request outcomes</h3>
      <p>
        Publication conflicts, permission denials, upload refusals and activity recovery. Samples
        count request attempts, not distinct incidents or committed operations. Expected conflicts,
        descriptor expiry and visibility replay are separate from history gaps. No observation
        settles a lost response.
      </p>
      <AdministrationPageControls page={page} name="outcomes" />
      {page.error && page.data && (
        <p>Previous outcomes page is stale; retry preserves its position.</p>
      )}
      {page.data && (
        <>
          <p>
            Incomplete sample · observed {page.data.observed_at}. Window starts{' '}
            {page.data.window_start}; oldest retained sample{' '}
            {page.data.oldest_retained_at ?? 'none observed'}. At most {page.data.max_records}{' '}
            samples; concurrent expiry or replacement can remove earlier samples.
          </p>
          <p>
            This API process dropped {page.data.process_dropped} observations. Collection failure
            observed: {page.data.process_collection_failed ? 'yes' : 'none in this process'}. Other
            processes and earlier releases may have unobserved losses.
          </p>
          {page.data.items.map((row) => (
            <article className="list-row" key={row.position}>
              <div>
                <strong>{readable(row.code)}</strong>
                <p>
                  {readable(row.family)} · HTTP {row.status} · {row.observed_at}
                </p>
                <details>
                  <summary>Correlation details</summary>
                  <code>{row.request_id}</code>
                </details>
              </div>
            </article>
          ))}
        </>
      )}
    </section>
  );
}
function Health({ context }: { context: Context }) {
  const health = useQuery<OperationalHealthView>('/api/v1/admin/operational-health', HealthSchema);
  const [outcomes, setOutcomes] = useState(false);
  const data = health.data;
  return (
    <>
      <button onClick={health.refresh}>Refresh operational health</button>
      <ErrorText error={health.error} />
      <p>
        Read-only observations. API/database readiness is checked separately at /health/ready.
        Storage reachability and exact original versions are unverified by this view. Refresh
        explicitly; no automatic polling.
      </p>
      {data && (
        <>
          <section aria-label="Upload health">
            <h3>Uploads</h3>
            <p>
              {readable(data.uploads.state)} · {data.uploads.observed_at}
            </p>
            {data.uploads.value && (
              <p>
                {data.uploads.value.unfinished_uploads} unfinished uploads ·{' '}
                {data.uploads.value.quarantined_uploads} quarantined uploads ·{' '}
                {data.uploads.value.expired_reserved_uploads} expired unassociated uploads (still
                reserved) · {data.uploads.value.retained_uploads} retained identities ·{' '}
                {data.uploads.value.reserved_bytes} reserved bytes (staging plus final). Expiry does
                not release capacity.
              </p>
            )}
          </section>
          <section aria-label="Authored indexing health">
            <h3>Authored indexing</h3>
            <p>
              {readable(data.authored.state)} · {data.authored.observed_at}
            </p>
            {data.authored.value && (
              <>
                <Worker value={data.authored.value.worker} />
                <p>
                  Discovery scan complete: {String(data.authored.value.health.scan_complete)};
                  events caught up: {String(data.authored.value.health.event_discovery_caught_up)};
                  capacity limited: {String(data.authored.value.health.capacity_limited)}.
                </p>
                <p>
                  Current supported coverage: {readable(data.authored.value.coverage.coverage)}.
                  Direct publication retrieval remains independent.
                </p>
                <p>
                  {Object.entries(data.authored.value.health.jobs)
                    .map(([state, count]) => `${count} ${state} jobs`)
                    .join(' · ')}
                </p>
              </>
            )}
            <FailureDetails subject="authored" context={context} />
          </section>
          <section aria-label="File indexing health">
            <h3>File indexing</h3>
            <p>
              {readable(data.files.state)} · {data.files.observed_at}
            </p>
            {data.files.value && (
              <>
                <Worker value={data.files.value.worker} />
                <p>
                  Undiscovered contexts: {String(data.files.value.discovery_missing)}; capacity
                  limited: {String(data.files.value.capacity_limited)}. Coverage:{' '}
                  {readable(data.files.value.coverage.coverage)}; supported UTF-8 prefixes only.
                </p>
                <p>
                  {Object.entries(data.files.value.jobs)
                    .map(([state, count]) => `${count} ${state} jobs`)
                    .join(' · ')}
                </p>
                <p>
                  {data.files.value.retained_bytes} retained text bytes;{' '}
                  {data.files.value.reserved_bytes} in-flight reserved text bytes. Unsupported
                  formats and declared partial prefixes are supported outcomes.
                </p>
              </>
            )}
            <FailureDetails subject="files" context={context} />
          </section>
          <section aria-label="Activity recovery health">
            <h3>Activity recovery</h3>
            <p>
              {readable(data.activity.state)} · {data.activity.observed_at}
            </p>
            {data.activity.value && (
              <>
                <Worker value={data.activity.value.worker} />
                <p>
                  Discovery scan complete: {String(data.activity.value.health.scan_complete)};
                  events caught up: {String(data.activity.value.health.event_discovery_caught_up)};
                  capacity limited: {String(data.activity.value.health.capacity_limited)}.
                </p>
                <p>
                  {Object.entries(data.activity.value.health.jobs)
                    .map(([state, count]) => `${count} ${state} jobs`)
                    .join(' · ')}{' '}
                  · {data.activity.value.health.historical_eligibility_gaps} historical eligibility
                  gaps.
                </p>
              </>
            )}
            <FailureDetails subject="activity" context={context} />
          </section>
        </>
      )}
      <details onToggle={(event) => setOutcomes(event.currentTarget.open)}>
        <summary>Inspect request outcomes</summary>
        {outcomes && <Outcomes context={context} />}
      </details>
    </>
  );
}
export function OperationalHealth({ context }: { context: Context }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="card admin-card" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Operational health</summary>
      {open && <Health context={context} />}
    </details>
  );
}
