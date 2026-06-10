import type { TabInfo } from "./protocol";

// Titles arrive as "GROUP › name" from the desktop, so title order is
// group-then-name order; no separate group field exists in the protocol.
export function sortTabs(tabs: TabInfo[]): TabInfo[] {
  return [...tabs].sort((a, b) => {
    if (a.armed !== b.armed) return a.armed ? -1 : 1;
    const t = a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
    if (t !== 0) return t;
    return a.session_id.localeCompare(b.session_id);
  });
}

export function resolveSelection(prev: string | null, tabs: TabInfo[]): string | null {
  if (prev && tabs.some((t) => t.session_id === prev)) return prev;
  const firstArmed = sortTabs(tabs).find((t) => t.armed);
  return firstArmed ? firstArmed.session_id : null;
}

export interface MirrorIntent { stop: string | null; start: string | null; }

// Exactly one mirror at a time, and only while the detail pane is visible.
export function mirrorTransition(
  mirrored: string | null,
  selected: string | null,
  selectedArmed: boolean,
  detailVisible: boolean,
): MirrorIntent {
  const want = detailVisible && selectedArmed ? selected : null;
  if (want === mirrored) return { stop: null, start: null };
  return { stop: mirrored, start: want };
}
