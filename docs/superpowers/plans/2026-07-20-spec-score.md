# SpecScore by Covenant — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Score any Covenant spec 0–100 against spec-writing best practices — live in the Spec Creator, as badges in the picker/viewer, embedded in the publish payload, with an optional LLM "deep score" pass.

**Architecture:** One pure TS engine (`ui/src/spec-score/engine.ts`) reusing `parseSectionsFromMarkdown`; a dumb chip+breakdown UI component; three thin integrations (creator, picker/viewer, publish payload); one new Tauri command for the LLM deep score copying the `suggest_title_oneshot` pattern.

**Tech Stack:** TypeScript (strict), Vitest (jsdom, co-located `*.test.ts`, run `npm test` from repo ROOT), Rust/Tauri (`crates/app`), existing `karl_agent::provider::collect_oneshot`.

## Global Constraints

- No new dependencies, frontend or Rust.
- Sharp corners (`border-radius: 0` except 50% dots), inline SVG only (no emoji), no native tooltips (`attachTooltip` if tooltips needed), design tokens per `docs/DESIGN.md`.
- All UI copy in English.
- Conventional Commits; stage files explicitly (never `git add -A` — worktree symlinks node_modules).
- Rust: no `unwrap()` outside tests; `thiserror`/`anyhow` split per AGENTS.md.

---

### Task 1: Scoring engine

**Files:**
- Create: `ui/src/spec-score/engine.ts`
- Test: `ui/src/spec-score/engine.test.ts`

**Interfaces:**
- Consumes: `SECTIONS`, `parseSectionsFromMarkdown` from `ui/src/spec-chat/sections.ts`.
- Produces (later tasks rely on these exact names):
  - `type DimensionKey = 'goal' | 'verifiability' | 'scope' | 'boundaries' | 'complexity' | 'loose_ends' | 'precision'`
  - `type Grade = 'S' | 'A' | 'B' | 'C' | 'D'`
  - `interface DimensionScore { key: DimensionKey; label: string; weight: number; earned: number; findings: string[] }`
  - `interface SpecScore { score: number; grade: Grade; dimensions: DimensionScore[]; deep?: boolean }`
  - `function scoreSpec(md: string | null): SpecScore`
  - `interface DeepAdjustments { adjustments: Partial<Record<DimensionKey, number>>; findings: string[] }`
  - `function applyDeep(base: SpecScore, deep: DeepAdjustments): SpecScore`
  - `function gradeFor(score: number): Grade`

- [ ] **Step 1: Write the failing tests**

```ts
// ui/src/spec-score/engine.test.ts
import { describe, expect, it } from 'vitest';
import { applyDeep, gradeFor, scoreSpec } from './engine';

const GOLDEN = `## Goal

Ship a scoring engine for specs. It runs live in the creator and in the picker.

## Out of scope

- Scoring arbitrary markdown.
- Historical trends.

## Acceptance criteria

- \`scoreSpec\` returns 0-100 plus a grade for any markdown input.
- The picker shows a badge on each published spec row.
- The publish payload includes the score object.

## File boundaries

- \`ui/src/spec-score/engine.ts\` owns all scoring logic.

## Complexity

Low. Pure functions over the existing section parser; no new dependencies.

## Open questions
`;

