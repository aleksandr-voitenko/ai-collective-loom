/** Ephemeral controls only. These identities and cursors never authorize cached content. */
export interface DiscussionNavigationState {
  branches: Map<string, { cursor: string; opened: string[]; expanded: string[] }>;
  focus?: string | null;
  returnPosition?: { top: number; resource: string };
}
