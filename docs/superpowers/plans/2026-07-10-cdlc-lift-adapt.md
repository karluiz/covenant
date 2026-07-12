# CDLC Lift → Adapt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn per-skill Context Lift into an actionable badge on every rail skill row, and make the Loop verdict name the prune candidates — no new commands.

**Architecture:** A shared `liftClass` classifier (`lift.ts`) turns an `EvalSkillSummary` into `{ kind, text }`. The rail fetches `canonEvalSummary` once after rendering and appends a lift chip to each skill card. The Loop's verdict (already calling `groupVerdict`) improves for free once `groupVerdict` names the ≤0-lift skills.

**Tech Stack:** TypeScript (`ui/src/canon/*`, Vitest).

## Global Constraints

- No new backend / Tauri commands. Promote reuses the existing Publish button; prune reuses the existing preview/expand — the lift badge is the whole new surface.
- `earning` = clean A/B (`baseline_total === total && baseline_total > 0`) and lift `> 0`; `not-earning` = clean A/B and lift `≤ 0` (0 included); `unmeasured` = no clean A/B.
- Rail badges fill ASYNC after `canonEvalSummary`; a skill with no eval data simply gets no chip — never blocks the row.
- Only the Skills section is badged (evals attach to skills only).
- TypeScript strict; no `as any` without a comment. No native `element.title` (use attachTooltip). UI copy English.
- Tests from repo ROOT: `npm test`. Never vitest from `ui/`.
- Conventional Commits; stage explicit paths. Worktree `.claude/worktrees/cdlc-lift-adapt` (branch `feat/cdlc-lift-adapt`).
- Known pre-existing unrelated failure: `ui/src/tasker/panel.test.ts` "calendar sets and clears dueDate" — ignore.

---

### Task 1: `liftClass` + prune-naming `groupVerdict` (`lift.ts`)

**Files:**
- Modify: `ui/src/canon/cockpit/lift.ts`
- Test: `ui/src/canon/cockpit/lift.test.ts`

**Interfaces:**
- Produces: `type LiftKind = "earning" | "not-earning" | "unmeasured"`; `interface LiftBadge { kind: LiftKind; text: string }`; `liftClass(s: EvalSkillSummary) -> LiftBadge`; refactored `groupVerdict` that names ≤0-lift skills. Internal `liftPct(s) -> number` shared by `liftRow`/`liftClass`/`groupVerdict`.

- [ ] **Step 1: Write the failing tests**

Add to `ui/src/canon/cockpit/lift.test.ts`:

```typescript
import { liftClass, groupVerdict } from "./lift";

describe("liftClass", () => {
  it("earning for positive clean-A/B lift", () => {
    const b = liftClass({ skill: "kyc", passed: 8, total: 10, baseline_passed: 6, baseline_total: 10 });
    expect(b.kind).toBe("earning");
    expect(b.text).toBe("+20 earning");
  });
  it("not-earning for zero or negative lift", () => {
    expect(liftClass({ skill: "x", passed: 5, total: 10, baseline_passed: 7, baseline_total: 10 }).kind).toBe("not-earning");
    expect(liftClass({ skill: "x", passed: 5, total: 10, baseline_passed: 7, baseline_total: 10 }).text).toBe("-20 not earning");
    expect(liftClass({ skill: "y", passed: 6, total: 10, baseline_passed: 6, baseline_total: 10 }).kind).toBe("not-earning"); // 0 lift
  });
  it("unmeasured when the A/B is incomplete", () => {
    expect(liftClass({ skill: "x", passed: 8, total: 10, baseline_passed: 0, baseline_total: 0 }).kind).toBe("unmeasured");
    expect(liftClass({ skill: "x", passed: 8, total: 10, baseline_passed: 0, baseline_total: 0 }).text).toBe("no baseline");
  });
});

describe("groupVerdict names prune candidates", () => {
  it("names the ≤0-lift skills", () => {
    const v = groupVerdict([
      { skill: "kyc", passed: 8, total: 10, baseline_passed: 6, baseline_total: 10 },   // +20
      { skill: "legacy-x", passed: 5, total: 10, baseline_passed: 7, baseline_total: 10 }, // -20
    ]);
    expect(v).toContain("legacy-x");
    expect(v).toContain("review");
    expect(v).not.toContain("kyc don"); // earning skills are not named as prune candidates
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run (repo ROOT): `npm test -- ui/src/canon/cockpit/lift.test`
Expected: FAIL — `liftClass` not exported; `groupVerdict` doesn't name skills.

- [ ] **Step 3: Add `liftPct` + `liftClass`, refactor `liftRow`/`groupVerdict`**

Rewrite `ui/src/canon/cockpit/lift.ts` so `liftPct` is the single source of the
percentage-point delta, and `liftClass` + the naming verdict build on it:

```typescript
import type { EvalSkillSummary } from "../../api";

