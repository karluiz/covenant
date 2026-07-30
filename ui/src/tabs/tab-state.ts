/// The ONE thing a tab pill says about what it is doing.
///
/// Before this, six indicators rendered independently on the pill: the
/// agent-idle ellipsis, the busy-proc glyph, the live-worktree ring, the
/// share dot, the AOM "driving" dot and the escalation dot. Three of them
/// were greens with unrelated meanings, two were absolutely positioned
/// into the same 28px beside the close ×, and each had its own render
/// path — so which glyph you saw depended on which event fired last.
///
/// Status is mutually exclusive in practice: a tab blocked on you is not
/// usefully also "serving on :1420". So the pill gets one slot, one atom,
/// resolved by the ladder below; the states that lose are counted (+n)
/// and named in the tooltip.
///
/// Pure on purpose — the ladder is testable without a DOM, which is the
/// check the six-render-path version could not have.

export type TabStateKind =
  /// Operator escalated, or a blocking prompt is on screen.
  | "attention"
  /// Executor is idle, holding a question for you.
  | "waiting"
  /// An operator is autonomously typing here (AOM, or solo on this tab).
  | "driving"
  /// A port is listening under this tab's process tree.
  | "serving"
  /// The running dev app was built from this worktree.
  | "live"
  /// This session is broadcast read-only.
  | "shared";

export interface TabStateInput {
  blocked: boolean;
  idleAgent: boolean;
  driving: boolean;
  serving: boolean;
  liveWorktree: boolean;
  shared: boolean;
}

/// Highest severity first — the top true state owns the slot.
///
/// The order IS the design contract: colour encodes severity
/// (danger → running → accent → ok → muted), so a rung cannot be moved
/// without moving the colour it maps to in `styles.css`.
const LADDER: ReadonlyArray<readonly [TabStateKind, (i: TabStateInput) => boolean]> = [
  ["attention", (i) => i.blocked],
  ["waiting", (i) => i.idleAgent],
  ["driving", (i) => i.driving],
  ["serving", (i) => i.serving],
  ["live", (i) => i.liveWorktree],
  ["shared", (i) => i.shared],
];

export interface TabState {
  /// What the atom renders. `null` means nothing to say — the slot stays
  /// empty rather than rendering a decorative dot.
  kind: TabStateKind | null;
  /// Every true state in ladder order. `all[0] === kind`.
  all: TabStateKind[];
  /// How many states lost the slot. Rendered as "+n" beside the atom.
  extra: number;
}

export function resolveTabState(input: TabStateInput): TabState {
  const all = LADDER.filter(([, isOn]) => isOn(input)).map(([kind]) => kind);
  return { kind: all[0] ?? null, all, extra: Math.max(0, all.length - 1) };
}

/// Tooltip wording per state. The winning state's label is the title; the
/// losers become the meta line. Callers may enrich `waiting` and
/// `serving`, the two that carry live detail (the prompt, the port).
export function tabStateLabel(kind: TabStateKind): string {
  switch (kind) {
    case "attention":
      return "Operator escalated — needs your input";
    case "waiting":
      return "Waiting on you";
    case "driving":
      return "An operator is driving this tab";
    case "serving":
      return "A dev server is serving here";
    case "live":
      return "The running app was built from this worktree";
    case "shared":
      return "Sharing read-only";
  }
}
