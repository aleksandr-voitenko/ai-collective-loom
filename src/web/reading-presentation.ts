// A visit is measured on mounted main text, independent of whether a write is eligible.
export const presentationPolicy = Object.freeze({ episodeTargets: 4096 });

type Visit = {
  occurrences: Map<symbol, boolean>;
  wasPresent: boolean;
  heldUnread: boolean;
  attempted: boolean;
  generation: number;
};

export class PresentationEpisode {
  private readonly visits = new Map<string, Visit>();
  paused = false;
  constructor(private readonly limit: number = presentationPolicy.episodeTargets) {}

  private visit(id: string) {
    const old = this.visits.get(id);
    if (old) return old;
    if (this.visits.size >= this.limit) {
      this.paused = true;
      return undefined;
    }
    const next: Visit = {
      occurrences: new Map(),
      wasPresent: false,
      heldUnread: false,
      attempted: false,
      generation: 0,
    };
    this.visits.set(id, next);
    return next;
  }

  presence(id: string, occurrence: symbol, present: boolean) {
    this.measurePresence(id, occurrence, present);
    this.reconcilePresence(id);
  }

  measurePresence(id: string, occurrence: symbol, present: boolean) {
    const visit = this.visit(id);
    if (!visit) return;
    visit.occurrences.set(occurrence, present);
    if (present) visit.wasPresent = true;
  }

  reconcilePresence(id: string) {
    const visit = this.visits.get(id);
    if (visit?.wasPresent && ![...visit.occurrences.values()].some(Boolean)) {
      // Only a measured full exit ends a held or attempted visit. Cleanup alone
      // cannot manufacture an exit during StrictMode replay or branch remounting.
      visit.wasPresent = false;
      visit.heldUnread = false;
      visit.attempted = false;
      visit.generation++;
    }
  }

  unregister(id: string, occurrence: symbol) {
    this.visits.get(id)?.occurrences.delete(occurrence);
  }

  manualUnread(id: string) {
    const visit = this.visit(id);
    if (visit) {
      visit.heldUnread = visit.wasPresent;
      visit.attempted = visit.wasPresent;
    }
  }

  generation(id: string) {
    return this.visits.get(id)?.generation ?? 0;
  }

  attempted(id: string, generation = this.generation(id)) {
    const visit = this.visit(id);
    if (visit && visit.generation === generation) visit.attempted = true;
  }

  excludes(id: string) {
    const visit = this.visits.get(id);
    return this.paused || !!visit?.heldUnread || !!visit?.attempted;
  }
}

export function viewportPresentation(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  const displayed =
    element.isConnected &&
    rect.width > 0 &&
    rect.height > 0 &&
    style.display !== 'none' &&
    style.visibility !== 'hidden' &&
    style.visibility !== 'collapse' &&
    style.opacity !== '0' &&
    (!element.checkVisibility ||
      element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }));
  const left = Math.max(0, rect.left);
  const right = Math.min(innerWidth, rect.right);
  const top = Math.max(0, rect.top);
  const bottom = Math.min(innerHeight, rect.bottom);
  const present = displayed && right > left && bottom > top;
  const eligible =
    present &&
    document.visibilityState === 'visible' &&
    document.hasFocus() &&
    !document.querySelector('dialog[open]') &&
    [0.25, 0.5, 0.75].some((yFraction) =>
      [0.25, 0.5, 0.75].some((xFraction) => {
        const hit = document.elementFromPoint(
          left + (right - left) * xFraction,
          top + (bottom - top) * yFraction,
        );
        return !!hit && element.contains(hit);
      }),
    );
  return { present, eligible };
}

// One observer/event set serves every mounted reading region. The geometry check
// still runs on focus and DOM changes, since intersection alone cannot detect cover.
type ReadingRegionPhase = 'measure' | 'reconcile' | 'qualify';
const observed = new Map<HTMLElement, Set<(phase: ReadingRegionPhase) => void>>();
let intersections: IntersectionObserver | undefined;
let mutations: MutationObserver | undefined;
let scheduled = false;
function notifyAll() {
  scheduled = false;
  const callbacks = [...observed.values()].flatMap((group) => [...group]);
  // Reconcile every occurrence before a hold can end or a new visit can qualify.
  for (const callback of callbacks) callback('measure');
  for (const callback of callbacks) callback('reconcile');
  for (const callback of callbacks) callback('qualify');
}
export function scheduleReadingRegions() {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(notifyAll);
}
function start() {
  if (typeof IntersectionObserver !== 'undefined')
    intersections = new IntersectionObserver(scheduleReadingRegions);
  mutations = new MutationObserver(scheduleReadingRegions);
  mutations.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['style', 'class', 'hidden', 'open', 'aria-hidden'],
  });
  window.addEventListener('scroll', scheduleReadingRegions, true);
  window.addEventListener('resize', scheduleReadingRegions);
  window.addEventListener('focus', scheduleReadingRegions);
  window.addEventListener('blur', scheduleReadingRegions);
  document.addEventListener('visibilitychange', scheduleReadingRegions);
}
function stop() {
  intersections?.disconnect();
  intersections = undefined;
  mutations?.disconnect();
  mutations = undefined;
  window.removeEventListener('scroll', scheduleReadingRegions, true);
  window.removeEventListener('resize', scheduleReadingRegions);
  window.removeEventListener('focus', scheduleReadingRegions);
  window.removeEventListener('blur', scheduleReadingRegions);
  document.removeEventListener('visibilitychange', scheduleReadingRegions);
}
export function observeReadingRegion(
  element: HTMLElement,
  callback: (phase: ReadingRegionPhase) => void,
) {
  if (!observed.size) start();
  const callbacks = observed.get(element) ?? new Set<(phase: ReadingRegionPhase) => void>();
  callbacks.add(callback);
  observed.set(element, callbacks);
  intersections?.observe(element);
  scheduleReadingRegions();
  return () => {
    callbacks.delete(callback);
    if (!callbacks.size) {
      observed.delete(element);
      intersections?.unobserve(element);
    }
    if (!observed.size) stop();
  };
}
