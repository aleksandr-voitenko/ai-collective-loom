import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { closed } from '../contracts/participation.js';
import type { UpdatesPageView, UpdatesMembersPageView } from '../contracts/updates.js';
import type { RoutinePageView, RoutineMembersPageView } from '../contracts/routine-updates.js';
import { identityGeneration } from './participation-client.js';
import { verifiedStorageWrite } from './recovery-storage.js';

const Request = Type.Object(
  {
    cursor: Type.String({ minLength: 1, maxLength: 16384 }),
    limit: Type.Integer({ minimum: 1, maximum: 25 }),
    max_response_bytes: Type.Integer({ minimum: 4096, maximum: 131072 }),
  },
  closed,
);
const Record = Type.Object(
  {
    version: Type.Literal(1),
    sequence: Type.Integer({ minimum: 1 }),
    request: Request,
    previous_request: Type.Optional(Request),
    expansion: Type.Optional(Request),
    past: Type.Array(Request, { maxItems: 8 }),
    next_cursor: Type.Union([Type.String({ maxLength: 16384 }), Type.Null()]),
    checkpoint: Type.Union([Type.String({ maxLength: 16384 }), Type.Null()]),
  },
  closed,
);
const Records = Type.Record(Type.String({ maxLength: 1024 }), Record, { maxProperties: 16 });
export type UpdatesSaved = Static<typeof Record>;
export type UpdatesPageRequest = Static<typeof Request>;
export const displayedRequest = (
  page: UpdatesPageView | UpdatesMembersPageView | RoutinePageView | RoutineMembersPageView,
): UpdatesPageRequest => ({
  cursor: page.page_cursor,
  limit: page.limit,
  max_response_bytes: page.max_response_bytes,
});
export class UpdatesRecovery {
  readonly prefix: string;
  private readonly owner = identityGeneration();
  constructor(
    instance: string,
    participant: string,
    private readonly storage: Storage = localStorage,
    routine = false,
  ) {
    this.prefix = `loom.${routine ? 'routine-updates' : 'updates'}-pages:${location.origin}:${instance}:${participant}`;
  }
  private records(): Record<string, UpdatesSaved> {
    const raw = this.storage.getItem(this.prefix);
    if (raw === null) return {};
    try {
      const records: unknown = JSON.parse(raw);
      if (
        new TextEncoder().encode(raw).length > 524288 ||
        !Value.Check(Records, records) ||
        Object.keys(records).length > 16 ||
        Object.values(records).some(
          (r) => new TextEncoder().encode(JSON.stringify(r)).length > 131072,
        )
      )
        throw new Error();
      return records;
    } catch {
      throw new Error(
        'Saved Updates recovery is incompatible. Clear this Updates view explicitly to start retained history again.',
      );
    }
  }
  read(key: string) {
    return this.records()[key];
  }
  async save(
    key: string,
    page: UpdatesPageView | RoutinePageView,
    expected: number,
    active: () => boolean,
    past: UpdatesPageRequest[],
    expansion?: UpdatesPageRequest,
  ) {
    if (!navigator.locks)
      throw new Error('This browser needs Web Locks to retain Updates recovery.');
    return navigator.locks.request(this.prefix, () => {
      if (!active() || this.owner !== identityGeneration())
        throw new DOMException('View changed.', 'AbortError');
      const records = this.records(),
        previous = records[key],
        original = this.storage.getItem(this.prefix);
      if ((previous?.sequence ?? 0) !== expected)
        throw new Error('Another tab changed this Updates view. Reload before continuing.');
      const saved: UpdatesSaved = {
        version: 1,
        sequence: expected + 1,
        request: displayedRequest(page),
        ...(previous ? { previous_request: previous.request } : {}),
        ...(expansion ? { expansion } : {}),
        past: past.slice(-8),
        next_cursor: page.next_cursor,
        checkpoint: page.checkpoint,
      };
      records[key] = saved;
      const raw = JSON.stringify(records);
      if (
        Object.keys(records).length > 16 ||
        new TextEncoder().encode(JSON.stringify(saved)).length > 131072 ||
        new TextEncoder().encode(raw).length > 524288
      )
        throw new Error(
          'Updates recovery is full. Clear an Updates view explicitly; publication drafts and other feeds remain separate.',
        );
      // The written record also retains the previous displayed request if
      // storage refuses restoration; a failed save exposes no successor.
      verifiedStorageWrite({
        storage: this.storage,
        key: this.prefix,
        raw,
        previous: original,
        failureMessage:
          'Updates recovery could not be saved. The successor has not been exposed; retry this page.',
      });
      return saved;
    });
  }
  async clear(active: () => boolean = () => true, key?: string) {
    if (!navigator.locks) throw new Error('Updates recovery cleanup requires Web Locks.');
    await navigator.locks.request(this.prefix, () => {
      if (!active() || this.owner !== identityGeneration())
        throw new DOMException('Identity changed.', 'AbortError');
      if (key) {
        const records = this.records();
        delete records[key];
        this.storage.setItem(this.prefix, JSON.stringify(records));
      } else this.storage.removeItem(this.prefix);
    });
  }
}
