import { readingLimits } from '../contracts/reading.js';

// Presentation qualification happens before this transport buffer. The deadline
// belongs to the oldest candidate, so steady arrivals cannot defer a partial batch.
export const automaticReadingBufferMs = 250;
export const automaticReadingCandidateLimit = readingLimits.localOperations;

export class AutomaticReadingQueue<T extends { id: string }> {
  private readonly candidates = new Map<string, { value: T; added: number }>();
  // A refused batch can return at most one bounded subset. Reserve that next
  // dispatch outside the fresh-candidate buffer so its capacity cannot hide it.
  private continuation: T[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private busy = false;
  private closed = false;

  constructor(private readonly dispatch: (batch: T[]) => Promise<T[] | void>) {}

  has(id: string) {
    return this.candidates.has(id) || this.continuation.some((candidate) => candidate.id === id);
  }
  get size() {
    return this.candidates.size + this.continuation.length;
  }
  enqueue(value: T): 'added' | 'existing' | 'full' {
    if (this.closed) return 'full';
    if (this.has(value.id)) return 'existing';
    if (this.candidates.size >= automaticReadingCandidateLimit) return 'full';
    this.candidates.set(value.id, { value, added: Date.now() });
    this.schedule();
    return 'added';
  }
  cancel(id: string) {
    this.candidates.delete(id);
    this.continuation = this.continuation.filter((candidate) => candidate.id !== id);
    this.schedule();
  }
  clear() {
    this.candidates.clear();
    this.continuation = [];
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
  close() {
    this.closed = true;
    this.clear();
  }
  open() {
    this.closed = false;
    this.schedule();
  }
  private schedule() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.busy || (!this.candidates.size && !this.continuation.length) || this.closed) return;
    const delay =
      this.continuation.length || this.candidates.size >= readingLimits.batch
        ? 0
        : Math.max(
            0,
            this.candidates.values().next().value!.added + automaticReadingBufferMs - Date.now(),
          );
    this.timer = setTimeout(() => void this.drain(), delay);
  }
  private async drain() {
    this.timer = undefined;
    if (this.busy || this.closed || (!this.candidates.size && !this.continuation.length)) return;
    this.busy = true;
    const following = this.continuation.length > 0;
    const batch = following
      ? this.continuation.splice(0)
      : [...this.candidates.values()].slice(0, readingLimits.batch).map((v) => v.value);
    if (!following) for (const candidate of batch) this.candidates.delete(candidate.id);
    try {
      const next = await this.dispatch(batch);
      if (next?.length && !this.closed) {
        if (following || next.length > readingLimits.batch)
          throw new Error('Automatic reading continuation exceeds its single bounded dispatch.');
        this.continuation = [
          ...new Map(next.map((candidate) => [candidate.id, candidate])).values(),
        ];
      }
    } finally {
      this.busy = false;
      this.schedule();
    }
  }
}
