import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { closed } from '../contracts/participation.js';
import { ReadingUpdate, readingLimits, type ReadingUpdateInput } from '../contracts/reading.js';
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
    return this.locked(() => {
      if (!active()) throw new DOMException('View changed.', 'AbortError');
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
  recordConflict(record: ReadingIntent) {
    return this.locked(() => {
      const current = this.all().find(
        (r) => r.body.idempotency_key === record.body.idempotency_key,
      );
      if (!current) return;
      if (JSON.stringify(current.body) !== JSON.stringify(record.body))
        throw new Error('Reading intent changed. Refresh recovery.');
      // Keep exact, bounded feedback until explicitly dismissed. A late duplicate
      // response must not recreate a notice another tab has already dismissed.
      if (current.state === 'uncertain') this.write({ ...current, state: 'conflicted' });
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
