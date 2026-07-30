/// Builds the vitals events for one tab activation.
///
/// Two events, because they answer different questions and only the second
/// tracks what users actually feel:
///   * `switch`  — activate()'s own work, start → reveal frame. Measured at
///     10-15ms typical / 42ms worst over 42 live switches, so a healthy value
///     here says nothing about a laggy switch. Kept for continuity with
///     0.11.3 data and to prove the JS path stays cheap.
///   * `repaint` — start → the frame after the reveal actually painted. This
///     is the number that moved with load in measurement (168ms idle → 385ms
///     returning to a tab that streamed for 10s while hidden).
///
/// `aux` carries the second-most useful number per event: post-reveal
/// starvation for `switch` (null when unmeasurable — see ./starvation), and
/// the click→activate queue delay for `repaint` (null when the activation had
/// no originating user event, e.g. a programmatic switch).
///
/// Every event carries the hidden-output context, since bytes written while
/// the pane was display:none is the variable that correlated with the lag.

export interface SwitchFitBreadcrumb {
  fitMs: number;
  nudgeMs: number;
  colsDelta: number;
  rowsDelta: number;
  usedNudge: boolean;
  fitChangedDimensions: boolean;
}

export interface SwitchVitalInput {
  /// Tab kind — "shell" | "acp" | "pi" | "browser". 0.11.3 recorded only
  /// shell tabs because the per-kind early returns preceded the record call.
  kind: string;
  /// activate()'s synchronous body only — the same span for every tab kind.
  elapsedMs: number;
  repaintMs: number | null;
  queuedMs: number | null;
  starvedMs: number | null;
  hiddenOutputBytes: number;
  hiddenOutputChunks: number;
  tabCount: number;
  /// Geometry breadcrumb — terminal tabs only.
  fit: SwitchFitBreadcrumb | null;
  /// Activation start → the FIRST animation frame after the synchronous body.
  /// Splits the repaint gap in two: a large frame1 means frames were not being
  /// produced at all, while frame1 small + repaint large means the revealed
  /// content itself was expensive to paint.
  frame1Ms: number | null;
  /// Event-loop lateness accumulated DURING the gap. Near-zero across a long
  /// gap means the loop stayed responsive while frames stalled — which rules
  /// out main-thread work as the cause. See ./gap-watch.
  gapStarvedMs: number | null;
  /// Revealed terminal's grid. Tests the standing prediction that the reveal
  /// cost scales with viewport size rather than with buffered output.
  grid: { cols: number; rows: number } | null;
  /// True when the window was not continuously visible between activation and
  /// the repaint frame. WebKit suspends rAF while occluded, so `repaintMs`
  /// then measures how long the user looked away — not a slow repaint.
  spannedHidden: boolean;
}

export interface BuiltVital {
  metric: "switch" | "repaint";
  value: number;
  aux: number | null;
  detail: Record<string, unknown>;
}

const r1 = (n: number): number => Math.round(n * 10) / 10;

export function buildSwitchVitals(input: SwitchVitalInput): BuiltVital[] {
  const shared: Record<string, unknown> = {
    kind: input.kind,
    hiddenOutputBytes: input.hiddenOutputBytes,
    hiddenOutputChunks: input.hiddenOutputChunks,
    tabCount: input.tabCount,
  };
  if (input.frame1Ms !== null) shared.frame1Ms = r1(input.frame1Ms);
  if (input.gapStarvedMs !== null) shared.gapStarvedMs = Math.round(input.gapStarvedMs);
  if (input.grid) {
    shared.cols = input.grid.cols;
    shared.rows = input.grid.rows;
    shared.cells = input.grid.cols * input.grid.rows;
  }
  // The geometry breadcrumb goes on BOTH events: the Vitals page investigates
  // the slowest *repaints*, so dropping it from that event would render the
  // "Cols Δ" / "Fit ms" columns permanently empty.
  if (input.fit) {
    shared.fitMs = r1(input.fit.fitMs);
    shared.nudgeMs = r1(input.fit.nudgeMs);
    shared.colsDelta = input.fit.colsDelta;
    shared.rowsDelta = input.fit.rowsDelta;
    shared.usedNudge = input.fit.usedNudge;
    shared.fitChangedDimensions = input.fit.fitChangedDimensions;
  }
  const switchDetail: Record<string, unknown> = { ...shared };

  // A repaint measured across a hidden stretch is unusable, but silently
  // dropping it would make "how often does this happen" unanswerable.
  if (input.spannedHidden) switchDetail.repaintDiscarded = "window-not-visible";

  const out: BuiltVital[] = [
    {
      metric: "switch",
      value: r1(input.elapsedMs),
      aux: input.starvedMs === null ? null : Math.round(input.starvedMs),
      detail: switchDetail,
    },
  ];
  if (input.repaintMs !== null && !input.spannedHidden) {
    out.push({
      metric: "repaint",
      value: r1(input.repaintMs),
      aux: input.queuedMs === null ? null : r1(input.queuedMs),
      detail: { ...shared, elapsedMs: r1(input.elapsedMs) },
    });
  }
  return out;
}
