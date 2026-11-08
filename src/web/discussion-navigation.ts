/** Ephemeral controls only. These identities and cursors never authorize cached content. */
export interface DiscussionNavigationState {
  branches: Map<
    string,
    { loadedCount: number; tailId?: string; opened: string[]; expanded: string[] }
  >;
  focus?: string | null;
  returnPosition?: { top: number; resource: string };
}