export interface LiftView {
  label: string;
  sign: "pos" | "neg" | "neutral" | "none";
  pct: number;
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
  return { label: `${arrow}${pct} pts · ${withPct}% with / ${withoutPct}% without`, sign, pct };
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
```

- [ ] **Step 4: Run to verify they pass**

Run (repo ROOT): `npm test -- ui/src/canon/cockpit/lift.test`
Expected: PASS (new + the existing `liftRow`/`groupVerdict` tests still green — the average/`≤0` behavior is unchanged, only the verdict's tail now names skills).

- [ ] **Step 5: Commit**

```bash
git add ui/src/canon/cockpit/lift.ts ui/src/canon/cockpit/lift.test.ts
git commit -m "feat(canon): liftClass badge classifier + prune-naming group verdict"
```

---

### Task 2: Rail lift badge per skill row (`panel.ts` + CSS)

**Files:**
- Modify: `ui/src/canon/panel.ts` (`liftBadgeEl` helper + async fill in `renderStatus`)
- Modify: `ui/src/canon/styles.css` (`.canon-lift-badge` + `.lift-*` chip colors)
- Test: `ui/src/canon/panel.test.ts`

**Interfaces:**
- Consumes: `liftClass`/`LiftBadge` (Task 1), `canonEvalSummary` (`../api`).
- Produces: `export function liftBadgeEl(b: LiftBadge): HTMLSpanElement`. No `skillCard` signature change — the chip is appended into the existing `.canon-card-head` of each skill row after the eval summary resolves.

- [ ] **Step 1: Write the failing test**

Add to `ui/src/canon/panel.test.ts`:

```typescript
import { liftBadgeEl } from "./panel";
import { liftClass } from "./cockpit/lift";

describe("liftBadgeEl", () => {
  it("builds a not-earning chip for negative lift", () => {
    const el = liftBadgeEl(liftClass({ skill: "x", passed: 5, total: 10, baseline_passed: 7, baseline_total: 10 }));
    expect(el.className).toContain("canon-lift-badge");
    expect(el.className).toContain("lift-not-earning");
    expect(el.textContent).toContain("not earning");
  });
  it("builds an earning chip for positive lift", () => {
    const el = liftBadgeEl(liftClass({ skill: "x", passed: 8, total: 10, baseline_passed: 6, baseline_total: 10 }));
    expect(el.className).toContain("lift-earning");
    expect(el.textContent).toContain("+20");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run (repo ROOT): `npm test -- ui/src/canon/panel.test`
Expected: FAIL — `liftBadgeEl` not exported.

- [ ] **Step 3: Add `liftBadgeEl` + wire the async rail fill (`panel.ts`)**

At the top of `ui/src/canon/panel.ts`, extend the imports:
- add `canonEvalSummary` to the existing `from "../api"` import group;
- add `import { liftClass, type LiftBadge } from "./cockpit/lift";`.

Add the exported chip builder (near `iconButton`):

```typescript
/** A small lift chip for a skill row — `canon-lift-badge lift-<kind>` + short text. */
export function liftBadgeEl(b: LiftBadge): HTMLSpanElement {
  const el = document.createElement("span");
  el.className = `canon-lift-badge lift-${b.kind}`;
  el.textContent = b.text;
  return el;
}
```

In `renderStatus`, in the Skills section: collect each built skill card by name,
then after the section is assembled, fetch the eval summary once and append a lift
chip to each matching card's head. Replace the skills `for (const i of s.installed)`
loop + the `kindSection("Skills", ...)` call with:

```typescript
    const skillCardByName = new Map<string, HTMLElement>();
    for (const i of s.installed) {
      const actions: HTMLButtonElement[] = [];
      if (this.orgs.length > 0 && !i.source.startsWith("registry:")) {
        actions.push(iconButton(Icons.upload({ size: 15 }), "Publish to registry", () => void this.publish(i.name)));
      }
      const runBtn = iconButton(Icons.play({ size: 15 }), "Run evals", () => void this.runEvals(i.name, runBtn));
      actions.push(runBtn);
      const card = skillCard({
        name: i.name,
        meta: `${i.version} · ${i.source}`,
        className: "canon-skill-row",
        fetchPreview: () => (cwd ? canonReadLocal(cwd, i.name) : Promise.resolve("(no project folder)")),
        actions,
        stats: [`v${i.version}`, i.source],
      });
      skillCardByName.set(i.name, card);
      rows.push(card);
    }
    const skills = this.kindSection("Skills", s.installed.length, "No skills installed.", rows);

    // Lift → Adapt: badge each skill row with its context-lift once evals resolve.
    if (cwd && skillCardByName.size > 0) {
      void canonEvalSummary(cwd)
        .then((summary) => {
          for (const es of summary) {
            const card = skillCardByName.get(es.skill);
            card?.querySelector(".canon-card-head")?.appendChild(liftBadgeEl(liftClass(es)));
          }
        })
        .catch(() => {});
    }
```

(Keep the pre-existing "N skills installed" count `<p>` push that precedes the
loop exactly as it is — only the loop body and the post-section fill are new.)

- [ ] **Step 4: Add the chip CSS (`ui/src/canon/styles.css`)**

Append minimal styling (mirror the existing chip/meta treatment in the file):

```css
.canon-lift-badge {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 0;
  border: 1px solid var(--border, rgba(255, 255, 255, 0.14));
  color: var(--fg-dim);
  white-space: nowrap;
}
.canon-lift-badge.lift-earning { color: var(--good, #3fb950); border-color: rgba(63, 185, 80, 0.4); }
.canon-lift-badge.lift-not-earning { color: #e5534b; border-color: rgba(229, 83, 75, 0.4); }
.canon-lift-badge.lift-unmeasured { color: var(--fg-dim); }
```

- [ ] **Step 5: Run to verify the test passes**

Run (repo ROOT): `npm test -- ui/src/canon/panel.test`
Expected: PASS.

- [ ] **Step 6: Build + full canon suite**

Run (repo ROOT): `npm run build && npm test -- ui/src/canon`
Expected: TS compiles clean; canon suite green.

- [ ] **Step 7: Commit**

```bash
git add ui/src/canon/panel.ts ui/src/canon/panel.test.ts ui/src/canon/styles.css
git commit -m "feat(canon): lift badge per skill row in the rail"
```

---

## Final verification

- [ ] `npm run build` (repo ROOT) — clean.
- [ ] `npm test -- ui/src/canon` (repo ROOT) — green (incl. `lift.test` + `panel.test`).
- [ ] Manual smoke (needs a repo with eval results incl. baselines): open the rail → each skill shows a lift chip (`+N earning` green / `N not earning` red / `no baseline`); a ≤0-lift skill reads as a prune candidate next to its existing Publish/preview buttons. Open cockpit → Loop → the verdict now names the ≤0-lift skills.
