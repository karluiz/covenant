import type { EvalSkillSummary } from "../../api";

export interface LiftView {
  label: string;
  sign: "pos" | "neg" | "neutral" | "none";
  pct: number; // lift in percentage points; 0 when sign === "none"
}

/** A clean A/B needs every eval to carry a baseline. */
function isCleanAB(s: EvalSkillSummary): boolean {
  return s.baseline_total > 0 && s.baseline_total === s.total;
}

export function liftRow(s: EvalSkillSummary): LiftView {
  const withPct = s.total > 0 ? Math.round((s.passed / s.total) * 100) : 0;
  if (!isCleanAB(s)) {
    return { label: `${withPct}% · run baseline for lift`, sign: "none", pct: 0 };
  }
  const withoutPct = Math.round((s.baseline_passed / s.baseline_total) * 100);
  const pct = withPct - withoutPct;
  const sign = pct > 0 ? "pos" : pct < 0 ? "neg" : "neutral";
  const arrow = pct > 0 ? "+" : "";
  return {
    label: `${arrow}${pct} pts · ${withPct}% with / ${withoutPct}% without`,
    sign,
    pct,
  };
}

/** One-line group verdict over the clean-A/B skills (ignores incomplete ones). */
export function groupVerdict(rows: EvalSkillSummary[]): string {
  const clean = rows.filter(isCleanAB);
  if (clean.length === 0) return "Run evals with a baseline to measure context lift.";
  const lifts = clean.map((s) => liftRow(s).pct);
  const avg = Math.round(lifts.reduce((a, b) => a + b, 0) / lifts.length);
  const nonPos = clean.filter((s) => liftRow(s).pct <= 0).length;
  const head = `Context adds ${avg > 0 ? "+" : ""}${avg} pts on average across ${clean.length} skill${clean.length === 1 ? "" : "s"}.`;
  return nonPos > 0 ? `${head} ${nonPos} show ≤0 lift — prune candidates.` : head;
}
