# Pulse — Metrics Dashboard Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Promote the buried Settings "Metrics" tab into a full-screen, momentum-first dashboard named **Pulse**, re-skinned to the design system, reusing the existing score data layer.

**Architecture:** A new `PulseSurface` full-screen overlay (mirroring `ChangesSurface`) mounts the existing `mountCovenantPage()` renderer. The renderer's `TEMPLATE` is restructured into a hero band + supporting grid, and its `cov-*` CSS is re-skinned from hardcoded mint to design-system tokens. The Settings tab shrinks to a summary strip + "Open Pulse →" button. No backend/data changes.

**Tech Stack:** TypeScript (strict), vanilla DOM, Vite, existing Tauri `score_*` commands via `ui/src/score/api.ts`. CSS in `ui/src/score/styles.css` + a new `ui/src/pulse/styles.css`.

## Global Constraints

- **Design system (`docs/DESIGN.md`) is binding.** Sharp corners (`border-radius: 0`; dots stay `50%`). Semantic color only. No native tooltips (`attachTooltip` only). No hardcoded white/black alpha — compose from `rgba(var(--ink-rgb), …)`. Semantic states use `--ok`/`--fail`/`--running`. True Dark uses neutral lifts, never accent tints.
- **Momentum accent = `--num`** (equals `--running`, amber `#e0af68`). Used for hero numbers, streak, heatmap ramp.
- **Entity bars carry `--group-color`** via `color-mix`, degrading to neutral when unset.
- **English-first copy.** Product name is **Pulse** (surface) / the Settings tab label stays **Metrics**.
- **Full-screen surface rules:** `position: fixed; top: 38px`, inset sidebar + status bar, `border-top` hairline, close on **Escape** + labelled `<kbd class="settings-esc">esc</kbd>`, no × button.
- Run tests from repo ROOT: `npm test`. Typecheck: `cd ui && npx tsc --noEmit`.
- In-app verification: `/respawn` then observe (CSS/DOM changes don't surface in unit tests).

---

## File Structure

- **Create** `ui/src/pulse/index.ts` — `PulseSurface` class: fixed overlay shell, Escape handling, mounts the covenant page into its body.
- **Create** `ui/src/pulse/styles.css` — shell chrome only (frame, header, esc). Imported in `main.ts`.
- **Create** `ui/src/pulse/index.test.ts` — smoke: open/close/Escape.
- **Modify** `ui/src/main.ts` — instantiate `PulseSurface`, ⌘⌥M keybind, titlebar/status entry.
- **Modify** `ui/src/score/page.ts` — restructure `TEMPLATE` into hero + grid; rework `renderStats` (today-vs-baseline); expose `mountCovenantPage` for the surface.
- **Modify** `ui/src/score/styles.css` — re-skin `cov-*` from mint hex to tokens.
- **Modify** `ui/src/settings/panel.ts` — replace the full-page mount with a summary strip + "Open Pulse →".
- **Create** `ui/src/settings/pulse-summary.ts` — renders the Settings summary strip.
- **Create** `ui/src/settings/pulse-summary.test.ts` — smoke: renders streak/today/total without mounting the full page.

---

## Task 1: PulseSurface shell

**Files:**
- Create: `ui/src/pulse/index.ts`
- Create: `ui/src/pulse/styles.css`
- Create: `ui/src/pulse/index.test.ts`

**Interfaces:**
- Consumes: `mountCovenantPage(host: HTMLElement): void` from `ui/src/score/page.ts` (already exported).
- Produces: `class PulseSurface { constructor(host: HTMLElement); get isOpen(): boolean; open(): void; close(): void; }`

- [ ] **Step 1: Write the failing test**

```ts
// ui/src/pulse/index.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// The surface mounts the covenant page; stub it so the test is shell-only.
vi.mock("../score/page", () => ({ mountCovenantPage: vi.fn() }));

import { PulseSurface } from "./index";

describe("PulseSurface", () => {
  beforeEach(() => { document.body.innerHTML = ""; document.body.className = ""; });

  it("opens, mounts a frame, and closes on Escape", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const surface = new PulseSurface(host);

    expect(surface.isOpen).toBe(false);
    surface.open();
    expect(surface.isOpen).toBe(true);
    expect(host.querySelector(".pulse-frame")).not.toBeNull();
    expect(document.body.classList.contains("pulse-fullscreen")).toBe(true);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(surface.isOpen).toBe(false);
    expect(host.innerHTML).toBe("");
    expect(document.body.classList.contains("pulse-fullscreen")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- ui/src/pulse/index.test.ts`
Expected: FAIL — cannot find module `./index`.

- [ ] **Step 3: Write the shell**

```ts
// ui/src/pulse/index.ts
import { mountCovenantPage } from "../score/page";

/// Full-screen "Pulse" metrics surface. Mirrors ChangesSurface
/// (ui/src/changes/index.ts): a fixed overlay below the titlebar that the
/// terminal keeps focus behind, so Escape is captured on the capture phase.
export class PulseSurface {
  private host: HTMLElement;
  private open_ = false;

  private onKey = (e: KeyboardEvent): void => {
    if (this.open_ && e.key === "Escape") { e.preventDefault(); this.close(); }
  };

  constructor(host: HTMLElement) { this.host = host; }

  get isOpen(): boolean { return this.open_; }

  open(): void {
    if (this.open_) return;
    this.open_ = true;
    document.body.classList.add("pulse-fullscreen");
    document.addEventListener("keydown", this.onKey, true);
    this.mountShell();
  }

  close(): void {
    if (!this.open_) return;
    this.open_ = false;
    document.removeEventListener("keydown", this.onKey, true);
    document.body.classList.remove("pulse-fullscreen");
    this.host.innerHTML = "";
  }

  private mountShell(): void {
    this.host.innerHTML = "";
    const frame = document.createElement("div");
    frame.className = "pulse-frame";

    const header = document.createElement("div");
    header.className = "pulse-header";
    const title = document.createElement("span");
    title.className = "pulse-title";
    title.textContent = "Pulse";
    const spacer = document.createElement("span");
    spacer.className = "pulse-header-spacer";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "pulse-close";
    close.setAttribute("aria-label", "Close (Esc)");
    close.innerHTML = `<kbd class="settings-esc">esc</kbd>`;
    close.addEventListener("click", () => this.close());
    header.append(title, spacer, close);

    const body = document.createElement("div");
    body.className = "pulse-body";

    frame.append(header, body);
    this.host.appendChild(frame);
    mountCovenantPage(body);
  }
}
```

- [ ] **Step 4: Write the shell CSS**

```css
/* ui/src/pulse/styles.css — shell chrome only; page internals live in score/styles.css */
.pulse-frame {
  position: fixed;
  top: 38px; left: var(--tabbar-w, 0); right: 0; bottom: var(--statusbar-h, 0);
  z-index: 9000;
  display: flex; flex-direction: column;
  background: var(--bg);
  border-top: 1px solid var(--border);
  overflow: hidden;
}
.pulse-header {
  display: flex; align-items: center; gap: 12px;
  height: 44px; flex: 0 0 44px; padding: 0 18px;
  border-bottom: 1px solid var(--border);
}
.pulse-title {
  font-size: var(--fs-title); font-weight: 700;
  letter-spacing: var(--ls-title); text-transform: uppercase;
  color: var(--num);
}
.pulse-header-spacer { flex: 1; }
.pulse-close { background: transparent; border: 0; cursor: pointer; padding: 0; }
.pulse-body { flex: 1; min-height: 0; overflow-y: auto; padding: 20px 24px; }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- ui/src/pulse/index.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add ui/src/pulse/index.ts ui/src/pulse/styles.css ui/src/pulse/index.test.ts
git commit -m "feat(pulse): full-screen surface shell + escape handling"
```

---

## Task 2: Wire Pulse into main.ts (⌘⌥M + host)

**Files:**
- Modify: `ui/src/main.ts` (near the ChangesSurface wiring, ~line 1730; keybind block ~line 2360)

**Interfaces:**
- Consumes: `PulseSurface` (Task 1).

- [ ] **Step 1: Import the styles and class**

Add near the other surface imports (top of `main.ts`, alongside `import "./tasker/styles.css";`):

```ts
import "./pulse/styles.css";
import { PulseSurface } from "./pulse/index";
```

- [ ] **Step 2: Instantiate the surface**

Add right after the `changesSurface` block (`const changesSurface = new ChangesSurface(changesHost);`, ~line 1735):

```ts
  // Pulse metrics dashboard — ⌘⌥M toggle. Own fixed-overlay host on body.
  const pulseHost = document.createElement("div");
  document.body.appendChild(pulseHost);
  const pulseSurface = new PulseSurface(pulseHost);
```

- [ ] **Step 3: Add the ⌘⌥M keybind**

Add next to the ⌘⌥R (Somnus) binding (~line 2360). On macOS ⌥M emits `µ`, matching the `®`/`˜`/`†` pattern already used:

```ts
    if (e.metaKey && e.altKey && !e.shiftKey && (e.key === "m" || e.key === "M" || e.key === "µ")) {
      e.preventDefault();
      if (pulseSurface.isOpen) { pulseSurface.close(); } else { pulseSurface.open(); }
      return;
    }
```

- [ ] **Step 4: Typecheck**

Run: `cd ui && npx tsc --noEmit`
Expected: no errors referencing `pulse` or `main.ts`.

- [ ] **Step 5: In-app verify**

`/respawn`, then press **⌘⌥M**. Expected: full-screen Pulse surface opens below the titlebar with the existing metrics content; **Escape** and the `esc` chip close it.

- [ ] **Step 6: Commit**

```bash
git add ui/src/main.ts
git commit -m "feat(pulse): ⌘⌥M toggle + surface host wiring"
```

---

## Task 3: Restructure the page TEMPLATE into hero + grid zones

**Files:**
- Modify: `ui/src/score/page.ts:23-69` (the `TEMPLATE` constant)

**Interfaces:**
- Produces: DOM zones `.pulse-hero` (holds `[data-role=filters]`, `[data-role=stats]`, `[data-role=heatmap]`) and `.pulse-grid` (holds the breakdown cards). `refreshInner()` already queries these hosts by `data-role`; only the wrapping structure changes, so no query needs updating except the added wrappers.

- [ ] **Step 1: Replace the TEMPLATE constant**

Replace `ui/src/score/page.ts:23-69` with:

```ts
const TEMPLATE = /* html */ `
  <div class="covenant-page">
    <div class="pulse-hero">
      <div class="pulse-hero-top">
        <div class="cov-stats" data-role="stats"></div>
        <div class="cov-filters" data-role="filters"></div>
      </div>
      <div class="cov-heatmap-card">
        <h4>Activity · last 12 months <span class="hint">click a cell to filter by day</span></h4>
        <div class="cov-heatmap" data-role="heatmap"></div>
        <div class="cov-legend">Less <span class="cov-cell"></span><span class="cov-cell l1"></span><span class="cov-cell l2"></span><span class="cov-cell l3"></span><span class="cov-cell l4"></span> More</div>
      </div>
    </div>
    <div class="pulse-grid">
      <div class="cov-card">
        <h4 data-role="repos-title">By repo <span class="hint">click to drill in</span></h4>
        <div data-role="repos"></div>
        <div class="cov-card-foot">
          <span class="seg-key seg-p"></span> prompts &nbsp; <span class="seg-key seg-c"></span> commits
        </div>
      </div>
      <div class="cov-card">
        <h4 data-role="branches-title">Top branches <span class="hint">pick a repo</span></h4>
        <div data-role="branches"></div>
      </div>
      <div class="cov-card">
        <h4>By group <span class="hint">Covenant tab groups</span></h4>
        <div data-role="groups"></div>
      </div>
      <div class="cov-card">
        <h4>By operator <span class="hint">click to filter</span></h4>
        <div data-role="agents"></div>
      </div>
      <div class="cov-card">
        <h4>Specs</h4>
        <div data-role="specs"></div>
      </div>
      <div class="cov-card">
        <h4>Token usage · per model</h4>
        <div data-role="models"></div>
      </div>
      <div class="cov-card cov-card--wide">
        <h4>Recent sessions</h4>
        <div data-role="sessions"></div>
      </div>
    </div>
    <div class="cov-sync" data-role="sync"></div>
  </div>
`;
```

Note the copy change: **"By agent" → "By operator"** (the `[data-role=agents]` host id is unchanged; only the heading text changes).

- [ ] **Step 2: Typecheck**

Run: `cd ui && npx tsc --noEmit`
Expected: no errors (all `data-role` hosts still present).

- [ ] **Step 3: Add the zone layout CSS**

Append to `ui/src/score/styles.css`:

```css
/* Pulse cockpit zones */
.pulse-hero { display: flex; flex-direction: column; gap: 16px; margin-bottom: 20px; }
.pulse-hero-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.pulse-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 12px; }
.cov-card--wide { grid-column: 1 / -1; }
```

- [ ] **Step 4: In-app verify**

`/respawn`, open Pulse (⌘⌥M). Expected: stats + filter + heatmap in a top band; breakdown cards in a responsive grid below; "By operator" heading; no console errors.

- [ ] **Step 5: Commit**

```bash
git add ui/src/score/page.ts ui/src/score/styles.css
git commit -m "feat(pulse): cockpit layout — hero band + supporting grid"
```

---

## Task 4: Hero stats — today-vs-baseline + momentum accent

**Files:**
- Modify: `ui/src/score/page.ts:274-300` (`renderStats`)

**Interfaces:**
- Consumes: `Summary` (from `../api`): `{ total_prompts, total_commits, today_prompts, today_commits, current_streak, longest_streak, total_tokens, total_specs }`.

- [ ] **Step 1: Rework renderStats**

Replace `renderStats` (`ui/src/score/page.ts:274-300`) with a hero-tile version. The baseline is the average daily prompts over the visible history (`total_prompts / max(current_streak, 1)` as a cheap proxy — see the risk note; refine only if it reads wrong):

```ts
function renderStats(host: HTMLElement, summary: Summary): void {
  const baseline = Math.max(1, Math.round(summary.total_prompts / Math.max(summary.current_streak, 1)));
  const up = summary.today_prompts >= baseline;
  const arrow = summary.today_prompts > 0 ? `<span class="cov-stat-delta ${up ? "is-up" : "is-down"}">${up ? "▲" : "▽"} vs ${baseline}/day</span>` : "";
  host.innerHTML = `
    <div class="cov-stat cov-stat--hero">
      <div class="v">${summary.current_streak}d</div>
      <div class="l">Current streak 🔥</div>
    </div>
    <div class="cov-stat">
      <div class="v">${summary.today_prompts}</div>
      <div class="l">Today ${arrow}</div>
    </div>
    <div class="cov-stat">
      <div class="v">${summary.total_prompts.toLocaleString()}</div>
      <div class="l">Total prompts</div>
    </div>
    <div class="cov-stat">
      <div class="v">${summary.total_commits.toLocaleString()}</div>
      <div class="l">Total commits</div>
    </div>
    <div class="cov-stat">
      <div class="v">${summary.total_tokens.toLocaleString()}</div>
      <div class="l">Total tokens</div>
    </div>
  `;
}
```

- [ ] **Step 2: Typecheck**

Run: `cd ui && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: In-app verify**

`/respawn`, open Pulse. Expected: streak leads (largest tile), Today shows a `▲ vs N/day` delta, numbers legible. (Styling refined in Task 5.)

- [ ] **Step 4: Commit**

```bash
git add ui/src/score/page.ts
git commit -m "feat(pulse): hero stats — streak-led with today-vs-baseline"
```

---

## Task 5: Re-skin `cov-*` CSS to the design system

**Files:**
- Modify: `ui/src/score/styles.css` (the `.cov-*` and `.covenant-page` rules; ~lines 103-400 hold the mint hardcodes)

**Interfaces:** none (pure CSS).

This task replaces every hardcoded mint/teal/slate literal with tokens. Apply these exact mappings across all `.cov-*` rules (use editor find/replace, then verify each rule):

| Hardcoded | Replace with |
|---|---|
| card/stat/chip bg `#131a1e`, `#0f1419` | `var(--bg-elevated)` |
| borders `#1c252b`, `#243036`, `#1a2128` | `var(--border)` |
| mint value text `#5eead4`, `#7dd3e0` | `var(--num)` |
| heatmap fill `#5fe8d6` and ramp | `--num` intensity ramp (Task 6) |
| delta green `#22c55e` | `var(--ok)` |
| body text `#d6e2e6` | `var(--text-primary)` |
| label text `#6c8088`, `#4a5b63` | `var(--muted)` / `var(--text-tertiary)` |
| chip active `#5eead4` / border `#1f4a44` | `var(--num)` / `color-mix(in srgb, var(--num) 30%, transparent)` |

- [ ] **Step 1: Re-skin surfaces + sharp corners**

For every `.cov-card`, `.cov-stat`, `.cov-chip`, `.cov-heatmap-card`: set `background: var(--bg-elevated)`, `border: 1px solid var(--border)`, `border-radius: 0`. Remove any `box-shadow`. Example target state for `.cov-stat`:

```css
.cov-stat {
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 0;
  padding: 14px 16px;
}
.cov-stat .v { font-size: 26px; color: var(--num); font-weight: 500; font-variant-numeric: tabular-nums; }
.cov-stat .l { font-size: var(--fs-micro); letter-spacing: 0.1em; text-transform: uppercase; color: var(--muted); margin-top: 4px; }
.cov-stat--hero .v { font-size: 40px; }
.cov-stat-delta.is-up { color: var(--ok); }
.cov-stat-delta.is-down { color: var(--muted); }
```

- [ ] **Step 2: Re-skin chips**

```css
.cov-chip {
  background: transparent; border: 1px solid var(--border); border-radius: 0;
  color: var(--muted); padding: 5px 10px; font-size: var(--fs-meta); cursor: pointer;
}
.cov-chip:hover { color: var(--text-primary); border-color: rgba(var(--ink-rgb), 0.2); }
.cov-chip.active { color: var(--num); border-color: color-mix(in srgb, var(--num) 30%, transparent); }
.cov-chip .x { color: var(--text-tertiary); margin-left: 4px; }
```

- [ ] **Step 3: Re-skin card headings to the rail scale**

```css
.cov-card h4 {
  font-size: var(--fs-title); font-weight: 600; letter-spacing: var(--ls-title);
  text-transform: uppercase; color: rgba(var(--ink-rgb), 0.42); margin: 0 0 12px;
}
.cov-card h4 .hint { font-size: var(--fs-micro); color: var(--text-tertiary); text-transform: none; letter-spacing: normal; margin-left: 6px; }
```

- [ ] **Step 4: Verify no mint literals remain**

Run: `grep -nE "#5eead4|#5fe8d6|#7dd3e0|#131a1e|#0f1419|#22c55e" ui/src/score/styles.css`
Expected: no matches (or only inside the achievements/profile blocks that are out of scope — confirm each remaining hit is NOT a `.cov-*`/`.covenant-page` rule).

- [ ] **Step 5: In-app verify (both themes + True Dark)**

`/respawn`, open Pulse. Toggle Light and True Dark. Expected: flat token surfaces, sharp corners, amber numbers, no mint, legible in all three modes.

- [ ] **Step 6: Commit**

```bash
git add ui/src/score/styles.css
git commit -m "feat(pulse): re-skin cov-* to design tokens — amber accent, flat, sharp"
```

---

## Task 6: Entity-colored bars + amber heatmap ramp

**Files:**
- Modify: `ui/src/score/breakdowns.ts` (`renderRepoBars`, `renderGroupBars` — bar fill classes)
- Modify: `ui/src/score/styles.css` (bar + heatmap ramp rules)

**Interfaces:**
- `renderGroupBars` rows already have a group identity; set `--group-color` inline per row where the data carries a color, else leave unset (CSS falls back to neutral).

- [ ] **Step 1: Bar fills use group-color with neutral fallback**

In `ui/src/score/styles.css`, the prompt/commit bar segments become:

```css
.seg-p, .bar-prompts { background: color-mix(in srgb, var(--group-color, var(--num)) 55%, transparent); }
.seg-c, .bar-commits { background: color-mix(in srgb, var(--group-color, var(--muted)) 45%, transparent); }
```

In `breakdowns.ts`, where each group/repo row element is created, set the identity color inline if the row datum has one:

```ts
// inside the row-building loop of renderGroupBars / renderRepoBars:
if (row.color) rowEl.style.setProperty("--group-color", row.color);
```

(If the `RepoCell`/`GroupCell` type has no `color` field, skip the repo case and apply only to groups — verify against `ui/src/score/api.ts` type defs; do not invent a field.)

- [ ] **Step 2: Amber heatmap intensity ramp**

Replace the heatmap cell ramp in `ui/src/score/styles.css`:

```css
.cov-cell, .score-cell { border-radius: 0; }
.cov-cell { background: rgba(var(--ink-rgb), 0.05); }
.cov-cell.l1 { background: color-mix(in srgb, var(--num) 22%, transparent); }
.cov-cell.l2 { background: color-mix(in srgb, var(--num) 42%, transparent); }
.cov-cell.l3 { background: color-mix(in srgb, var(--num) 66%, transparent); }
.cov-cell.l4 { background: var(--num); }
```

- [ ] **Step 3: Typecheck**

Run: `cd ui && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: In-app verify**

`/respawn`, open Pulse. Expected: group/repo bars carry their group colors; heatmap is an amber intensity ramp; clicking a cell/bar still drills (filter chips appear).

- [ ] **Step 5: Commit**

```bash
git add ui/src/score/breakdowns.ts ui/src/score/styles.css
git commit -m "feat(pulse): entity-colored bars + amber heatmap ramp"
```

---

## Task 7: Settings "Metrics" tab → summary strip + Open Pulse

**Files:**
- Create: `ui/src/settings/pulse-summary.ts`
- Create: `ui/src/settings/pulse-summary.test.ts`
- Modify: `ui/src/settings/panel.ts:1171-1173` (the Metrics section body) and its mount logic (`mountCovenantOnce`, ~line 210)

**Interfaces:**
- Consumes: `scoreSummaryFiltered({ range: "all" })` → `Summary`.
- Produces: `renderPulseSummary(host: HTMLElement, onOpen: () => void): Promise<void>` — fills `host` with a compact strip and an "Open Pulse →" button wired to `onOpen`.

- [ ] **Step 1: Write the failing test**

```ts
// ui/src/settings/pulse-summary.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../score/api", () => ({
  scoreSummaryFiltered: vi.fn().mockResolvedValue({
    total_prompts: 78293, total_commits: 20365, today_prompts: 727, today_commits: 3,
    current_streak: 58, longest_streak: 58, total_tokens: 327131903, total_specs: 12,
  }),
}));

