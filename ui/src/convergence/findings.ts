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

/// Newest first, per group id.
const byGroup = new Map<string, GroupFinding[]>();

export function recordGroupFinding(f: GroupFinding): void {
  const list = byGroup.get(f.groupId) ?? [];
  list.unshift(f);
  if (list.length > MAX_PER_GROUP) list.length = MAX_PER_GROUP;
  byGroup.set(f.groupId, list);
}

/// Newest first. Empty (shared, frozen-by-convention) when nothing landed.
export function groupFindings(groupId: string): readonly GroupFinding[] {
  return byGroup.get(groupId) ?? EMPTY;
}

/// Test seam.
export function clearGroupFindings(): void {
  byGroup.clear();
}
