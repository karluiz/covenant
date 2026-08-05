/// Shared shape for a single tab row across workspaces. Consumed by
/// the workspace manager (producer) and the command palette (ranker).
export interface TabRow {
  workspaceId: string;
  workspaceName: string;
  workspaceColor: string | null;
  workspaceActive: boolean;
  groupId: string | null;
  groupName: string | null;
  groupColor: string | null;
  tabIndex: number;
  /// Live TabManager id, when there is one. Only the active workspace has
  /// live Tab objects, so rows from background workspaces report null —
  /// which is what gates the row-scoped rename/close verbs off for them.
  tabId: string | null;
  title: string;
  isActiveTabInWorkspace: boolean;
  /// Last activation timestamp (ms). Only live tabs in the active
  /// workspace have one; hibernated workspaces report null.
  lastActiveAt: number | null;
}
