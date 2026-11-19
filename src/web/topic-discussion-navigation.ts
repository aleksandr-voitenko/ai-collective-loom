import type { MouseEvent } from 'react';

export const TOPIC_DISCUSSION_ORDER = 'created_desc';

export type TopicDiscussionPosition = {
  pages: number;
  tailId?: string;
} & ({ discussionId: string; offset: number } | { discussionId?: undefined });

export function isDiscussionNavigationClick(event: MouseEvent<HTMLAnchorElement>) {
  return (
    !event.defaultPrevented &&
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}

const retainedEntries = 16;

/** Navigation controls for one authenticated community lifetime. No content or cursors. */
export class TopicDiscussionNavigation {
  private positions = new Map<string, TopicDiscussionPosition>();

  get(entry: string, topic: string) {
    return this.positions.get(this.key(entry, topic));
  }

  remember(entry: string, topic: string, position: TopicDiscussionPosition | undefined) {
    const key = this.key(entry, topic);
    this.positions.delete(key);
    if (!position) return;
    this.positions.set(key, position);
    if (this.positions.size > retainedEntries)
      this.positions.delete(this.positions.keys().next().value!);
  }

  private key(entry: string, topic: string) {
    return JSON.stringify([entry, topic, TOPIC_DISCUSSION_ORDER]);
  }
}
