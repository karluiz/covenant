import type { AgentCard, EscalationCard, TileStatus } from "../api";

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

/// session_id → escalation card, for joining question/tail/reply onto a
/// blocked operator session (AgentCard lacks those fields).
export function escalationIndex(esc: EscalationCard[]): Map<string, EscalationCard> {
  return new Map(esc.map((e) => [e.session_id, e]));
}

/// Grid order: blocked first (oldest escalation first; blocked without an
/// escalation card after those), then status priority, then title.
export function sortAgents(agents: AgentCard[], esc: EscalationCard[]): AgentCard[] {
  const at = new Map(esc.map((e) => [e.session_id, e.escalated_at_unix_ms]));
  return [...agents].sort((a, b) => {
    const ab = a.status === "blocked";
    const bb = b.status === "blocked";
    if (ab !== bb) return ab ? -1 : 1;
    if (ab && bb) {
      const d = (at.get(a.session_id) ?? Infinity) - (at.get(b.session_id) ?? Infinity);
      if (d !== 0) return d;
    }
    const dp = statusPriority(a.status) - statusPriority(b.status);
    if (dp !== 0) return dp;
    return a.tab_title.localeCompare(b.tab_title);
  });
}
