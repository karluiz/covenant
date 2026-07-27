import type { AgentCard, AttentionItem, TileStatus } from "../api";

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

/// session_id → attention item, for joining the queue onto the grid
/// (blocked ordering, grid exclusion).
export function attentionIndex(items: AttentionItem[]): Map<string, AttentionItem> {
  return new Map(items.map((i) => [i.session_id, i]));
}

/// Grid order: blocked first (oldest attention timestamp first; blocked
/// without a timestamp after those), then status priority, then title.
export function sortAgents(agents: AgentCard[], attention: AttentionItem[]): AgentCard[] {
  const at = new Map(
    attention.map((i) => [i.session_id, i.since_unix_ms ?? Infinity]),
  );
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
