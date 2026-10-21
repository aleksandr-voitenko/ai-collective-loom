import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { closed, UUID } from '../contracts/participation.js';
import {
  NotificationReason,
  type NotificationOptions,
  type NotificationPageView,
} from '../contracts/notifications.js';
import { identityGeneration } from './participation-client.js';

const RecordSchema = Type.Object(
  {
    version: Type.Literal(1),
    sequence: Type.Integer({ minimum: 1 }),
    request: Type.Object(
      {
        reason: NotificationReason,
        cursor: Type.String({ minLength: 1, maxLength: 2048 }),
        limit: Type.Integer({ minimum: 1, maximum: 25 }),
        max_response_bytes: Type.Integer({ minimum: 4096, maximum: 131072 }),
      },
      closed,
    ),
    recent_delivery_ids: Type.Array(UUID, { maxItems: 100, uniqueItems: true }),
  },
  closed,
);
type Record = Static<typeof RecordSchema>;
const reasons = ['all', 'mention', 'reply'] as const;
export class NotificationRecovery {
  readonly prefix: string;
  private readonly owner = identityGeneration();
  constructor(
    instance: string,
    participant: string,
    private readonly storage: Storage = localStorage,
  ) {
    this.prefix = `loom.notifications:${location.origin}:${instance}:${participant}:`;
  }
  read(reason: (typeof reasons)[number]): Record | undefined {
    const raw = this.storage.getItem(this.prefix + reason);
    if (raw === null) return;
    try {
      if (new TextEncoder().encode(raw).length > 32768) throw new Error();
      const record: unknown = JSON.parse(raw);
      if (
        !Value.Check(RecordSchema, record) ||
        record.request.reason !== reason ||
        !record.request.cursor
      )
        throw new Error();
      return record;
    } catch {
      throw new Error(
        'Saved notification recovery is incompatible. Start a new retained view explicitly; no checkpoint has advanced.',
      );
    }
  }
  async save(
    reason: (typeof reasons)[number],
    page: NotificationPageView,
    expected: number,
    active: () => boolean,
  ) {
    if (!navigator.locks)
      throw new Error('This browser needs Web Locks to retain notification recovery safely.');
    return navigator.locks.request(this.prefix + reason, () => {
      if (!active() || this.owner !== identityGeneration())
        throw new DOMException('View changed.', 'AbortError');
      const previous = this.read(reason);
      if ((previous?.sequence ?? 0) !== expected)
        throw new Error(
          'Another tab changed notification recovery. Reload this view before continuing.',
        );
      const record: Record = {
        version: 1,
        sequence: expected + 1,
        request: {
          reason,
          cursor: page.page_cursor,
          limit: page.limit,
          max_response_bytes: page.max_response_bytes,
        },
        recent_delivery_ids: [
          ...new Set([
            ...(previous?.recent_delivery_ids ?? []),
            ...page.items.map((i) => i.delivery_id),
          ]),
        ].slice(-100),
      };
      const text = JSON.stringify(record);
      if (new TextEncoder().encode(text).length > 32768)
        throw new Error('Notification recovery reached its local storage bound.');
      this.storage.setItem(this.prefix + reason, text);
      if (this.storage.getItem(this.prefix + reason) !== text)
        throw new Error(
          'Notification recovery could not be verified. Retry this page before continuing.',
        );
      return record;
    });
  }
  async clear() {
    if (!navigator.locks) throw new Error('Notification recovery cleanup requires Web Locks.');
    for (const reason of reasons)
      await navigator.locks.request(this.prefix + reason, () => {
        if (this.owner !== identityGeneration())
          throw new DOMException('Identity changed.', 'AbortError');
        this.storage.removeItem(this.prefix + reason);
      });
  }
  async restart(reason: (typeof reasons)[number], active: () => boolean) {
    if (!navigator.locks) throw new Error('Notification recovery requires Web Locks.');
    await navigator.locks.request(this.prefix + reason, () => {
      if (!active() || this.owner !== identityGeneration())
        throw new DOMException('View changed.', 'AbortError');
      this.storage.removeItem(this.prefix + reason);
    });
  }
}
export function recoveryToken(options: NotificationOptions) {
  return options.cursor ?? options.checkpoint ?? options.recovery?.token;
}
