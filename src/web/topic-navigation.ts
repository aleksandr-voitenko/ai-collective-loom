import type { MouseEvent } from 'react';

export const TOPIC_DISCUSSION_ORDER = 'created_desc';

export const restorationPageBudget = 8;

export type TopicDiscussionPosition = {
  pages: number;
  tailId?: string;
} & ({ discussionId: string; offset: number } | { discussionId?: undefined });

export type TopicDirectoryPosition = {
  pages: number;
  tailId?: string;
  topicId: string;
  offset: number;
};

export type TopicReturnTarget =
  | { kind: 'directory'; position: TopicDirectoryPosition }
  | { kind: 'discussions'; position: TopicDiscussionPosition };

export function isTopicNavigationClick(event: MouseEvent<HTMLAnchorElement>) {
  return (
    !event.defaultPrevented &&
    (!event.currentTarget.target || event.currentTarget.target.toLowerCase() === '_self') &&
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}

export function watchTopicNavigationInteraction(onInterrupt?: () => void) {
  let interrupted = false;
  let frame: number | undefined;
  const events = ['wheel', 'touchstart', 'pointerdown', 'keydown', 'focusin', 'input', 'click'];
  const stop = () => {
    for (const event of events) window.removeEventListener(event, interrupt, true);
    window.removeEventListener('scroll', interrupt);
    if (frame !== undefined) window.cancelAnimationFrame(frame);
  };
  function interrupt() {
    interrupted = true;
    stop();
    onInterrupt?.();
  }
  for (const event of events)
    window.addEventListener(event, interrupt, { capture: true, passive: true });
  // Browsers may apply their own Back position during the first render. Keep
  // input listeners active, then also detect scrolling through the scrollbar.
  if (window.requestAnimationFrame)
    frame = window.requestAnimationFrame(() => {
      frame = window.requestAnimationFrame(() => {
        window.addEventListener('scroll', interrupt, { passive: true });
      });
    });
  return { interrupted: () => interrupted, stop };
}

const retainedEntries = 16;

/** One departure per history entry in this authenticated community lifetime. */
export class TopicNavigation {
  private positions = new Map<string, { source: string | null; target: TopicReturnTarget }>();

  get(entry: string, sourceTopic: string | null) {
    const saved = this.positions.get(entry);
    if (saved?.source === (sourceTopic?.toLowerCase() ?? null)) return saved.target;
  }

  remember(entry: string, sourceTopic: string | null, target: TopicReturnTarget | undefined) {
    this.positions.delete(entry);
    if (!target) return;
    this.positions.set(entry, { source: sourceTopic?.toLowerCase() ?? null, target });
    if (this.positions.size > retainedEntries)
      this.positions.delete(this.positions.keys().next().value!);
  }
}
