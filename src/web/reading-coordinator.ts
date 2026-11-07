import { readingLimits } from '../contracts/reading.js';

// Presentation qualification happens before this transport buffer. The deadline
// belongs to the oldest candidate, so steady arrivals cannot defer a partial batch.
export const automaticReadingBufferMs = 250;
export const automaticReadingCandidateLimit = readingLimits.localOperations;

export class AutomaticReadingQueue<T extends { id: string }> {
  private readonly candidates = new Map<string, { value: T; added: number }>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private busy = false;
  private closed = false;

  constructor(private readonly dispatch: (batch: T[]) => Promise<void>) {}

  has(id: string) {
    return this.candidates.has(id);
  }
  get size() {
    return this.candidates.size;
  }
  enqueue(value: T): 'added' | 'existing' | 'full' {
    if (this.closed) return 'full';
    if (this.candidates.has(value.id)) return 'existing';
    if (this.candidates.size >= automaticReadingCandidateLimit) return 'full';
    this.candidates.set(value.id, { value, added: Date.now() });
    this.schedule();
    return 'added';
  }
  cancel(id: string) {
    this.candidates.delete(id);
    this.schedule();
  }
  clear() {
    this.candidates.clear();
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
    if (this.busy || !this.candidates.size || this.closed) return;
    const oldest = this.candidates.values().next().value!;
    const delay =
      this.candidates.size >= readingLimits.batch
        ? 0
        : Math.max(0, oldest.added + automaticReadingBufferMs - Date.now());
    this.timer = setTimeout(() => void this.drain(), delay);
  }
  private async drain() {
    this.timer = undefined;
    if (this.busy || this.closed || !this.candidates.size) return;
    this.busy = true;
    const batch = [...this.candidates.values()].slice(0, readingLimits.batch).map((v) => v.value);
    for (const candidate of batch) this.candidates.delete(candidate.id);
    try {
      await this.dispatch(batch);
    } finally {
      this.busy = false;
      this.schedule();
    }
  }
}
