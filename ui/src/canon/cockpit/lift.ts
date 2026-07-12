import type { EvalSkillSummary } from "../../api";

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
function isCleanAB(s: EvalSkillSummary): boolean {
  return s.baseline_total > 0 && s.baseline_total === s.total;
}

/** Lift in percentage points (with% − without%); 0 when the A/B is incomplete. */
function liftPct(s: EvalSkillSummary): number {
  if (!isCleanAB(s)) return 0;
  const withPct = s.total > 0 ? Math.round((s.passed / s.total) * 100) : 0;
  const withoutPct = Math.round((s.baseline_passed / s.baseline_total) * 100);
  return withPct - withoutPct;
}

export function liftRow(s: EvalSkillSummary): LiftView {
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

/** Actionable class + short badge text for a skill row (rail + Loop). */
export function liftClass(s: EvalSkillSummary): LiftBadge {
  if (!isCleanAB(s)) return { kind: "unmeasured", text: "no baseline" };
  const pct = liftPct(s);
  if (pct > 0) return { kind: "earning", text: `+${pct} earning` };
  return { kind: "not-earning", text: `${pct} not earning` };
}

/** One-line group verdict: average lift + the names of the ≤0-lift skills. */
export function groupVerdict(rows: EvalSkillSummary[]): string {
  const clean = rows.filter(isCleanAB);
  if (clean.length === 0) return "Run evals with a baseline to measure context lift.";
  const avg = Math.round(clean.map(liftPct).reduce((a, b) => a + b, 0) / clean.length);
  const head = `Context adds ${avg > 0 ? "+" : ""}${avg} pts on average across ${clean.length} skill${clean.length === 1 ? "" : "s"}.`;
  const prune = clean.filter((s) => liftPct(s) <= 0).map((s) => s.skill);
  if (prune.length === 0) return head;
  const named = prune.slice(0, 3).join(", ") + (prune.length > 3 ? ", …" : "");
  const verb = prune.length === 1 ? "doesn't earn its" : "don't earn their";
  return `${head} ${named} ${verb} tokens — review.`;
}