describe('scoreSpec', () => {
  it('scores a golden spec A or better', () => {
    const s = scoreSpec(GOLDEN);
    expect(s.score).toBeGreaterThanOrEqual(85);
    expect(['S', 'A']).toContain(s.grade);
    expect(s.dimensions).toHaveLength(7);
  });

  it('scores an empty spec D', () => {
    const s = scoreSpec('');
    expect(s.grade).toBe('D');
    expect(s.score).toBeLessThan(50);
  });

  it('null input behaves like empty', () => {
    expect(scoreSpec(null).score).toBe(scoreSpec('').score);
  });

  it('penalizes only goal when goal is missing', () => {
    const md = GOLDEN.replace(/## Goal[\s\S]*?(?=## Out of scope)/, '');
    const s = scoreSpec(md);
    const goal = s.dimensions.find((d) => d.key === 'goal')!;
    expect(goal.earned).toBe(0);
    expect(goal.findings.length).toBeGreaterThan(0);
    const verif = s.dimensions.find((d) => d.key === 'verifiability')!;
    expect(verif.earned).toBe(verif.weight);
  });

  it('flags unverifiable acceptance criteria', () => {
    const md = GOLDEN.replace(
      /## Acceptance criteria[\s\S]*?(?=## File boundaries)/,
      '## Acceptance criteria\n\n- it works well\n- everything behaves properly\n\n',
    );
    const s = scoreSpec(md);
    const verif = s.dimensions.find((d) => d.key === 'verifiability')!;
    expect(verif.earned).toBeLessThan(verif.weight);
    expect(verif.findings.some((f) => f.includes('works well'))).toBe(true);
  });

  it('penalizes empty out-of-scope', () => {
    const md = GOLDEN.replace(/## Out of scope[\s\S]*?(?=## Acceptance)/, '## Out of scope\n\n');
    const scope = scoreSpec(md).dimensions.find((d) => d.key === 'scope')!;
    expect(scope.earned).toBe(0);
  });

  it('rewards real paths in file boundaries', () => {
    const md = GOLDEN.replace(
      /## File boundaries[\s\S]*?(?=## Complexity)/,
      '## File boundaries\n\nSomewhere in the frontend probably.\n\n',
    );
    const b = scoreSpec(md).dimensions.find((d) => d.key === 'boundaries')!;
    expect(b.earned).toBeLessThan(b.weight);
  });

  it('penalizes TBD/TODO anywhere in the doc', () => {
    const s = scoreSpec(GOLDEN + '\nTBD: figure this out\n');
    const loose = s.dimensions.find((d) => d.key === 'loose_ends')!;
    expect(loose.earned).toBeLessThan(loose.weight);
  });

  it('penalizes unresolved open questions', () => {
    const md = GOLDEN.replace(/## Open questions\n/, '## Open questions\n\n- What about Windows?\n');
    const loose = scoreSpec(md).dimensions.find((d) => d.key === 'loose_ends')!;
    expect(loose.earned).toBeLessThan(loose.weight);
  });

  it('penalizes vague wording', () => {
    const md = GOLDEN.replace(
      'Ship a scoring engine for specs.',
      'Maybe we should somehow handle scoring properly, etc.',
    );
    const p = scoreSpec(md).dimensions.find((d) => d.key === 'precision')!;
    expect(p.earned).toBeLessThan(p.weight);
    expect(p.findings.length).toBeGreaterThan(0);
  });
});

describe('gradeFor', () => {
  it('maps thresholds', () => {
    expect(gradeFor(95)).toBe('S');
    expect(gradeFor(85)).toBe('A');
    expect(gradeFor(70)).toBe('B');
    expect(gradeFor(50)).toBe('C');
    expect(gradeFor(49)).toBe('D');
  });
});

describe('applyDeep', () => {
  it('adjusts dimensions, clamps to [0, weight], marks deep', () => {
    const base = scoreSpec(GOLDEN);
    const adjusted = applyDeep(base, {
      adjustments: { goal: -5, precision: +100 },
      findings: ['Goal conflates two outcomes.'],
    });
    const goal = adjusted.dimensions.find((d) => d.key === 'goal')!;
    const baseGoal = base.dimensions.find((d) => d.key === 'goal')!;
    expect(goal.earned).toBe(Math.max(0, baseGoal.earned - 5));
    const p = adjusted.dimensions.find((d) => d.key === 'precision')!;
    expect(p.earned).toBe(p.weight);
    expect(adjusted.deep).toBe(true);
    expect(goal.findings).toContain('Goal conflates two outcomes.');
    expect(base.deep).toBeUndefined(); // base not mutated
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run from repo root: `npx vitest run ui/src/spec-score/engine.test.ts`
Expected: FAIL — cannot resolve `./engine`.

- [ ] **Step 3: Implement the engine**

```ts
// ui/src/spec-score/engine.ts
import { SECTIONS, parseSectionsFromMarkdown } from '../spec-chat/sections';
import type { SpecSectionKey } from '../spec-chat/events';

export type DimensionKey =
  | 'goal'
  | 'verifiability'
  | 'scope'
  | 'boundaries'
  | 'complexity'
  | 'loose_ends'
  | 'precision';

export type Grade = 'S' | 'A' | 'B' | 'C' | 'D';

export interface DimensionScore {
  key: DimensionKey;
  label: string;
  weight: number;
  earned: number;
  findings: string[];
}

export interface SpecScore {
  score: number;
  grade: Grade;
  dimensions: DimensionScore[];
  deep?: boolean;
}

export interface DeepAdjustments {
  adjustments: Partial<Record<DimensionKey, number>>;
  findings: string[];
}

const VAGUE_RE = /\b(should|maybe|somehow|properly|probably|might|hopefully)\b|\betc\.?/gi;
const LOOSE_RE = /\bTBD\b|\bTODO\b|\?{3}/g;
const UNVERIFIABLE_RE = /\b(works? (well|fine|properly|correctly)|good|nice|as expected|properly|correctly)\b/i;
const PATH_RE = /[\w.-]+\/[\w./-]+|\b[\w-]+\.(ts|tsx|js|rs|css|md|json|toml|py|html)\b/;
const BULLET_RE = /^\s*(?:[-*]|\d+[.)])\s+(.*)$/;

export function gradeFor(score: number): Grade {
  if (score >= 95) return 'S';
  if (score >= 85) return 'A';
  if (score >= 70) return 'B';
  if (score >= 50) return 'C';
  return 'D';
}

function sentences(text: string): number {
  return text.split(/[.!?]+(?:\s|$)/).filter((s) => s.trim().length > 0).length;
}

export function scoreSpec(md: string | null): SpecScore {
  const doc = md ?? '';
  const secs = parseSectionsFromMarkdown(doc);
  const body = (k: SpecSectionKey) => secs.get(k)?.markdown.trim() ?? '';
  const dims: DimensionScore[] = [];
  const dim = (key: DimensionKey, label: string, weight: number, earned: number, findings: string[]) =>
    dims.push({ key, label, weight, earned: Math.max(0, Math.min(weight, Math.round(earned))), findings });

  // Goal clarity (20)
  {
    const g = body('goal');
    const findings: string[] = [];
    let earned = 0;
    if (!g) findings.push('Goal section is missing or empty.');
    else {
      earned = 10;
      const n = sentences(g);
      if (n >= 1 && n <= 5) earned += 10;
      else findings.push(n === 0 ? 'Goal has no full sentence.' : `Goal is ${n} sentences — keep it to 1–5.`), (earned += 4);
    }
    dim('goal', 'Goal clarity', 20, earned, findings);
  }

  // Verifiability (25)
  {
    const a = body('acceptance');
    const findings: string[] = [];
    let earned = 0;
    if (!a) findings.push('Acceptance criteria section is missing or empty.');
    else {
      earned = 7;
      const bullets = a
        .split('\n')
        .map((l) => BULLET_RE.exec(l)?.[1]?.trim())
        .filter((b): b is string => !!b);
      if (bullets.length >= 2) earned += 8;
      else findings.push('List at least 2 acceptance criteria as bullets.');
      if (bullets.length > 0) {
        const bad = bullets.filter((b) => b.split(/\s+/).length < 4 || UNVERIFIABLE_RE.test(b));
        earned += (10 * (bullets.length - bad.length)) / bullets.length;
        for (const b of bad.slice(0, 3)) findings.push(`Not verifiable: "${b}"`);
      }
    }
    dim('verifiability', 'Verifiability', 25, earned, findings);
  }

  // Scope discipline (15)
  {
    const s = body('out_of_scope');
    dim('scope', 'Scope discipline', 15, s ? 15 : 0, s ? [] : ['Out of scope is empty — name explicit exclusions.']);
  }

  // Boundaries (10)
  {
    const b = body('file_boundaries');
    const findings: string[] = [];
    let earned = 0;
    if (!b) findings.push('File boundaries section is missing or empty.');
    else {
      earned = 5;
      if (PATH_RE.test(b)) earned += 5;
      else findings.push('File boundaries names no concrete paths.');
    }
    dim('boundaries', 'Boundaries', 10, earned, findings);
  }

  // Complexity honesty (10)
  {
    const c = body('complexity');
    const findings: string[] = [];
    let earned = 0;
    if (!c) findings.push('Complexity section is missing or empty.');
    else {
      earned = 5;
      if (c.length >= 40) earned += 5;
      else findings.push('Complexity is one-word honesty — say why.');
    }
    dim('complexity', 'Complexity honesty', 10, earned, findings);
  }

  // No loose ends (10)
  {
    const findings: string[] = [];
    let earned = 10;
    const oq = body('open_questions');
    if (oq && oq.includes('?')) {
      earned -= 5;
      findings.push('Open questions are unresolved.');
    }
    const loose = doc.match(LOOSE_RE);
    if (loose && loose.length > 0) {
      earned -= 5;
      findings.push(`${loose.length} TBD/TODO marker${loose.length > 1 ? 's' : ''} in the document.`);
    }
    dim('loose_ends', 'No loose ends', 10, earned, findings);
  }

  // Precision (10)
  {
    const findings: string[] = [];
    const matches = doc.match(VAGUE_RE) ?? [];
    const earned = 10 - 2 * matches.length;
    if (matches.length > 0) {
      const unique = [...new Set(matches.map((m) => m.toLowerCase()))];
      findings.push(`Vague wording: ${unique.slice(0, 5).join(', ')}.`);
    }
    dim('precision', 'Precision', 10, earned, findings);
  }

  const score = dims.reduce((acc, d) => acc + d.earned, 0);
  return { score, grade: gradeFor(score), dimensions: dims };
}

/** Apply LLM deep-score adjustments; per-dimension earned clamps to [0, weight].
 *  Deep findings attach once, to the dimension with the largest negative delta. Pure. */
export function applyDeep(base: SpecScore, deep: DeepAdjustments): SpecScore {
  let worst: DimensionKey | null = null;
  let worstDelta = 0;
  for (const [k, v] of Object.entries(deep.adjustments) as [DimensionKey, number][]) {
    if (v < worstDelta) { worstDelta = v; worst = k; }
  }
  const dimensions = base.dimensions.map((d) => {
    const delta = deep.adjustments[d.key] ?? 0;
    const earned = Math.max(0, Math.min(d.weight, d.earned + delta));
    const findings = d.key === worst ? [...d.findings, ...deep.findings] : d.findings;
    return { ...d, earned, findings };
  });
  const score = dimensions.reduce((acc, d) => acc + d.earned, 0);
  return { score, grade: gradeFor(score), dimensions, deep: true };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run ui/src/spec-score/engine.test.ts`
Expected: PASS (all tests). If the golden spec lands below 85, tune ONLY the golden fixture (make its criteria more measurable), never the weights.

- [ ] **Step 5: Type-check and commit**

```bash
npm run build          # tsc + vite — must pass strict
git add ui/src/spec-score/engine.ts ui/src/spec-score/engine.test.ts
git commit -m "feat(spec-score): deterministic scoring engine"
```

---

### Task 2: Badge + breakdown UI component

**Files:**
- Create: `ui/src/spec-score/badge.ts`
- Create: `ui/src/spec-score/spec-score.css`
- Test: `ui/src/spec-score/badge.test.ts`
- Modify: `ui/src/styles.css` — no; instead import the css from `badge.ts` (`import './spec-score.css'` — same pattern as other feature css files like `ui/src/spec-chat/immersive.css`).

**Interfaces:**
- Consumes: `SpecScore`, `DimensionScore` from `./engine`.
- Produces:
  - `function makeSpecScoreChip(): { el: HTMLButtonElement; update(s: SpecScore | null): void; setOnClick(fn: () => void): void }`
  - `function renderBreakdown(s: SpecScore): HTMLElement` — a `.spec-score-breakdown` element with one `.ssd-row` per dimension (bar + findings) callers can append anywhere.
  - `function makeSpecScoreBadge(s: SpecScore): HTMLSpanElement` — tiny inline badge (`.spec-score-badge[data-grade]`, text like `78 B`) for list rows.

- [ ] **Step 1: Write the failing test**

```ts
// ui/src/spec-score/badge.test.ts
import { describe, expect, it } from 'vitest';
import { scoreSpec } from './engine';
import { makeSpecScoreBadge, makeSpecScoreChip, renderBreakdown } from './badge';

describe('spec-score UI', () => {
  const s = scoreSpec('## Goal\n\nDo the thing well and completely.\n');

  it('chip renders score+grade and hides on null', () => {
    const chip = makeSpecScoreChip();
    chip.update(s);
    expect(chip.el.hidden).toBe(false);
    expect(chip.el.textContent).toContain(String(s.score));
    expect(chip.el.textContent).toContain(s.grade);
    expect(chip.el.dataset.grade).toBe(s.grade);
    chip.update(null);
    expect(chip.el.hidden).toBe(true);
  });

  it('chip click fires handler', () => {
    const chip = makeSpecScoreChip();
    let clicked = 0;
    chip.setOnClick(() => clicked++);
    chip.el.click();
    expect(clicked).toBe(1);
  });

  it('breakdown renders one row per dimension with findings', () => {
    const el = renderBreakdown(s);
    expect(el.querySelectorAll('.ssd-row')).toHaveLength(7);
    expect(el.textContent).toContain('Verifiability');
    // width proportional to earned/weight
    const bar = el.querySelector<HTMLElement>('.ssd-fill')!;
    expect(bar.style.width.endsWith('%')).toBe(true);
  });

  it('badge is compact text', () => {
    const b = makeSpecScoreBadge(s);
    expect(b.textContent).toBe(`${s.score} ${s.grade}`);
    expect(b.dataset.grade).toBe(s.grade);
  });
});
```

- [ ] **Step 2: Run to verify failure**

`npx vitest run ui/src/spec-score/badge.test.ts` — FAIL, cannot resolve `./badge`.

- [ ] **Step 3: Implement**

```ts
// ui/src/spec-score/badge.ts
import './spec-score.css';
import type { SpecScore } from './engine';

export function makeSpecScoreChip(): {
  el: HTMLButtonElement;
  update(s: SpecScore | null): void;
  setOnClick(fn: () => void): void;
} {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'spec-score-chip';
  el.hidden = true;
  let onClick: (() => void) | null = null;
  el.addEventListener('click', () => onClick?.());
  return {
    el,
    update(s) {
      if (!s) {
        el.hidden = true;
        return;
      }
      el.hidden = false;
      el.dataset.grade = s.grade;
      el.textContent = '';
      const label = document.createElement('span');
      label.className = 'spec-score-chip-label';
      label.textContent = 'SpecScore';
      const value = document.createElement('span');
      value.className = 'spec-score-chip-value';
      value.textContent = `${s.score} ${s.grade}`;
      el.append(label, value);
    },
    setOnClick(fn) {
      onClick = fn;
    },
  };
}

export function makeSpecScoreBadge(s: SpecScore): HTMLSpanElement {
  const b = document.createElement('span');
  b.className = 'spec-score-badge';
  b.dataset.grade = s.grade;
  b.textContent = `${s.score} ${s.grade}`;
  return b;
}

export function renderBreakdown(s: SpecScore): HTMLElement {
  const root = document.createElement('div');
  root.className = 'spec-score-breakdown';
  for (const d of s.dimensions) {
    const row = document.createElement('div');
    row.className = 'ssd-row';
    const head = document.createElement('div');
    head.className = 'ssd-head';
    const name = document.createElement('span');
    name.className = 'ssd-name';
    name.textContent = d.label;
    const pts = document.createElement('span');
    pts.className = 'ssd-pts';
    pts.textContent = `${d.earned}/${d.weight}`;
    head.append(name, pts);
    const bar = document.createElement('div');
    bar.className = 'ssd-bar';
    const fill = document.createElement('div');
    fill.className = 'ssd-fill';
    fill.style.width = `${Math.round((100 * d.earned) / d.weight)}%`;
    fill.dataset.level = d.earned === d.weight ? 'full' : d.earned >= d.weight / 2 ? 'mid' : 'low';
    bar.append(fill);
    row.append(head, bar);
    for (const f of d.findings) {
      const li = document.createElement('div');
      li.className = 'ssd-finding';
      li.textContent = f;
      row.append(li);
    }
    root.append(row);
  }
  return root;
}
```

```css
/* ui/src/spec-score/spec-score.css */
.spec-score-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 8px;
  border: 1px solid var(--border, rgba(255, 255, 255, 0.12));
  border-radius: 0;
  background: transparent;
  color: var(--fg, #ddd);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}
.spec-score-chip-label {
  opacity: 0.6;
  text-transform: uppercase;
  font-size: 9px;
  letter-spacing: 0.06em;
}
.spec-score-chip-value {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}
.spec-score-badge {
  display: inline-flex;
  padding: 1px 5px;
  border: 1px solid var(--border, rgba(255, 255, 255, 0.12));
  border-radius: 0;
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}
.spec-score-chip[data-grade='S'] .spec-score-chip-value,
.spec-score-badge[data-grade='S'] { color: var(--accent, #7ad); }
.spec-score-chip[data-grade='D'] .spec-score-chip-value,
.spec-score-badge[data-grade='D'] { color: var(--danger, #d66); }

.spec-score-breakdown {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--border, rgba(255, 255, 255, 0.12));
}
.ssd-head {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  margin-bottom: 3px;
}
.ssd-pts {
  opacity: 0.6;
  font-variant-numeric: tabular-nums;
}
.ssd-bar {
  height: 3px;
  background: rgba(128, 128, 128, 0.2);
}
.ssd-fill {
  height: 100%;
  background: var(--accent, #7ad);
}
.ssd-fill[data-level='low'] { background: var(--danger, #d66); }
.ssd-fill[data-level='mid'] { background: var(--warning, #da3); }
.ssd-finding {
  font-size: 10.5px;
  opacity: 0.7;
  margin-top: 3px;
  padding-left: 8px;
  border-left: 2px solid rgba(128, 128, 128, 0.3);
}
```

Before committing: open `ui/src/styles.css` and grep for the ACTUAL token names (`--border`, `--fg`, `--accent`, `--danger`, `--warning` are guesses — replace with the project's real custom-property names, e.g. whatever `.mission-page-badge` at `ui/src/styles.css:13250` uses). Match DESIGN.md tokens exactly; keep the `border-radius: 0`.

- [ ] **Step 4: Run to verify pass**

`npx vitest run ui/src/spec-score/badge.test.ts` — PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/spec-score/badge.ts ui/src/spec-score/badge.test.ts ui/src/spec-score/spec-score.css
git commit -m "feat(spec-score): score chip, list badge, breakdown panel"
```

---

### Task 3: Live chip in the Spec Creator

**Files:**
- Modify: `ui/src/spec-chat/immersive.ts` (right column head ~lines 60-64, `state.onChange` ~lines 120-128)
- Test: extend `ui/src/spec-chat/immersive.test.ts` if it mounts the surface; otherwise add the compose helper test below.

**Interfaces:**
- Consumes: `makeSpecScoreChip`, `renderBreakdown` from `../spec-score/badge`; `scoreSpec` from `../spec-score/engine`; `SECTIONS` from `./sections`; `state.section(key)` + `state.onChange(cb)` from `./stream-state`.
- Produces: `export function composePartialMarkdown(state: Pick<StreamState, 'section'>): string` in `ui/src/spec-chat/stream-state.ts` — composes whatever sections exist (creator scores partial docs; `finalMarkdown()` is null until all sections are done, so it can't be used live).

- [ ] **Step 1: Write the failing test for the compose helper**

```ts
// append to ui/src/spec-chat/stream-state.test.ts
import { composePartialMarkdown } from './stream-state';

describe('composePartialMarkdown', () => {
  it('composes only present sections with canonical headers', () => {
    const sections = new Map([
      ['goal', { markdown: 'Do the thing.', status: 'done' as const }],
      ['acceptance', { markdown: '- it does the thing', status: 'streaming' as const }],
    ]);
    const md = composePartialMarkdown({ section: (k) => sections.get(k) ?? null });
    expect(md).toContain('## Goal\n\nDo the thing.');
    expect(md).toContain('## Acceptance criteria');
    expect(md).not.toContain('## Out of scope');
  });
});
```

(Adapt the `section` return type to the file's actual `SectionView | null` signature — read `stream-state.ts:15-40` first.)

- [ ] **Step 2: Run to verify failure**

`npx vitest run ui/src/spec-chat/stream-state.test.ts` — FAIL on missing export.

- [ ] **Step 3: Implement helper + wire the chip**

In `ui/src/spec-chat/stream-state.ts` (near `rebuildMarkdown`, ~line 55):

```ts
/** Compose whatever sections currently have content — for live scoring of a
 *  partial draft. Unlike finalMarkdown() this never returns null. */
export function composePartialMarkdown(state: Pick<StreamState, 'section'>): string {
  return SECTIONS.map((s) => {
    const v = state.section(s.key);
    const md = v?.markdown?.trim();
    return md ? `## ${s.title}\n\n${md}` : '';
  })
    .filter(Boolean)
    .join('\n\n');
}
```

In `ui/src/spec-chat/immersive.ts`: import chip/engine, mount the chip beside the `Specification` col-head, refresh inside the existing `state.onChange` handler debounced 300ms, toggle an inline breakdown on click:

```ts
import { makeSpecScoreChip, renderBreakdown } from '../spec-score/badge';
import { scoreSpec } from '../spec-score/engine';
import { composePartialMarkdown } from './stream-state';

// in the surface construction, after the col-head element exists:
const chip = makeSpecScoreChip();
colHead.append(chip.el); // the `Specification` header div, lines ~60-64
let breakdownEl: HTMLElement | null = null;
let last: ReturnType<typeof scoreSpec> | null = null;
chip.setOnClick(() => {
  if (breakdownEl) {
    breakdownEl.remove();
    breakdownEl = null;
  } else if (last) {
    breakdownEl = renderBreakdown(last);
    specHost.prepend(breakdownEl); // the .spec-host column
  }
});
let scoreTimer: ReturnType<typeof setTimeout> | undefined;
// inside the existing state.onChange callback (lines ~120-128), add:
clearTimeout(scoreTimer);
scoreTimer = setTimeout(() => {
  last = scoreSpec(composePartialMarkdown(state));
  chip.update(last.score > 0 ? last : null);
  if (breakdownEl && last) {
    const next = renderBreakdown(last);
    breakdownEl.replaceWith(next);
    breakdownEl = next;
  }
}, 300);
```

Adapt variable names to the real ones in `immersive.ts` (read lines 55-130 first). Keep the debounce local — no new state modules.

- [ ] **Step 4: Verify**

`npx vitest run ui/src/spec-chat` — PASS. `npm run build` — type-check clean.

- [ ] **Step 5: Commit**

```bash
git add ui/src/spec-chat/stream-state.ts ui/src/spec-chat/stream-state.test.ts ui/src/spec-chat/immersive.ts
git commit -m "feat(spec-score): live score chip in the spec creator"
```

---

### Task 4: Picker rows + preview breakdown + viewer chip

**Files:**
- Modify: `ui/src/mission/page.ts` — published rows (~lines 411-424), `loadPreview` (~line 228), preview render (~line 531)
- Test: `ui/src/mission/page.test.ts` if it exists (check); otherwise rely on Task 1/2 unit coverage — the integration here is DOM plumbing.

**Interfaces:**
- Consumes: `scoreSpec`, `makeSpecScoreBadge`, `makeSpecScoreChip`, `renderBreakdown`; `draftsApi.readSpecBody(path, maxBytes?)` from `ui/src/drafts/api.ts:42`.
- Produces: nothing new.

- [ ] **Step 1: Published rows get async badges**

In `renderPublishedSection` (~line 385), after the rows render, fill badges asynchronously — one `readSpecBody` per row, capped at 64KB:

```ts
// after rows are in the DOM:
for (const spec of published) {
  const row = container.querySelector<HTMLElement>(`[data-path="${CSS.escape(spec.path)}"] .mission-page-badges`);
  if (!row) continue;
  draftsApi
    .readSpecBody(spec.path, 65536)
    .then(({ body }) => row.append(makeSpecScoreBadge(scoreSpec(body))))
    .catch(() => {}); // ponytail: unreadable spec just shows no badge
}
```

- [ ] **Step 2: Preview pane gets chip + toggleable breakdown**

In `loadPreview` (~line 228), after `this.previewBody` is set, compute `this.previewScore = scoreSpec(this.previewBody)`. In the preview render (~line 531), render the chip + (when toggled) `renderBreakdown(this.previewScore)` above the `renderMarkdown` article. Follow the class's existing render pattern (it re-renders HTML strings vs DOM nodes — read the surrounding code and match it; if the pane is innerHTML-based, mount the chip/breakdown into a placeholder div after render).

- [ ] **Step 3: Viewer modal chip**

In `ui/src/status/bar.ts` `MissionViewerModal.showContent` (~line 2161): when content is a spec (it has the canonical `## Goal` header — test `/^##\s+Goal\s*$/m`), append `makeSpecScoreBadge(scoreSpec(content))` to the modal header element. Chip only, no breakdown here.

- [ ] **Step 4: Verify**

`npm run build` — clean. `npm test` — full suite green.
Manual (deferred to final verify pass): picker shows badges, preview shows breakdown.

- [ ] **Step 5: Commit**

```bash
git add ui/src/mission/page.ts ui/src/status/bar.ts
git commit -m "feat(spec-score): badges in spec picker, breakdown in preview, viewer chip"
```

---

### Task 5: Deep score (LLM pass)

**Files:**
- Create: `ui/src/spec-score/deep.ts`
- Test: `ui/src/spec-score/deep.test.ts`
- Modify: `crates/app/src/summarizer.rs` (new `deep_score_oneshot`, mirror of `suggest_title_oneshot` at line 406)
- Modify: `crates/app/src/lib.rs` (new command `spec_deep_score`, register near `covenant_review::review_publish_spec` at line 5699)
- Modify: `ui/src/api.ts` (wrapper)
- Modify: `ui/src/spec-score/badge.ts` breakdown gets a "Deep score" button (creator + preview reuse it automatically)

**Interfaces:**
- Consumes: `applyDeep`, `DeepAdjustments`, `SpecScore` from `./engine`; Rust `resolve_route(&s, Role::Summary)` + `karl_agent::AskRequest` + `karl_agent::provider::collect_oneshot` (pattern at `summarizer.rs:406-441`).
- Produces:
  - Rust command `spec_deep_score(markdown: String) -> Result<Option<String>, String>` — raw model text, `None` when no Summary route configured.
  - `ui/src/api.ts`: `export function specDeepScore(markdown: string): Promise<string | null>`
  - `ui/src/spec-score/deep.ts`: `export async function deepScore(md: string, base: SpecScore): Promise<SpecScore>` (returns base unchanged on any failure) and `export function parseDeepResponse(raw: string): DeepAdjustments | null` (exported for tests). Content-hash cache in-module.

- [ ] **Step 1: Write the failing TS tests (parse + cache)**

```ts
// ui/src/spec-score/deep.test.ts
import { describe, expect, it } from 'vitest';
import { parseDeepResponse } from './deep';

describe('parseDeepResponse', () => {
  it('parses a clean JSON object', () => {
    const r = parseDeepResponse('{"adjustments":{"goal":-3},"findings":["Goal is two goals."]}');
    expect(r).toEqual({ adjustments: { goal: -3 }, findings: ['Goal is two goals.'] });
  });

  it('extracts JSON from a fenced block', () => {
    const r = parseDeepResponse('Here you go:\n```json\n{"adjustments":{},"findings":[]}\n```');
    expect(r).toEqual({ adjustments: {}, findings: [] });
  });

  it('drops unknown dimension keys and non-numeric deltas', () => {
    const r = parseDeepResponse('{"adjustments":{"goal":-2,"bogus":5,"scope":"x"},"findings":[]}');
    expect(r).toEqual({ adjustments: { goal: -2 }, findings: [] });
  });

  it('returns null on garbage', () => {
    expect(parseDeepResponse('I cannot help with that')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run ui/src/spec-score/deep.test.ts` — FAIL.

- [ ] **Step 3: Implement `deep.ts`**

```ts
// ui/src/spec-score/deep.ts
import { specDeepScore } from '../api';
import { applyDeep, type DeepAdjustments, type DimensionKey, type SpecScore } from './engine';

const KEYS: ReadonlySet<string> = new Set<DimensionKey>([
  'goal', 'verifiability', 'scope', 'boundaries', 'complexity', 'loose_ends', 'precision',
]);

export function parseDeepResponse(raw: string): DeepAdjustments | null {
  const jsonish = /\{[\s\S]*\}/.exec(raw)?.[0];
  if (!jsonish) return null;
  try {
    const obj = JSON.parse(jsonish) as { adjustments?: unknown; findings?: unknown };
    const adjustments: DeepAdjustments['adjustments'] = {};
    if (obj.adjustments && typeof obj.adjustments === 'object') {
      for (const [k, v] of Object.entries(obj.adjustments)) {
        if (KEYS.has(k) && typeof v === 'number' && Number.isFinite(v)) {
          adjustments[k as DimensionKey] = v;
        }
      }
    }
    const findings = Array.isArray(obj.findings) ? obj.findings.filter((f): f is string => typeof f === 'string') : [];
    return { adjustments, findings };
  } catch {
    return null;
  }
}

function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return String(h);
}

const cache = new Map<string, DeepAdjustments>();

/** Deep-score `md`. Returns `base` untouched on any failure (no route, bad JSON, network). */
export async function deepScore(md: string, base: SpecScore): Promise<SpecScore> {
  const key = hash(md);
  const cached = cache.get(key);
  if (cached) return applyDeep(base, cached);
  try {
    const raw = await specDeepScore(md);
    if (!raw) return base;
    const parsed = parseDeepResponse(raw);
    if (!parsed) return base;
    cache.set(key, parsed);
    return applyDeep(base, parsed);
  } catch {
    return base;
  }
}
```

- [ ] **Step 4: Run TS tests** — PASS.

- [ ] **Step 5: Rust command**

In `crates/app/src/summarizer.rs`, after `suggest_title_oneshot` (~line 441):

```rust
const DEEP_SCORE_SYSTEM_PROMPT: &str = "You judge software specs. Given a spec, return ONLY a JSON object: {\"adjustments\":{<dimension>: <integer delta>}, \"findings\": [<string>]}. Dimensions: goal, verifiability, scope, boundaries, complexity, loose_ends, precision. Deltas are small corrections (-10..10) to a heuristic score for problems heuristics miss: semantic ambiguity, contradictions between sections, acceptance criteria that sound testable but are not, goals that hide multiple goals. Findings are short, concrete, and quote the offending text. No prose outside the JSON.";
const DEEP_SCORE_MAX_TOKENS: u32 = 700;

/// One-shot LLM judge for SpecScore's deep pass. Ok(None) when no Summary
/// route is configured. Mirrors [`suggest_title_oneshot`], minus vitals —
/// this call has no owning session.
pub async fn deep_score_oneshot(
    settings: &Arc<Mutex<Settings>>,
    markdown: &str,
) -> Result<Option<String>, String> {
    let text = markdown.trim();
    if text.is_empty() {
        return Ok(None);
    }
    let resolved = {
        let s = settings.lock().await;
        match resolve_route(&s, Role::Summary) {
            Ok(r) => r,
            Err(_) => return Ok(None),
        }
    };
    let req = karl_agent::AskRequest {
        api_key: String::new(),
        model: resolved.model.clone(),
        system_prompt: DEEP_SCORE_SYSTEM_PROMPT.to_string(),
        user_message: format!("# Spec\n\n{text}"),
        max_tokens: DEEP_SCORE_MAX_TOKENS,
        thinking_budget: None,
        force_tool: None,
    };
    let resp = karl_agent::provider::collect_oneshot(&*resolved.provider, req)
        .await
        .map_err(|e| e.to_string())?;
    Ok(Some(resp.text))
}
```

In `crates/app/src/lib.rs` add the command (near the other spec/review commands) and register it in the handler list at ~line 5699:

```rust
#[tauri::command]
async fn spec_deep_score(
    state: tauri::State<'_, AppState>,
    markdown: String,
) -> Result<Option<String>, String> {
    summarizer::deep_score_oneshot(&state.settings, &markdown).await
}
```

(Check how other commands in `lib.rs` access `state.settings` — mirror exactly; `AGENT_TITLE_MAX_TOKENS`'s type tells you the `max_tokens` field type.)

In `ui/src/api.ts` (near `acpSuggestTitle`, ~line 3115):

```ts
export function specDeepScore(markdown: string): Promise<string | null> {
  return invoke<string | null>("spec_deep_score", { markdown });
}
```

- [ ] **Step 6: Deep button in the breakdown**

In `badge.ts`, extend `renderBreakdown` with an optional second arg:

```ts
export function renderBreakdown(s: SpecScore, opts?: { onDeep?: () => void }): HTMLElement
```

When `opts?.onDeep` is present and `!s.deep`, append a footer `<button class="spec-score-deep-btn">Deep score</button>` wired to `onDeep`. When `s.deep`, append a `.spec-score-deep-note` div: `Deep score applied`. Callers (Task 3 creator, Task 4 preview) pass `onDeep: async () => { last = await deepScore(md, last); rerender(); }` with their local rerender. Add to `spec-score.css`:

```css
.spec-score-deep-btn {
  align-self: flex-start;
  padding: 3px 10px;
  border: 1px solid var(--border, rgba(255, 255, 255, 0.12));
  border-radius: 0;
  background: transparent;
  color: inherit;
  font-size: 10.5px;
  cursor: pointer;
}
.spec-score-deep-note { font-size: 10px; opacity: 0.55; }
```

Extend `badge.test.ts`:

```ts
it('breakdown shows deep button when handler given, note when deep applied', () => {
  let called = 0;
  const el = renderBreakdown(s, { onDeep: () => called++ });
  const btn = el.querySelector<HTMLButtonElement>('.spec-score-deep-btn')!;
  btn.click();
  expect(called).toBe(1);
  const deepEl = renderBreakdown({ ...s, deep: true }, { onDeep: () => {} });
  expect(deepEl.querySelector('.spec-score-deep-btn')).toBeNull();
  expect(deepEl.querySelector('.spec-score-deep-note')).not.toBeNull();
});
```

- [ ] **Step 7: Verify**

```
npx vitest run ui/src/spec-score   # PASS
npm run build                       # PASS
cargo check -p covenant-app 2>&1 | tail -5   # or the app crate's real name from crates/app/Cargo.toml — clean
```

- [ ] **Step 8: Commit**

```bash
git add ui/src/spec-score/deep.ts ui/src/spec-score/deep.test.ts ui/src/spec-score/badge.ts ui/src/spec-score/badge.test.ts ui/src/spec-score/spec-score.css ui/src/api.ts crates/app/src/summarizer.rs crates/app/src/lib.rs ui/src/spec-chat/immersive.ts ui/src/mission/page.ts
git commit -m "feat(spec-score): LLM deep-score pass with content-hash cache"
```

---

### Task 6: Score in the publish payload

**Files:**
- Modify: `crates/app/src/covenant_review.rs` — `post_spec` (~line 105), `post_version` (~line 115), `review_publish_spec` (~line 161), `review_republish_spec`
- Modify: `ui/src/review/api.ts:13` — `publish`/`republish` gain a score arg
- Modify: `ui/src/status/bar.ts:1987` — call site computes and passes the score

**Interfaces:**
- Consumes: `scoreSpec` (TS), `draftsApi.readSpecBody`.
- Produces: publish payload field `"spec_score": { score, grade, dimensions: [{key,label,weight,earned,findings}], deep? }` — the forge (separate repo) renders it later; the server tolerates the extra field today.

- [ ] **Step 1: Rust — thread the optional score through**

```rust
// post_spec / post_version gain a param:
async fn post_spec(
    title: &str,
    markdown: &str,
    spec_score: Option<&serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let url = format!("{}/specs", auth::backend_url());
    let mut body = serde_json::json!({ "title": title, "markdown": markdown });
    if let Some(score) = spec_score {
        body["spec_score"] = score.clone();
    }
    send_authed(|j| client().post(&url).bearer_auth(j).json(&body))
        .await?
        .json()
        .await
        .map_err(|e| e.to_string())
}
```

Same shape for `post_version`. `review_publish_spec` and `review_republish_spec` gain `spec_score: Option<serde_json::Value>` (Tauri camelCases it to `specScore` on the wire — confirm against how other multi-word params in this file are invoked from TS) and pass it through.

- [ ] **Step 2: TS — pass the score at publish**

`ui/src/review/api.ts`:

```ts
publish: (path: string, title: string, specScore?: unknown) =>
  invoke<ShareState>("review_publish_spec", { path, title, specScore }),
republish: (path: string, specScore?: unknown) =>
  invoke<ShareState>("review_republish_spec", { path, specScore }),
```

At the call site (`ui/src/status/bar.ts:1987` and the republish call site — grep `reviewApi.republish`):

```ts
const { body } = await draftsApi.readSpecBody(path);
const share = await reviewApi.publish(path, title, scoreSpec(body));
```

- [ ] **Step 3: Verify**

`cargo check` for the app crate — clean. `npm run build` — clean. `npm test` — green.

- [ ] **Step 4: Commit**

```bash
git add crates/app/src/covenant_review.rs ui/src/review/api.ts ui/src/status/bar.ts
git commit -m "feat(spec-score): embed spec score in the publish payload"
```

---

### Final verification (whole feature)

- [ ] `npm test` from repo root — full suite green (note: main has had pre-existing failures before; compare against a baseline run if anything unrelated fails).
- [ ] `cargo check --workspace` (or `cargo test -p <app crate>` — avoid broad `cargo test`, telegram tests hang).
- [ ] `npm run build` — strict TS clean.
- [ ] Out of scope, deliberately skipped (say so in the summary): forge-side rendering of `spec_score` (separate repo), score persistence/trends, publish blocking on low score.
