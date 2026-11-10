/** Ephemeral controls only. These identities and cursors never authorize cached content. */
export interface DiscussionNavigationState {
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
