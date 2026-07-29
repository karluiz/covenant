/// Retained group-supervision findings.
///
/// The backend emits `group-supervision-finding` and the toast host shows
/// it for a few seconds; if you were in another app when it landed, the
/// finding never existed. This keeps the last N per group so Convergence's
/// group detail can show what the supervisor has actually been saying.
///
/// ponytail: in-memory ring, dies with the window — persist in SQLite
/// only when someone asks "what did Warden say yesterday?".

export interface GroupFinding {
  groupId: string;
  operatorName: string;
  message: string;
  atUnixMs: number;
}

const MAX_PER_GROUP = 20;
const EMPTY: readonly GroupFinding[] = [];

/// Fired on the window whenever a group's unread count changes, so the
/// group chip can repaint without polling. Detail carries no payload —
/// listeners re-read `unreadGroupFindings`.
export const GROUP_FINDINGS_EVENT = "group-findings:changed";

/// Newest first, per group id.
const byGroup = new Map<string, GroupFinding[]>();
/// Findings that landed while you were looking elsewhere. Cleared when
/// the supervision tooltip is opened for that group.
const unread = new Map<string, number>();

export function recordGroupFinding(f: GroupFinding): void {
  const list = byGroup.get(f.groupId) ?? [];
  list.unshift(f);
  if (list.length > MAX_PER_GROUP) list.length = MAX_PER_GROUP;
  byGroup.set(f.groupId, list);
  unread.set(f.groupId, (unread.get(f.groupId) ?? 0) + 1);
  // Guarded: this module's own tests run in the node environment.
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(GROUP_FINDINGS_EVENT));
  }
}

export function unreadGroupFindings(groupId: string): number {
  return unread.get(groupId) ?? 0;
}

/// Silent on purpose: reading happens on hover, and re-rendering the
/// tabbar under an open tooltip would tear out the element the tooltip
/// is anchored to. The caller clears its own badge in place.
export function markGroupFindingsRead(groupId: string): void {
  unread.delete(groupId);
}

/// Newest first. Empty (shared, frozen-by-convention) when nothing landed.
export function groupFindings(groupId: string): readonly GroupFinding[] {
  return byGroup.get(groupId) ?? EMPTY;
}

/// Test seam.
export function clearGroupFindings(): void {
  byGroup.clear();
  unread.clear();
}
