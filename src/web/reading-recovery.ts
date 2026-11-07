import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { closed, UUID } from '../contracts/participation.js';
import {
  ReadingUpdate,
  ReadingVersion,
  readingLimits,
  type ReadingResultView,
  type ReadingUpdateInput,
} from '../contracts/reading.js';
import { identityGeneration } from './participation-client.js';
import { BoundedRecoveryRecords } from './recovery-storage.js';

const RecordSchema = Type.Object(
  {
    version: Type.Literal(1),
    body: ReadingUpdate,
    attempts: Type.Integer({ minimum: 0 }),
    state: Type.Union([
      Type.Literal('uncertain'),
      Type.Literal('rejected'),
      Type.Literal('conflicted'),
    ]),
    superseded_revisions: Type.Optional(Type.Array(UUID, { maxItems: readingLimits.batch })),
    conflict_versions: Type.Optional(
      Type.Array(Type.Object({ revision_id: UUID, version: ReadingVersion }, closed), {
        maxItems: readingLimits.batch,
      }),
    ),
    successful_versions: Type.Optional(
      Type.Array(Type.Object({ revision_id: UUID, version: ReadingVersion }, closed), {
        maxItems: readingLimits.batch,
      }),
    ),
  },
  closed,
);
export type ReadingIntent = Static<typeof RecordSchema>;
const SuccessSchema = Type.Object(
  {
    version: Type.Literal(1),
    state: Type.Literal('acknowledged'),
    idempotency_key: UUID,
    targets: Type.Array(
      Type.Object({ resource_id: UUID, revision_id: UUID, version: ReadingVersion }, closed),
      { minItems: 1, maxItems: readingLimits.batch },
    ),
  },
  closed,
);
type SuccessEvidence = Static<typeof SuccessSchema>;
type StoredReading = ReadingIntent | SuccessEvidence;
const isIntent = (record: StoredReading): record is ReadingIntent =>
  record.state !== 'acknowledged';
