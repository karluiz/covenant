import type { EvalUnitSummary } from "../../api";

export interface LiftView {
  label: string;
  sign: "pos" | "neg" | "neutral" | "none";
  pct: number; // lift in percentage points; 0 when sign === "none"
}

export type LiftKind = "earning" | "not-earning" | "unmeasured";
export interface LiftBadge {
  kind: LiftKind;
  text: string;
}

/** A clean A/B needs every eval to carry a baseline. */
function isCleanAB(s: EvalUnitSummary): boolean {
  return s.baseline_total > 0 && s.baseline_total === s.total;
}

/** Lift in percentage points (with% − without%); 0 when the A/B is incomplete. */
function liftPct(s: EvalUnitSummary): number {
  if (!isCleanAB(s)) return 0;
  const withPct = s.total > 0 ? Math.round((s.passed / s.total) * 100) : 0;
  const withoutPct = Math.round((s.baseline_passed / s.baseline_total) * 100);
  return withPct - withoutPct;
}

export function liftRow(s: EvalUnitSummary): LiftView {
  const withPct = s.total > 0 ? Math.round((s.passed / s.total) * 100) : 0;
  if (!isCleanAB(s)) {
    return { label: `${withPct}% · run baseline for lift`, sign: "none", pct: 0 };
  }
  const withoutPct = Math.round((s.baseline_passed / s.baseline_total) * 100);
  const pct = liftPct(s);
  const sign = pct > 0 ? "pos" : pct < 0 ? "neg" : "neutral";
  const arrow = pct > 0 ? "+" : "";
  return {
    label: `${arrow}${pct} pts · ${withPct}% with / ${withoutPct}% without`,
    sign,
    pct,
  };
}

/** Compact "how long ago" for a unit's last eval run. */
export function agoLabel(atMs: number | null | undefined): string {
  if (!atMs) return "";
  const mins = Math.floor((Date.now() - atMs) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Pass-rate delta vs the previous completed run, in points. "" when there is
 *  no previous run or nothing moved. */
export function deltaLabel(s: EvalUnitSummary): string {
  const pt = s.prev_total ?? 0;
  if (pt === 0 || s.total === 0) return "";
  const now = Math.round((s.passed / s.total) * 100);
  const prev = Math.round(((s.prev_passed ?? 0) / pt) * 100);
  const d = now - prev;
  if (d === 0) return "";
  return `${d > 0 ? "+" : ""}${d} pts vs prev`;
}

/** Short row chip for any evaluable unit: authored count + latest verdict.
 *  "no evals" nudges toward Draft evals; "not run" toward Run evals. A stale
 *  count flags verdicts whose latest run timed out or errored. */
export function evalCountLabel(s: EvalUnitSummary | undefined): string {
  const n = s?.authored ?? 0;
  if (n === 0) return "no evals";
  const evals = `${n} eval${n === 1 ? "" : "s"}`;
  if (!s || s.total === 0) return `${evals} · not run`;
  const bits = [evals, `${s.passed}/${s.total} pass`];
  if ((s.stale ?? 0) > 0) bits.push(`${s.stale} stale`);
  const delta = deltaLabel(s);
  if (delta) bits.push(delta);
  const ago = agoLabel(s.last_ran_at_ms);
  if (ago) bits.push(ago);
  return bits.join(" · ");
}

/** Actionable class + short badge text for a skill row (rail + Loop). */
export function liftClass(s: EvalUnitSummary): LiftBadge {
  if (!isCleanAB(s)) return { kind: "unmeasured", text: "no baseline" };
  const pct = liftPct(s);
  if (pct > 0) return { kind: "earning", text: `+${pct} earning` };
  return { kind: "not-earning", text: `${pct} not earning` };
}

/** One-line group verdict: average lift + the names of the ≤0-lift skills. */
export function groupVerdict(rows: EvalUnitSummary[]): string {
  const clean = rows.filter(isCleanAB);
  if (clean.length === 0) return "Run evals with a baseline to measure context lift.";
  const avg = Math.round(clean.map(liftPct).reduce((a, b) => a + b, 0) / clean.length);
  const head = `Context adds ${avg > 0 ? "+" : ""}${avg} pts on average across ${clean.length} skill${clean.length === 1 ? "" : "s"}.`;
  const prune = clean.filter((s) => liftPct(s) <= 0).map((s) => s.name);
  if (prune.length === 0) return head;
  const named = prune.slice(0, 3).join(", ") + (prune.length > 3 ? ", …" : "");
  const verb = prune.length === 1 ? "doesn't earn its" : "don't earn their";
  return `${head} ${named} ${verb} tokens — review.`;
}
