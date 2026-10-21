const bytes = (value: string) => new TextEncoder().encode(value).length;

export function verifiedStorageWrite({
  storage,
  key,
  raw,
  previous,
  failureMessage,
}: {
  storage: Storage;
  key: string;
  raw: string;
  previous: string | null;
  failureMessage: string;
}): void {
  try {
    storage.setItem(key, raw);
    if (storage.getItem(key) !== raw) throw new Error();
  } catch {
    // Restore the exact previous encoding, not a reserialized record. Storage
    // can refuse rollback too; callers must still treat custody as failed.
    try {
      if (previous === null) storage.removeItem(key);
      else storage.setItem(key, previous);
    } catch {
      /* Preserve the adapter's custody failure when rollback also fails. */
    }
    throw new Error(failureMessage);
  }
}

type RecordStorageOptions<T> = {
  storage: Storage;
  prefix: string;
  validate(value: unknown): value is T;
  id(record: T): string;
  limits: { requestBytes: number; localBytes: number; localOperations: number };
  messages: { exceeds: string; unreadable: string; incompatible: string; full: string };
};

// This owns only bounded storage mechanics. Each adapter owns its lock, schema,
// command transitions and successful-write notification.
export class BoundedRecoveryRecords<T> {
  constructor(private readonly options: RecordStorageOptions<T>) {}

  all(): T[] {
    const { storage, prefix, limits, messages, validate, id } = this.options;
    const result: T[] = [];
    let total = 0;
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (!key?.startsWith(prefix)) continue;
      const raw = storage.getItem(key)!;
      total += bytes(raw);
      if (
        bytes(raw) > limits.requestBytes ||
        total > limits.localBytes ||
        result.length >= limits.localOperations
      )
        throw new Error(messages.exceeds);
      let record: unknown;
      try {
        record = JSON.parse(raw);
      } catch {
        throw new Error(messages.unreadable);
      }
      if (!validate(record) || key !== prefix + id(record)) throw new Error(messages.incompatible);
      result.push(record);
    }
    return result;
  }

  write(record: T, failureMessage: string): T {
    const { storage, prefix, limits, messages, validate, id } = this.options;
    const key = prefix + id(record),
      raw = JSON.stringify(record),
      previous = storage.getItem(key);
    const others = this.all().filter((other) => id(other) !== id(record));
    // Reads account for stored bytes above; replacement capacity retains the
    // journals' existing accounting of reserialized other records.
    if (
      !validate(record) ||
      bytes(raw) > limits.requestBytes ||
      others.length >= limits.localOperations ||
      others.reduce((total, other) => total + bytes(JSON.stringify(other)), bytes(raw)) >
        limits.localBytes
    )
      throw new Error(messages.full);
    verifiedStorageWrite({ storage, key, raw, previous, failureMessage });
    return record;
  }
}