const sameTarget = (
  left: { resource_id: string; revision_id: string },
  right: { resource_id: string; revision_id: string },
) => left.resource_id === right.resource_id && left.revision_id === right.revision_id;
export function exportReadingRecovery(instance: string, participant: string) {
  const journal = new ReadingRecovery(instance, participant);
  const blob = new Blob(
    [
      JSON.stringify(
        {
          origin: location.origin,
          instance_id: instance,
          participant_id: participant,
          intents: journal.all(),
          success_evidence: journal.successEvidence(),
        },
        null,
        2,
      ),
    ],
    { type: 'application/json' },
  );
  const url = URL.createObjectURL(blob),
    link = document.createElement('a');
  link.href = url;
  link.download = 'loom-reading-recovery.json';
  link.click();
  URL.revokeObjectURL(url);
}
export class ReadingRecovery {
  readonly prefix: string;
  readonly preference: string;
  private readonly owner = identityGeneration();
  private readonly records: BoundedRecoveryRecords<StoredReading>;
  constructor(
    instance: string,
    participant: string,
    private readonly storage: Storage = localStorage,
  ) {
    this.prefix = `loom.reading:${location.origin}:${instance}:${participant}:`;
    this.preference = this.prefix + 'automatic';
    this.records = new BoundedRecoveryRecords({
      storage,
      prefix: this.prefix + 'intent:',
      limits: readingLimits,
      validate: (record): record is StoredReading =>
        Value.Check(RecordSchema, record) || Value.Check(SuccessSchema, record),
      id: (record) => (isIntent(record) ? record.body.idempotency_key : record.idempotency_key),
      messages: {
        exceeds: 'Reading recovery exceeds its synthetic limit. Preserve it before continuing.',
        unreadable: 'Reading recovery is unreadable. Preserve it before continuing.',
        incompatible: 'Reading recovery is incompatible. Preserve it before continuing.',
        full: 'Reading recovery is full. Resolve existing changes before creating more.',
      },
    });
  }
  all(): ReadingIntent[] {
    const stored = this.records.all();
    const evidence = stored.filter((record): record is SuccessEvidence => !isIntent(record));
    return stored.filter(isIntent).map((record) => {
      if (record.state !== 'conflicted' || !record.conflict_versions) return record;
      const superseded = new Set(record.superseded_revisions ?? []);
      for (const refused of record.conflict_versions) {
        const member = record.body.targets.find(
          (target) => target.revision_id === refused.revision_id,
        );
        if (
          member &&
          (record.successful_versions?.some(
            (success) =>
              success.revision_id === refused.revision_id && success.version > refused.version,
          ) ||
            evidence.some((receipt) =>
              receipt.targets.some(
                (target) => sameTarget(target, member) && target.version > refused.version,
              ),
            ))
        )
          superseded.add(refused.revision_id);
      }
      return superseded.size ? { ...record, superseded_revisions: [...superseded] } : record;
    });
  }
  successEvidence(): SuccessEvidence[] {
    return this.records.all().filter((record): record is SuccessEvidence => !isIntent(record));
  }
  private storedRecord(raw: string | null): StoredReading | undefined {
    if (!raw) return undefined;
    try {
      const record: unknown = JSON.parse(raw);
      if (Value.Check(RecordSchema, record) || Value.Check(SuccessSchema, record)) return record;
      return undefined;
    } catch {
      return undefined;
    }
  }
  storedIntent(raw: string | null): ReadingIntent | undefined {
    const record = this.storedRecord(raw);
    return record && isIntent(record) ? record : undefined;
  }
  storedTargets(raw: string | null) {
    const record = this.storedRecord(raw);
    return record ? (isIntent(record) ? record.body.targets : record.targets) : undefined;
  }
  enabled() {
    return this.storage.getItem(this.preference) === 'true';
  }
  private async locked<T>(work: () => T) {
    if (!navigator.locks)
      throw new Error('Reading changes require Web Locks to protect recovery across tabs.');
    return navigator.locks.request(this.prefix, async () => {
      if (this.owner !== identityGeneration())
        throw new DOMException('Identity changed.', 'AbortError');
      return work();
    });
  }
  private changed() {
    window.dispatchEvent(new Event('loom-reading'));
  }
  private write<T extends StoredReading>(record: T): T {
    this.records.write(
      record,
      record.state === 'conflicted'
        ? 'Reading conflict could not be saved. The exact change remains in recovery; check its outcome again.'
        : record.state === 'acknowledged'
          ? 'Reading success evidence could not be saved. The exact change remains in recovery; check its outcome again.'
          : 'Reading intent could not be saved. No new request was sent.',
    );
    this.changed();
    return record;
  }
  save(body: ReadingUpdateInput, active: () => boolean) {
    return this.savePrepared(() => body, active);
  }
  savePrepared(prepare: () => ReadingUpdateInput | undefined, active: () => boolean) {
    return this.locked(() => {
      if (!active()) throw new DOMException('View changed.', 'AbortError');
      const body = prepare();
      if (!body) throw new DOMException('Reading observation changed.', 'AbortError');
      if (
        this.records
          .all()
          .some((record) =>
            isIntent(record)
              ? record.body.idempotency_key === body.idempotency_key
              : record.idempotency_key === body.idempotency_key,
          )
      )
        throw new Error('Reading operation already exists. Recover its exact request.');
      this.compactCoveredLegacySuccesses();
      // An older client may have filled the shared slot limit with receipts that
      // are no longer needed; free only proven obsolete evidence before admission.
      this.pruneEvidence();
      return this.write({ version: 1, body, attempts: 0, state: 'uncertain' });
    });
  }
  begin(record: ReadingIntent) {
    return this.locked(() => {
      const current = this.records
        .all()
        .filter(isIntent)
        .find((r) => r.body.idempotency_key === record.body.idempotency_key);
      if (
        !current ||
        current.state !== 'uncertain' ||
        JSON.stringify(current.body) !== JSON.stringify(record.body)
      )
        throw new Error('Reading intent changed. Refresh recovery.');
      return this.write({ ...current, attempts: current.attempts + 1 });
    });
  }
  rejectFirst(record: ReadingIntent) {
    return this.locked(() => {
      const current = this.records
        .all()
        .filter(isIntent)
        .find((r) => r.body.idempotency_key === record.body.idempotency_key);
      if (current?.state === 'uncertain' && current.attempts === 1 && record.attempts === 1)
        this.write({ ...current, state: 'rejected' });
    });
  }
  recordConflict(record: ReadingIntent, result?: ReadingResultView) {
    return this.locked(() => {
      const current = this.records
        .all()
        .filter(isIntent)
        .find((r) => r.body.idempotency_key === record.body.idempotency_key);
      if (!current) return;
      if (JSON.stringify(current.body) !== JSON.stringify(record.body))
        throw new Error('Reading intent changed. Refresh recovery.');
      // Keep exact, bounded feedback until explicitly dismissed. A late duplicate
      // response must not recreate a notice another tab has already dismissed.
      if (current.state === 'uncertain') {
        this.compactCoveredLegacySuccesses();
        const compacted = this.records
          .all()
          .filter(isIntent)
          .find((item) => item.body.idempotency_key === record.body.idempotency_key)!;
        const conflicts = result?.outcome.targets.map((target) => ({
          revision_id: target.revision_id,
          version: target.result_version,
        }));
        this.write({
          ...compacted,
          state: 'conflicted',
          ...(conflicts ? { conflict_versions: conflicts } : {}),
        });
      }
    });
  }
  settleSuccess(record: ReadingIntent, targets: ReadingResultView['outcome']['targets']) {
    return this.locked(() => {
      const stored = this.records.all();
      const current = stored
        .filter(isIntent)
        .find((item) => item.body.idempotency_key === record.body.idempotency_key);
      if (!current) {
        this.compactCoveredLegacySuccesses();
        this.pruneEvidence();
        return;
      }
      if (JSON.stringify(current.body) !== JSON.stringify(record.body))
        throw new Error('Reading intent changed. Refresh recovery.');
      const others = stored
        .filter(isIntent)
        .filter((item) => item.body.idempotency_key !== record.body.idempotency_key);
      const relevant = targets.filter(
        (target) =>
          current.body.targets.some((member) => sameTarget(member, target)) &&
          others.some((item) => item.body.targets.some((member) => sameTarget(member, target))),
      );
      if (relevant.length)
        // Replace the acknowledged operation's existing slot, never expand every
        // overlapping unresolved request near the journal's byte limit.
        this.write({
          version: 1,
          state: 'acknowledged',
          idempotency_key: record.body.idempotency_key,
          targets: relevant.map((target) => ({
            resource_id: target.resource_id,
            revision_id: target.revision_id,
            version: target.result_version,
          })),
        });
      else {
        this.storage.removeItem(this.prefix + 'intent:' + record.body.idempotency_key);
        this.changed();
      }
      this.compactCoveredLegacySuccesses();
      this.pruneEvidence();
    });
  }
  private compactCoveredLegacySuccesses() {
    const stored = this.records.all();
    const evidence = stored.filter((item): item is SuccessEvidence => !isIntent(item));
    for (const intent of stored.filter(isIntent)) {
      if (!intent.successful_versions?.length) continue;
      const remaining = intent.successful_versions.filter((success) => {
        const target = intent.body.targets.find((item) => item.revision_id === success.revision_id);
        return (
          !target ||
          !evidence.some((receipt) =>
            receipt.targets.some(
              (item) => sameTarget(item, target) && item.version >= success.version,
            ),
          )
        );
      });
      if (remaining.length === intent.successful_versions.length) continue;
      const compacted = { ...intent };
      if (remaining.length) compacted.successful_versions = remaining;
      else delete compacted.successful_versions;
      this.records.write(
        compacted,
        'Reading acknowledgement compaction could not be saved. Check the retained outcome again.',
      );
      this.changed();
    }
  }
  private pruneEvidence() {
    const stored = this.records.all();
    const intents = stored.filter(isIntent);
    const evidence = stored.filter((item): item is SuccessEvidence => !isIntent(item));
    const needed = new Set(
      intents.flatMap((intent) =>
        intent.body.targets.map((target) => `${target.resource_id}:${target.revision_id}`),
      ),
    );
    const newest = new Map<string, { version: number; receipt: string }>();
    for (const receipt of evidence)
      for (const target of receipt.targets) {
        const key = `${target.resource_id}:${target.revision_id}`;
        if (!needed.has(key)) continue;
        const prior = newest.get(key);
        if (
          !prior ||
          target.version > prior.version ||
          (target.version === prior.version && receipt.idempotency_key < prior.receipt)
        )
          newest.set(key, { version: target.version, receipt: receipt.idempotency_key });
      }
    const retained = new Set([...newest.values()].map((item) => item.receipt));
    for (const receipt of evidence)
      if (!retained.has(receipt.idempotency_key))
        this.storage.removeItem(this.prefix + 'intent:' + receipt.idempotency_key);
  }
  finish(record: ReadingIntent, resolvedOnly = false) {
    return this.locked(() => {
      const current = this.records
        .all()
        .filter(isIntent)
        .find((r) => r.body.idempotency_key === record.body.idempotency_key);
      if (!current) return;
      if (
        JSON.stringify(current.body) !== JSON.stringify(record.body) ||
        (resolvedOnly && current.state === 'uncertain')
      )
        throw new Error('Reading intent changed. Refresh recovery.');
      this.storage.removeItem(this.prefix + 'intent:' + record.body.idempotency_key);
      this.changed();
      this.pruneEvidence();
    });
  }
  setEnabled(enabled: boolean) {
    return this.locked(() => {
      this.storage.setItem(this.preference, String(enabled));
      this.changed();
    });
  }
  clear() {
    return this.locked(() => {
      for (const record of this.records.all())
        this.storage.removeItem(
          this.prefix +
            'intent:' +
            (isIntent(record) ? record.body.idempotency_key : record.idempotency_key),
        );
      this.storage.removeItem(this.preference);
      this.changed();
    });
  }
}
