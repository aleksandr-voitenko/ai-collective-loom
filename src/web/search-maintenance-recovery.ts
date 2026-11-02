import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { closed, UUID } from '../contracts/participation.js';
import { ApiError, identityGeneration, isDefinitiveRejection } from './participation-client.js';
import { verifiedStorageWrite } from './recovery-storage.js';

const Request = Type.Union([
  Type.Object(
    {
      kind: Type.Literal('rebuild'),
      body: Type.Object({ expected_generation: Type.Integer({ minimum: 1 }) }, closed),
    },
    closed,
  ),
  Type.Object(
    {
      kind: Type.Literal('retry'),
      body: Type.Object({ id: UUID, claim_generation: Type.Integer({ minimum: 0 }) }, closed),
    },
    closed,
  ),
]);
const Record = Type.Object(
  {
    version: Type.Literal(1),
    sequence: Type.Integer({ minimum: 1 }),
    request: Request,
    state: Type.Union(
      ['uncertain', 'acknowledged', 'rejected'].map((value) => Type.Literal(value)),
    ),
  },
  closed,
);
export type SearchMaintenanceRequest = Static<typeof Request>;
export type SearchMaintenanceRecord = Static<typeof Record>;

// One bounded, owner-scoped slot. These endpoints have generation guards, not
// idempotency keys or operation receipts; IntentStore's command schema is unsuitable.
export class SearchMaintenanceRecovery {
  readonly key: string;
  private readonly owner = identityGeneration();
  constructor(
    instance: string,
    participant: string,
    private readonly storage: Storage = localStorage,
  ) {
    this.key = `loom.search-maintenance.v1:${location.origin}:${instance}:${participant}`;
  }
  read(): SearchMaintenanceRecord | undefined {
    const raw = this.storage.getItem(this.key);
    if (raw === null) return;
    try {
      if (new TextEncoder().encode(raw).length > 2048) throw new Error();
      const value: unknown = JSON.parse(raw);
      if (!Value.Check(Record, value)) throw new Error();
      return value;
    } catch {
      throw new Error(
        'Search maintenance recovery is unreadable. No replacement request can be sent.',
      );
    }
  }
  private write(record: SearchMaintenanceRecord) {
    const raw = JSON.stringify(record);
    if (!Value.Check(Record, record) || new TextEncoder().encode(raw).length > 2048)
      throw new Error('Search maintenance recovery exceeds its limit.');
    verifiedStorageWrite({
      storage: this.storage,
      key: this.key,
      raw,
      previous: this.storage.getItem(this.key),
      failureMessage:
        'Search maintenance recovery could not be saved. The request outcome is not confirmed.',
    });
    return record;
  }
  async attempt(
    request: SearchMaintenanceRequest,
    sequence: number,
    active: () => boolean,
    send: () => Promise<void>,
  ) {
    if (!navigator.locks) throw new Error('This browser needs Web Locks for maintenance recovery.');
    // Serialize the bounded transport as well as custody so two tabs cannot dispatch
    // the same pending request concurrently. No observations are held by this lock.
    return navigator.locks.request(this.key, async () => {
      const current = () => this.owner === identityGeneration() && active();
      if (!current()) throw new DOMException('View changed.', 'AbortError');
      const prior = this.read();
      if ((prior?.sequence ?? 0) !== sequence)
        throw new Error(
          'Another tab changed maintenance recovery. Review the retained request before continuing.',
        );
      const uncertain = prior?.state === 'uncertain';
      if (uncertain && JSON.stringify(request) !== JSON.stringify(prior.request))
        throw new Error('The original maintenance request must be resolved first.');
      let record = this.write({ version: 1, sequence: sequence + 1, request, state: 'uncertain' });
      try {
        await send();
        if (!current()) throw new DOMException('View changed.', 'AbortError');
        record = this.write({ ...record, state: 'acknowledged' });
        return { record };
      } catch (error) {
        if (!current()) throw new DOMException('View changed.', 'AbortError');
        // A later generation conflict cannot establish an earlier request's outcome.
        const rejected =
          !uncertain &&
          (isDefinitiveRejection(error, false) ||
            (error instanceof ApiError &&
              error.code === 'search_changed' &&
              error.operationOutcome !== 'unknown'));
        if (rejected) record = this.write({ ...record, state: 'rejected' });
        return { record, error };
      }
    });
  }
  async clear() {
    if (!navigator.locks) throw new Error('Search maintenance cleanup requires Web Locks.');
    await navigator.locks.request(this.key, () => {
      if (this.owner !== identityGeneration())
        throw new DOMException('Identity changed.', 'AbortError');
      this.storage.removeItem(this.key);
      if (this.storage.getItem(this.key) !== null)
        throw new Error('Search maintenance recovery could not be cleared.');
    });
  }
}
