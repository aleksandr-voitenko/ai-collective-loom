// Practical main-text presentation, not a measure of attention or comprehension.
export const presentationPolicy = Object.freeze({
  bandPixels: 160,
  dwellMs: 1000,
  sampleMs: 100,
  maxBands: 2048,
  episodeTargets: 4096,
});
/** Never evict an Unread fence to make room for another automatic observation. */
export class PresentationEpisode {
  private readonly versions = new Map<string, number>();
  private readonly blocked = new Set<string>();
  paused = false;
  constructor(private readonly limit: number = presentationPolicy.episodeTargets) {}
  track(id: string, version: number) {
    const first = this.versions.get(id);
    if (first !== undefined) {
      if (version > first) this.block(id);
      return;
    }
    if (this.versions.size >= this.limit) {
      this.paused = true;
      return;
    }
    this.versions.set(id, version);
  }
  block(id: string) {
    if (this.blocked.has(id)) return;
    if (this.blocked.size >= this.limit) {
      this.paused = true;
      return;
    }
    this.blocked.add(id);
  }
  excludes(id: string) {
    return this.paused || this.blocked.has(id);
  }
}
export class PresentedBands {
  private height = 0;
  private starts: (number | null)[] = [];
  private complete: boolean[] = [];
  pause() {
    this.starts = [];
  }
  sample(height: number, visible: (top: number, bottom: number) => boolean, now: number) {
    if (
      height <= 0 ||
      Math.ceil(height / presentationPolicy.bandPixels) > presentationPolicy.maxBands
    )
      return false;
    if (Math.abs(height - this.height) > 1) {
      this.height = height;
      this.starts = [];
      this.complete = [];
    }
    const n = Math.ceil(height / presentationPolicy.bandPixels);
    for (let i = 0; i < n; i++) {
      if (this.complete[i]) continue;
      if (
        !visible(
          i * presentationPolicy.bandPixels,
          Math.min(height, (i + 1) * presentationPolicy.bandPixels),
        )
      )
        this.starts[i] = null;
      else {
        this.starts[i] ??= now;
        if (now - this.starts[i]! >= presentationPolicy.dwellMs) this.complete[i] = true;
      }
    }
    return Array.from({ length: n }, (_, i) => this.complete[i] === true).every(Boolean);
  }
}
export function viewportPresentation(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  const active =
    document.visibilityState === 'visible' &&
    document.hasFocus() &&
    element.isConnected &&
    !document.querySelector('dialog[open]') &&
    rect.width > 0 &&
    rect.left >= 0 &&
    rect.right <= innerWidth &&
    (!element.checkVisibility ||
      element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) &&
    ![...element.querySelectorAll<HTMLElement>('*')].some(
      (node) => node.scrollWidth > node.clientWidth + 1,
    );
  return {
    height: rect.height,
    visible: (top: number, bottom: number) => {
      if (!active || rect.top + top < 0 || rect.top + bottom > innerHeight) return false;
      // Sample the actual painted stack to exclude sticky headers and covering UI.
      return [top + 0.5, (top + bottom) / 2, bottom - 0.5].every((y) => {
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + y);
        return !!hit && element.contains(hit);
      });
    },
  };
}
