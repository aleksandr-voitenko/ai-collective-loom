import type { PreviewItemView } from '../contracts/private-controls.js';

export type ContentSnapshot = {
  generation: number;
  state: 'absent' | 'checking' | 'authorized' | 'withdrawn' | 'owner-invalid';
  reason?: Error;
};
export type ContentRequest = { region: ContentRegion; generation: number; finished: boolean };
// UUID spelling is not identity. Canonicalize only comparison keys, never the
// supplied target or saved command: exact retry must retain its original bytes.
// Opaque host names and URLs/tokens keep their case-sensitive meaning.
const resourceIdentity =
  /^(area|discussion|artifact|resource):[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const canonicalKey = (key: string) => (resourceIdentity.test(key) ? key.toLowerCase() : key);
export const contentKey = (target: PreviewItemView['target']) =>
  canonicalKey(target.kind + ':' + target.resource_id);
const limits = { regions: 32, requests: 256, targets: 1000 };

/** Identity-scoped evidence ownership. Dispatch age never orders server checks. */
export class ContentCoordinator {
  private regions = new Map<string, ContentRegion>();
  private pending = new Set<ContentRequest>();
  constructor(
    readonly owner: number,
    private readonly currentOwner: () => number,
  ) {}
  current = () => this.owner === this.currentOwner();
  region(key: string) {
    key = canonicalKey(key);
    let region = this.regions.get(key);
    if (!region) {
      if (this.regions.size >= limits.regions)
        throw new Error(
          'Too many protected views are awaiting responses. Resolve them before opening another view.',
        );
      region = new ContentRegion(this, key);
      this.regions.set(key, region);
    }
    return region;
  }
  begin(region: ContentRegion, keys: readonly string[] = []) {
    if (!this.current()) throw new DOMException('Identity changed.', 'AbortError');
    if (this.pending.size >= limits.requests)
      throw new Error('Too many protected requests are pending. Retry after they finish.');
    region.trackSources(keys);
    const ticket: ContentRequest = {
      region,
      generation: region.snapshot.generation,
      finished: false,
    };
    this.pending.add(ticket);
    return ticket;
  }
  // Private adapters retain request custody to observe late denials, but never
  // publish their receipts as protected metadata.
  beginPrivate(region: ContentRegion, keys: readonly string[] = []) {
    return this.begin(region, keys);
  }
  finish(ticket: ContentRequest) {
    ticket.finished = true;
    this.pending.delete(ticket);
    this.release(ticket.region);
  }
  retain(region: ContentRegion) {
    this.regions.set(region.key, region);
  }
  release(region: ContentRegion) {
    if (!region.mounted && !this.hasPending(region) && this.regions.get(region.key) === region)
      this.regions.delete(region.key);
  }
  private hasPending(region: ContentRegion) {
    return [...this.pending].some((t) => t.region === region);
  }
  deny(ticket: ContentRequest, reason: Error) {
    if (!this.current() || ticket.finished) return;
    this.withdraw(reason);
  }
  withdraw(reason: Error) {
    if (!this.current()) return;
    // Cached paths are point-in-time display data, not authorization proofs.
    // A move (or reordered preview) can hide a current dependency. Without a
    // server-ordered proof, every same-owner region must lose its content lease.
    for (const region of this.regions.values()) region.withdraw(reason);
  }
  invalidate(reason: Error) {
    if (this.current()) for (const region of this.regions.values()) region.invalidate(reason);
  }
  get retained() {
    return {
      regions: this.regions.size,
      requests: this.pending.size,
      previews: [...this.regions.values()].reduce((n, r) => n + r.previewCount, 0),
    };
  }
}

export class ContentRegion {
  snapshot: ContentSnapshot = { generation: 0, state: 'absent' };
  mounted = 0;
  private listeners = new Set<() => void>();
  private trackedKeys = new Set<string>();
  private previews = new Map<string, PreviewItemView>();
  private previewAttempts = new Set<string>();
  constructor(
    readonly coordinator: ContentCoordinator,
    readonly key: string,
  ) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.snapshot;
  private update(snapshot: ContentSnapshot) {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
  mount() {
    this.mounted++;
    this.coordinator.retain(this);
  }
  unmount() {
    this.mounted--;
    this.coordinator.release(this);
  }
  // These keys bound retained work only; they never justify selective access.
  trackSources(keys: readonly string[]) {
    keys = keys.map(canonicalKey);
    if (new Set([...this.trackedKeys, ...keys]).size > limits.targets)
      throw new Error('Protected source scope exceeds the bounded view limit. Reopen this view.');
    for (const key of keys) this.trackedKeys.add(key);
  }
  previewRequested(keys: readonly string[]) {
    this.trackSources(keys);
    for (const key of keys) this.previewAttempts.add(canonicalKey(key));
  }
  hasPreviewAttempt(key: string) {
    return this.previewAttempts.has(canonicalKey(key));
  }
  current(generation: number | undefined) {
    return (
      this.coordinator.current() &&
      this.snapshot.state !== 'owner-invalid' &&
      generation === this.snapshot.generation
    );
  }
  withdraw(reason: Error) {
    this.previews.clear();
    this.update({ generation: this.snapshot.generation + 1, state: 'withdrawn', reason });
  }
  invalidate(reason: Error) {
    this.previews.clear();
    this.update({ generation: this.snapshot.generation + 1, state: 'owner-invalid', reason });
  }
  retry() {
    if (this.coordinator.current() && this.snapshot.state !== 'owner-invalid') {
      this.previewAttempts.clear();
      this.update({ generation: this.snapshot.generation, state: 'checking' });
    }
  }
  publish(
    ticket: ContentRequest,
    items: readonly PreviewItemView[],
    allowPartial: boolean,
    latest = true,
    sourceDenied = false,
  ) {
    if (ticket.region !== this || ticket.finished) return undefined;
    const fresh = this.current(ticket.generation) && latest;
    const denied = sourceDenied || items.some((item) => item.source.state === 'unavailable');
    if (denied)
      this.coordinator.deny(
        ticket,
        new Error('Current source unavailable. Reauthorize the displayed view.'),
      );
    if (!fresh || !this.coordinator.current() || (denied && !allowPartial)) return undefined;
    this.trackSources(
      items.flatMap((preview) => [
        contentKey(preview.target),
        ...(preview.source.state === 'available'
          ? preview.source.path.map((area) => contentKey({ kind: 'area', resource_id: area.id }))
          : []),
      ]),
    );
    // A fresh bounded response checks its members together. It may replace
    // this region with readable siblings; other regions and old requests stay
    // fenced. Private receipts cannot use this publication path.
    for (const preview of items) this.previews.set(contentKey(preview.target), preview);
    this.update({ generation: this.snapshot.generation, state: 'authorized' });
    return this.snapshot.generation;
  }
  preview(target: PreviewItemView['target'], generation: number | undefined) {
    return this.current(generation) ? this.previews.get(contentKey(target)) : undefined;
  }
  get previewCount() {
    return this.previews.size;
  }
}