import { renderPulseSummary } from "./pulse-summary";

describe("renderPulseSummary", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  it("renders streak/today/total and wires Open Pulse", async () => {
    const host = document.createElement("div");
    const onOpen = vi.fn();
    await renderPulseSummary(host, onOpen);
    expect(host.textContent).toContain("58");     // streak
    expect(host.textContent).toContain("727");    // today
    expect(host.textContent).toContain("78,293"); // total prompts
    const btn = host.querySelector<HTMLButtonElement>(".pulse-open-btn")!;
    expect(btn).not.toBeNull();
    btn.click();
    expect(onOpen).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- ui/src/settings/pulse-summary.test.ts`
Expected: FAIL — cannot find module `./pulse-summary`.

- [ ] **Step 3: Implement the summary**

```ts
// ui/src/settings/pulse-summary.ts
import { scoreSummaryFiltered } from "../score/api";

/// Compact Settings strip: keeps the metrics discoverable in Settings while
/// the real home is the full-screen Pulse surface (⌘⌥M).
export async function renderPulseSummary(host: HTMLElement, onOpen: () => void): Promise<void> {
  const s = await scoreSummaryFiltered({ range: "all" });
  host.innerHTML = `
    <div class="pulse-mini">
      <div class="pulse-mini-stat"><b>${s.current_streak}d</b><span>streak</span></div>
      <div class="pulse-mini-stat"><b>${s.today_prompts}</b><span>today</span></div>
      <div class="pulse-mini-stat"><b>${s.total_prompts.toLocaleString()}</b><span>prompts</span></div>
      <div class="pulse-mini-stat"><b>${s.total_commits.toLocaleString()}</b><span>commits</span></div>
      <button type="button" class="pulse-open-btn">Open Pulse →</button>
    </div>
  `;
  host.querySelector<HTMLButtonElement>(".pulse-open-btn")!.addEventListener("click", onOpen);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- ui/src/settings/pulse-summary.test.ts`
Expected: PASS.

- [ ] **Step 5: Add summary CSS**

Append to `ui/src/score/styles.css`:

```css
.pulse-mini { display: flex; align-items: center; gap: 20px; flex-wrap: wrap; padding: 4px 0; }
.pulse-mini-stat { display: flex; flex-direction: column; }
.pulse-mini-stat b { font-size: 20px; color: var(--num); font-weight: 500; font-variant-numeric: tabular-nums; }
.pulse-mini-stat span { font-size: var(--fs-micro); text-transform: uppercase; letter-spacing: 0.1em; color: var(--muted); }
.pulse-open-btn { margin-left: auto; background: var(--bg-panel); border: 1px solid rgba(var(--ink-rgb), 0.1); border-radius: 0; padding: 8px 14px; color: var(--text-primary); font: inherit; font-size: 12px; cursor: pointer; }
.pulse-open-btn:hover { background: rgba(var(--ink-rgb), 0.05); }
```

- [ ] **Step 6: Swap the Settings mount**

In `ui/src/settings/panel.ts`, replace the Metrics section body (`<div id="covenant-page-root"></div>`, ~line 1173) with `<div id="pulse-summary-root"></div>`. Replace `mountCovenantOnce()` (~line 210) so it renders the summary instead of the full page, wiring the button to the Pulse surface via a window event (the surface owns the toggle in `main.ts`):

```ts
  private mountCovenantOnce(): void {
    if (this.covenantMounted) return;
    const root = document.getElementById("pulse-summary-root");
    if (!root) return;
    this.covenantMounted = true;
    void import("./pulse-summary").then((m) =>
      m.renderPulseSummary(root, () => {
        this.close();
        window.dispatchEvent(new CustomEvent("covenant:open-pulse"));
      }),
    );
  }
```

In `ui/src/main.ts`, listen for that event (next to the `pulseSurface` wiring from Task 2):

```ts
  window.addEventListener("covenant:open-pulse", () => { pulseSurface.open(); });
```

- [ ] **Step 7: Typecheck + full test run**

Run: `cd ui && npx tsc --noEmit` then `npm test`
Expected: typecheck clean; all tests pass (existing score tests unaffected).

- [ ] **Step 8: In-app verify**

`/respawn`. Open Settings → Metrics. Expected: a compact stat strip + "Open Pulse →"; clicking it closes Settings and opens the Pulse surface.

- [ ] **Step 9: Commit**

```bash
git add ui/src/settings/pulse-summary.ts ui/src/settings/pulse-summary.test.ts ui/src/settings/panel.ts ui/src/main.ts ui/src/score/styles.css
git commit -m "feat(pulse): Settings Metrics tab → summary strip + Open Pulse"
```

---

## Task 8: Final verification pass

**Files:** none (verification only).

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: all green.

- [ ] **Step 2: Typecheck**

Run: `cd ui && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Manual matrix**

`/respawn`, then verify each: ⌘⌥M opens Pulse; Escape + esc chip close it; hero shows streak-led stats + today delta + heatmap; grid modules render with entity colors; drill-in (click repo/group/cell) filters + shows dismiss chips; Settings→Metrics shows the summary + Open Pulse works. Repeat in Light and True Dark.

- [ ] **Step 4: Commit any polish fixes found, then stop.**

---

## Self-Review Notes

- **Spec coverage:** §1 framing→Tasks 1,2,7; §2 layout→Tasks 3,4; §3 visual→Tasks 5,6; §4 metrics (reuse)→Task 3 hosts unchanged; §5 architecture→Tasks 1,3,7; §6 phasing→task order matches P1–P5; §7 testing→Tasks 1,7 smokes + Task 8.
- **Open questions from the spec** are handled: ⌘⌥M verified free (Task 2); baseline defined as `total/streak` proxy with a refine-if-wrong note (Task 4); heatmap amber ramp (Task 6) with neutral fallback available if it reads warning-like.
- **Data-field risk:** Task 6 Step 1 guards against inventing a `color` field — verify `RepoCell`/`GroupCell` in `api.ts` first and apply only where the field exists.
