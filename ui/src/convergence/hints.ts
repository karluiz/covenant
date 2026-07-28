/// A per-session hint sent with the Convergence snapshot command.
/// `sessionId` is REQUIRED and must be a real string. Sending `undefined`
/// (the Phase-C regression — Tab.sessionId was removed but the bridge
/// still read it) makes the Rust `TabHint { session_id: String }`
/// deserialize fail, which rejects the whole snapshot and blanks the
/// overlay. See spec 2026-06-06.
export interface SessionHint {
  sessionId: string;
  title: string;
  color: string | null;
  /// Resolved tab-group name. UI-side only — never sent to the backend
  /// (the snapshot hint stays {session_id, title, color}); the overlay
  /// uses it as the rail bucket's LABEL.
  group: string | null;
  /// The bucket KEY, and the key supervision + findings are stored under
  /// (`group_supervision-finding.group_id`). Two groups may share a name;
  /// they never share an id.
  groupId: string | null;
  /// Supervisor attached to this session's group, if any. Carries the
  /// operator id only — the overlay resolves the display name itself.
  supervisor: { operatorId: string; intervene: boolean } | null;
}

/// What the overlay needs to know about a tab group, keyed by group id.
export interface GroupInfo {
  name: string;
  supervisorId: string | null;
  supervisorIntervene: boolean;
}

/// Minimal structural view of a tab — only what hint-building reads.
/// Structural so tests pass plain objects without a full `Tab`.
export interface HintTab {
  panes: ReadonlyArray<{ sessionId: string | null; acpSessionId?: string | null }>;
  defaultTitle: string;
  customName: string | null;
  color: string | null;
  groupId?: string | null;
}

/// One hint per *pane* that owns a live session. Split tabs contribute
/// both panes; ACP panes (xterm-less) hint via their `acpSessionId`.
/// Panes with neither id (browser panes) are skipped — that skip is
/// exactly what prevents an undefined session id from reaching the
/// backend.
export function sessionHintsFromTabs(
  tabs: ReadonlyArray<HintTab>,
  groups?: ReadonlyMap<string, GroupInfo>,
): SessionHint[] {
  const out: SessionHint[] = [];
  for (const t of tabs) {
    const title = t.customName?.trim() || t.defaultTitle || "untitled";
    const info = (t.groupId && groups?.get(t.groupId)) || null;
    // An id we can't resolve is treated as ungrouped — a bucket labelled
    // by a name we don't have would render as an empty header.
    const groupId = info ? t.groupId ?? null : null;
    const supervisor = info?.supervisorId
      ? { operatorId: info.supervisorId, intervene: info.supervisorIntervene }
      : null;
    for (const p of t.panes) {
      const sid = p.sessionId ?? p.acpSessionId;
      if (!sid) continue;
      out.push({
        sessionId: sid,
        title,
        color: t.color,
        group: info?.name ?? null,
        groupId,
        supervisor,
      });
    }
  }
  return out;
}
