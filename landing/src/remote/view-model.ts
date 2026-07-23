import type { TabInfo } from "./protocol";

// Titles arrive as "GROUP › name" from the desktop, so title order is
// group-then-name order; no separate group field exists in the protocol.
// splitTitle recovers the two parts (the separator is a real "›" U+203A).
export function splitTitle(title: string): { group: string | null; leaf: string } {
  const i = title.indexOf(" › ");
  if (i === -1) return { group: null, leaf: title };
  return { group: title.slice(0, i), leaf: title.slice(i + 3) };
}

// How urgently a tab wants attention. Lower = higher up. Armed tabs jump to
// the very top regardless of phase (see attentionKey) so the thing you can
// act on is always reachable; within a tier, phase decides.
const PHASE_RANK: Record<string, number> = {
  waiting: 0,   // stopped, asking you something — the whole reason to open this
  done: 1,      // finished; may want a look
  running: 2,   // in flight
  writing: 2,
  reading: 2,
  thinking: 3,
  idle: 4,      // at rest
};
function phaseRank(phase: string): number {
  return PHASE_RANK[phase] ?? 4;
}

// A tab's sort key: armed first, then by phase urgency, then title, then id.
function attentionKey(t: TabInfo): [number, number, string, string] {
  return [t.armed ? 0 : 1, phaseRank(t.phase), t.title, t.session_id];
}

export function sortTabs(tabs: TabInfo[]): TabInfo[] {
  return [...tabs].sort((a, b) => {
    const ka = attentionKey(a), kb = attentionKey(b);
    if (ka[0] !== kb[0]) return ka[0] - kb[0];
    if (ka[1] !== kb[1]) return ka[1] - kb[1];
    const t = ka[2].localeCompare(kb[2], undefined, { sensitivity: "base" });
    if (t !== 0) return t;
    return ka[3].localeCompare(kb[3]);
  });
}

// Phase → a human word + a semantic tone token. Tones map to the app's
// documented palette (--ok/--running/--fail/muted), not ad-hoc greens.
export type Tone = "wait" | "done" | "run" | "think" | "idle";
export function phaseLabel(phase: string): { text: string; tone: Tone } {
  switch (phase) {
    case "waiting": return { text: "waiting", tone: "wait" };
    case "done":    return { text: "done", tone: "done" };
    case "running": return { text: "running", tone: "run" };
    case "writing": return { text: "writing", tone: "run" };
    case "reading": return { text: "reading", tone: "run" };
    case "thinking":return { text: "thinking", tone: "think" };
    case "idle":    return { text: "idle", tone: "idle" };
    default:        return { text: phase, tone: "idle" };
  }
}

export function resolveSelection(prev: string | null, tabs: TabInfo[]): string | null {
  if (prev && tabs.some((t) => t.session_id === prev)) return prev;
  const firstArmed = sortTabs(tabs).find((t) => t.armed);
  return firstArmed ? firstArmed.session_id : null;
}

// One-line summary for the header: what actually needs you, then the rest.
// "2 waiting · 1 done · 3 running · 15 idle" — omits any zero bucket.
export function attentionSummary(tabs: TabInfo[]): string {
  if (tabs.length === 0) return "no tabs";
  let waiting = 0, done = 0, active = 0, idle = 0;
  for (const t of tabs) {
    if (t.phase === "waiting") waiting++;
    else if (t.phase === "done") done++;
    else if (t.phase === "idle") idle++;
    else active++;
  }
  const parts: string[] = [];
  if (waiting) parts.push(`${waiting} waiting`);
  if (done) parts.push(`${done} done`);
  if (active) parts.push(`${active} active`);
  if (idle) parts.push(`${idle} idle`);
  return parts.join(" · ");
}

// A group of tabs sharing a "GROUP ›" prefix, plus the ungrouped ones.
// `active` counts anything not idle — drives whether the group starts folded.
export interface TabGroup {
  key: string;          // the group name, or "" for ungrouped
  label: string;        // display label ("" ungrouped rendered without a header)
  tabs: TabInfo[];      // already attention-sorted
  active: number;       // non-idle count
}

// Bucket attention-sorted tabs into groups, preserving the order the first
// member of each group appears in — so a group with a waiting tab floats up.
export function groupTabs(tabs: TabInfo[]): TabGroup[] {
  const sorted = sortTabs(tabs);
  const order: string[] = [];
  const byKey = new Map<string, TabInfo[]>();
  for (const t of sorted) {
    const { group } = splitTitle(t.title);
    const key = group ?? "";
    if (!byKey.has(key)) { byKey.set(key, []); order.push(key); }
    byKey.get(key)!.push(t);
  }
  return order.map((key) => {
    const gt = byKey.get(key)!;
    return {
      key,
      label: key,
      tabs: gt,
      active: gt.filter((t) => t.phase !== "idle").length,
    };
  });
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
