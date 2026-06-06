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
}

/// Minimal structural view of a tab — only what hint-building reads.
/// Structural so tests pass plain objects without a full `Tab`.
export interface HintTab {
  panes: ReadonlyArray<{ sessionId: string | null }>;
  defaultTitle: string;
  customName: string | null;
  color: string | null;
}

/// One hint per *pane* that owns a live session. Split tabs contribute
/// both panes; panes with `sessionId === null` (browser panes) are
/// skipped — that skip is exactly what prevents an undefined session id
/// from reaching the backend.
export function sessionHintsFromTabs(
  tabs: ReadonlyArray<HintTab>,
): SessionHint[] {
  const out: SessionHint[] = [];
  for (const t of tabs) {
    const title = t.customName?.trim() || t.defaultTitle || "untitled";
    for (const p of t.panes) {
      if (!p.sessionId) continue;
      out.push({ sessionId: p.sessionId, title, color: t.color });
    }
  }
  return out;
}
