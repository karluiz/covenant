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
  title: string;
  isActiveTabInWorkspace: boolean;
  /// Last activation timestamp (ms). Only live tabs in the active
  /// workspace have one; hibernated workspaces report null.
  lastActiveAt: number | null;
}
