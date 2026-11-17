/** Ephemeral controls only. These identities and cursors never authorize cached content. */
export interface DiscussionNavigationState {
  /** Current-discussion observation only; IDs and cursor grant no content access. */
  freshness?: {
    cursor: string;
    events: import('../contracts/discussion-freshness.js').FreshnessView['events'];
    broad: boolean;
  };
  /** Bounded per-parent identities, independent of branch depth and page extent. */
  knownReplies?: Map<string, string[]>;
  branches: Map<
    string,
    {
      loadedCount: number;
      tailId?: string;
      opened: string[];
      expanded: string[];
      collapsed: string[];
    }
  >;
  focus?: string | null;
  focusedCollapsed?: string[];
  returnPosition?: { top: number; resource: string };
}
