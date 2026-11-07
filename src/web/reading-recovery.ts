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
  private readonly records: BoundedRecoveryRecords<ReadingIntent>;
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
      validate: (record): record is ReadingIntent => Value.Check(RecordSchema, record),
      id: (record) => record.body.idempotency_key,
      messages: {
        exceeds: 'Reading recovery exceeds its synthetic limit. Preserve it before continuing.',
        unreadable: 'Reading recovery is unreadable. Preserve it before continuing.',
        incompatible: 'Reading recovery is incompatible. Preserve it before continuing.',
        full: 'Reading recovery is full. Resolve existing changes before creating more.',
      },
    });
  }
  all(): ReadingIntent[] {
    return this.records.all();
  }
  storedIntent(raw: string | null): ReadingIntent | undefined {
    if (!raw) return undefined;
    try {
      const record: unknown = JSON.parse(raw);
      return Value.Check(RecordSchema, record) ? record : undefined;
    } catch {
      return undefined;
    }
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
  private write(record: ReadingIntent) {
    this.records.write(
      record,
      record.state === 'conflicted'
        ? 'Reading conflict could not be saved. The exact change remains in recovery; check its outcome again.'
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
      if (this.all().some((r) => r.body.idempotency_key === body.idempotency_key))
        throw new Error('Reading operation already exists. Recover its exact request.');
      return this.write({ version: 1, body, attempts: 0, state: 'uncertain' });
    });
  }
  begin(record: ReadingIntent) {
    return this.locked(() => {
      const current = this.all().find(
        (r) => r.body.idempotency_key === record.body.idempotency_key,
      );
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
      const current = this.all().find(
        (r) => r.body.idempotency_key === record.body.idempotency_key,
      );
      if (current?.state === 'uncertain' && current.attempts === 1 && record.attempts === 1)
        this.write({ ...current, state: 'rejected' });
    });
  }
  recordConflict(record: ReadingIntent, result?: ReadingResultView) {
    return this.locked(() => {
      const current = this.all().find(
        (r) => r.body.idempotency_key === record.body.idempotency_key,
      );
      if (!current) return;
      if (JSON.stringify(current.body) !== JSON.stringify(record.body))
        throw new Error('Reading intent changed. Refresh recovery.');
      // Keep exact, bounded feedback until explicitly dismissed. A late duplicate
      // response must not recreate a notice another tab has already dismissed.
      if (current.state === 'uncertain') {
        const conflicts = result?.outcome.targets.map((target) => ({
          revision_id: target.revision_id,
          version: target.result_version,
        }));
        const superseded = new Set(current.superseded_revisions ?? []);
        for (const conflict of conflicts ?? [])
          if (
            current.successful_versions?.some(
              (success) =>
                success.revision_id === conflict.revision_id && success.version > conflict.version,
            )
          )
            superseded.add(conflict.revision_id);
        this.write({
          ...current,
          state: 'conflicted',
          ...(conflicts ? { conflict_versions: conflicts } : {}),
          ...(superseded.size ? { superseded_revisions: [...superseded] } : {}),
        });
      }
    });
  }
  supersedeConflicts(targets: ReadingResultView['outcome']['targets'], operationKey?: string) {
    return this.locked(() => {
      for (const record of this.all()) {
        if (record.body.idempotency_key === operationKey) continue;
        const successes = new Map(
          record.successful_versions?.map((item) => [item.revision_id, item.version]) ?? [],
        );
        const superseded = new Set(record.superseded_revisions ?? []);
        for (const target of targets) {
          if (
            !record.body.targets.some(
              (member) =>
                member.revision_id === target.revision_id &&
                member.resource_id === target.resource_id,
            )
          )
            continue;
          const seen = successes.get(target.revision_id);
          if (seen === undefined || target.result_version > seen)
            successes.set(target.revision_id, target.result_version);
          const refused = record.conflict_versions?.find(
            (item) => item.revision_id === target.revision_id,
          );
          if (record.state === 'conflicted' && refused && target.result_version > refused.version)
            superseded.add(target.revision_id);
        }
        if (
          successes.size !== (record.successful_versions?.length ?? 0) ||
          [...successes].some(
            ([id, version]) =>
              record.successful_versions?.find((item) => item.revision_id === id)?.version !==
              version,
          ) ||
          superseded.size !== (record.superseded_revisions?.length ?? 0)
        )
          this.write({
            ...record,
            successful_versions: [...successes].map(([revision_id, version]) => ({
              revision_id,
              version,
            })),
            ...(superseded.size ? { superseded_revisions: [...superseded] } : {}),
          });
      }
    });
  }
  finish(record: ReadingIntent, resolvedOnly = false) {
    return this.locked(() => {
      const current = this.all().find(
        (r) => r.body.idempotency_key === record.body.idempotency_key,
      );
      if (!current) return;
      if (
        JSON.stringify(current.body) !== JSON.stringify(record.body) ||
        (resolvedOnly && current.state === 'uncertain')
      )
        throw new Error('Reading intent changed. Refresh recovery.');
      this.storage.removeItem(this.prefix + 'intent:' + record.body.idempotency_key);
      this.changed();
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
      for (const record of this.all())
        this.storage.removeItem(this.prefix + 'intent:' + record.body.idempotency_key);
      this.storage.removeItem(this.preference);
      this.changed();
    });
  }
}
