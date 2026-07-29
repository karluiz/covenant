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

/// session_id → attention item, for joining the queue onto rows and the
/// detail pane.
export function attentionIndex(items: AttentionItem[]): Map<string, AttentionItem> {
  return new Map(items.map((i) => [i.session_id, i]));
}

export interface GroupedAgents {
  /// Tab-group name; null = ungrouped tabs.
  key: string | null;
  cards: AgentCard[];
}

/// Bucket an already-sorted rail list by workspace group. Buckets with a
/// blocked session bubble first; then your own workspace's buckets before
/// any foreign one; ties keep the first-appearance order of the flat
/// list, and cards keep their in-list order inside each bucket.
///
/// Blocked outranks foreign deliberately: an agent waiting on you in
/// another workspace is exactly the thing you opened Convergence to find.
export function groupAgents(
  list: AgentCard[],
  groupOf: (sessionId: string) => string | null,
  isForeign: (bucketKey: string | null) => boolean = () => false,
): GroupedAgents[] {
  const buckets = new Map<string | null, AgentCard[]>();
  for (const card of list) {
    const key = groupOf(card.session_id);
    const b = buckets.get(key);
    if (b) b.push(card);
    else buckets.set(key, [card]);
  }
  return [...buckets.entries()]
    .map(([key, cards]) => ({ key, cards }))
    .sort((a, b) => {
      const ab = a.cards.some((c) => c.status === "blocked");
      const bb = b.cards.some((c) => c.status === "blocked");
      if (ab !== bb) return ab ? -1 : 1;
      const af = isForeign(a.key);
      const bf = isForeign(b.key);
      if (af !== bf) return af ? 1 : -1;
      return list.indexOf(a.cards[0]) - list.indexOf(b.cards[0]);
    });
}

/// Rail order: blocked first (oldest attention timestamp first; blocked
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
