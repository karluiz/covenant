import type {
  EscalationCard,
  OperatorRosterEntry,
  TileStatus,
} from "../api";

const PRIORITY: Record<TileStatus, number> = {
  blocked: 0,
  "operator-thinking": 1,
  working: 2,
  "awaiting-input": 3,
  idle: 4,
};

/// Lower = more urgent. Unknown statuses sort last.
export function statusPriority(s: TileStatus): number {
  return PRIORITY[s] ?? 99;
}

/// The status shown on an operator's header pill: the most urgent status
/// across all of its sessions. Empty operator → idle.
export function operatorStatus(entry: OperatorRosterEntry): TileStatus {
  return entry.sessions.reduce<TileStatus>(
    (best, s) => (statusPriority(s.status) < statusPriority(best) ? s.status : best),
    "idle",
  );
}

/// session_id → escalation card, for joining question/tail/reply onto a
/// blocked session (SessionSummary lacks those fields).
export function escalationIndex(esc: EscalationCard[]): Map<string, EscalationCard> {
  return new Map(esc.map((e) => [e.session_id, e]));
}

/// Grid order: escalating operators first (oldest escalation first),
/// then by header-status priority, then by name.
export function sortOperators(
  roster: OperatorRosterEntry[],
  esc: EscalationCard[],
): OperatorRosterEntry[] {
  const oldestEsc = new Map<string, number>();
  for (const e of esc) {
    const cur = oldestEsc.get(e.operator_id);
    if (cur === undefined || e.escalated_at_unix_ms < cur) {
      oldestEsc.set(e.operator_id, e.escalated_at_unix_ms);
    }
  }
  return [...roster].sort((a, b) => {
    if (a.has_escalation !== b.has_escalation) return a.has_escalation ? -1 : 1;
    if (a.has_escalation && b.has_escalation) {
      const at = oldestEsc.get(a.operator_id) ?? 0;
      const bt = oldestEsc.get(b.operator_id) ?? 0;
      if (at !== bt) return at - bt;
    }
    const ap = statusPriority(operatorStatus(a));
    const bp = statusPriority(operatorStatus(b));
    if (ap !== bp) return ap - bp;
    return a.operator_name.localeCompare(b.operator_name);
  });
}
