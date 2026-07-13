# Pulse — Metrics Dashboard Redesign

**Date:** 2026-07-12
**Status:** Design approved, pending spec review
**Surface:** local analytics dashboard (renamed **Metrics → Pulse**)

---

## Problem

The current "Metrics" tab lives buried inside Settings and mounts the full Covenant
score dashboard (`ui/src/score/page.ts`) as a long vertical scroll of equal-weight
cards. Four problems, all in scope for this redesign:

1. **Visual / brand drift** — mint-green on every surface, card-in-card glow, rounded
   corners. Off-brand vs. the "instrument, not app" aesthetic (semantic color only,
   flat surfaces, sharp corners) codified in `docs/DESIGN.md`.
2. **Information architecture** — no hierarchy. Ten cards of equal weight, no story,
   no "what leads."
3. **Framing** — it's a first-class analytics surface trapped in a Settings tab.
4. **Metrics** — the numbers shown aren't deliberately chosen around a primary job.

## Goal

A **full-screen, momentum-first dashboard** named **Pulse** that answers, at a glance:
*"Am I shipping? Am I on a roll?"* — then supports that story with attribution and
delivery breakdowns. On-brand with the design system, reusing the existing score data
layer.

Non-goals for v1: dollar-cost accounting (fast-follow), changing the public Covenant
Score / HUD profile at `forge.covenant.uno/u/<login>` (Pulse is *local* analytics,
distinct from the shareable profile).

---

## 1. Framing & placement

Pulse is promoted out of Settings into a **first-class full-screen surface**, matching
the posture of Changes / Tasker / Canon:

- `position: fixed; top: 38px` (below the titlebar), insets the sidebar (`--tabbar-w`)
  and status bar (`--statusbar-h`), with a `border-top` hairline. Never paints over the
  window controls (DESIGN.md hard rule 11).
- Closes on **Escape** and a labelled `<kbd class="settings-esc">esc</kbd>` affordance.
  **No × close button** (hard rule 10). `esc` returns straight to the terminal.
- Proposed shortcut **⌘⌥M**. Must be verified free against the keymap before wiring; if
  taken, fall back to an unused chord. Also reachable from the Settings summary (below).

The **Settings "Metrics" tab** does not disappear — it shrinks to a compact summary
strip (streak · today · total tokens · total commits) plus an **"Open Pulse →"** button
that launches the full surface. Keeps the metrics discoverable from Settings while
the real home is the dashboard.

## 2. Layout — the cockpit

Two zones inside the full-screen shell.

### Hero band (momentum — the emotional core)
- **Streak** rendered in the momentum accent (amber) with the existing fire mark.
- **Today's pulse**: `+727 ▲` today vs. a baseline (prior-period average), so "today"
  has meaning beyond a raw count.
- **Total tokens** (headline number).
- **The 12-month activity heatmap as the centerpiece**, full-width beneath the stats.
- **Range filter** pinned top-right of the band (all-time / year / etc. — existing
  `ScoreFilter.range`).

### Supporting grid (flat modules, equal weight, sharp corners)
- Row 1: **By repo** · **By group** · **By operator**
- Row 2: **By agent** · **Specs** (completed / failed — delivery) · **Tokens per model**
- **Recent sessions** below.
- **Sync status** in a quiet footer.
- Click-to-drill on any bar filters the whole surface (existing state machine:
  `state.filter.repo / .group_name / .day / .agent`, then `refresh()`).

## 3. Visual system

Replace the mint-green treatment. Aligns with `docs/DESIGN.md`:

- **Surfaces** — flat `--bg` / `--bg-elevated`, 1px `--border` hairlines,
  **`border-radius: 0`** everywhere (dots stay `50%`). No card-in-card gradients,
  no drop-shadow depth theater. Elevation = surface tone.
- **Momentum accent = `--num` (= `--running`, amber `#e0af68`)** — the token is defined
  as "numeric / token-count emphasis," so it fits the hero numbers and streak natively.
  Used for hero stats, streak, and the heatmap intensity ramp.
- **Entity bars carry their own color** — repos / groups / operators derive fills from
  `--group-color` via `color-mix(in srgb, var(--group-color) N%, transparent)`, the app's
  one sanctioned decorative color. Ungrouped contexts degrade to neutral.
- **Heatmap** — single-hue intensity ramp (amber via `--num`), not the current mint;
  five levels composed with `color-mix`. Keeps the "Less → More" legend.
- **Typography** — module heads uppercase at `--fs-title` + `--ls-title`; numbers and
  paths in the mono stack; body at `--fs-body`. Three tiers max per view.
- **True Dark** — neutral lifts for elevated surfaces, never accent tints (hard rule 4).
- No native tooltips (`attachTooltip` only); no hardcoded white/black alphas (compose
  from `--ink-rgb`); semantic states use `--ok`/`--fail`/`--running` (hard rules 1, 3, 9).

## 4. Metric set (v1)

Reuse the existing `api.score*` queries — **no new backend for v1**:

| Module | Source | Notes |
|---|---|---|
| Streak / today / totals | `scoreSummaryFiltered` | Hero stats |
| Activity heatmap | `scoreHeatmapFiltered` | Centerpiece |
| By repo | `scoreBreakdownRepos` | Drill → branches |
| Top branches | `scoreBreakdownBranches` | Shown when a repo is drilled |
| By group | `scoreBreakdownGroups` | Tab groups |
| By operator / agent | `scoreBreakdownAgents` | Attribution |
| Specs | `scoreBreakdownSpecs` | Completed / failed (delivery) |
| Tokens per model | (existing models query) | **Tokens only** in v1 |
| Recent sessions | `scoreRecentSessions` | |
| Sync status | `scoreSyncStatus` | Quiet footer |

**Cost = tokens only in v1.** Dollar cost needs a per-model price table that does not
exist yet — deferred to its own fast-follow spec.

## 5. Architecture

`score/page.ts` already fetches all data in one `Promise.all` and delegates rendering to
pure functions in `breakdowns.ts` (`renderRepoBars`, `renderGroupBars`, `renderBranchList`,
`renderGroupBars`, `renderSessions`) and `usage.ts` (`renderAgentBars`, `renderSpecsCard`,
`renderModelsCard`). The redesign is a **re-layout + re-skin, not a rewrite**:

- **(a) Full-screen shell** — new surface component (mirror Changes/Tasker): fixed
  overlay, Escape handling, `esc` affordance, sidebar/status insets. Mounts the Pulse
  page into its body.
- **(b) Restructure `TEMPLATE`** — split the flat card list into `hero` + `grid` zones;
  move stats + heatmap into the hero, group the breakdowns into the supporting grid.
  The `refresh()` / drill-in state machine and error boundary are untouched.
- **(c) New CSS namespace** (`pulse-*` or re-skin `cov-*`) aligned to the design system.
  The `render*` functions emit the same DOM; the CSS around them changes. Where a render
  fn hardcodes mint or radii, adjust the fn's classes (not its logic).
- **(d) Settings tab** — replace the mounted full page with a compact summary strip
  (`scoreSummaryFiltered`) + "Open Pulse →" button that triggers the shell.

Reused as-is: range filter, drill-in filtering, `cov-error-banner` boundary,
prompt-cache-free data fetching.

## 6. Scope & phasing

One spec, phased so each phase is independently shippable and verifiable:

- **P1** — Full-screen Pulse shell + promote the mount out of Settings (shortcut,
  Escape, insets). Content still the old layout at first — just relocated.
- **P2** — Hero band (streak / today-vs-baseline / totals + heatmap centerpiece).
- **P3** — Supporting grid: restructure + re-skin the breakdown modules to the design
  system (flat, sharp, entity-colored bars).
- **P4** — Settings "Metrics" tab → summary strip + "Open Pulse →".
- **P5** — Heatmap / dataviz polish (amber intensity ramp, legend, spacing).

## 7. Testing

- Keep existing `score/*.test.ts` green (repo attribution, leaderboard) — the data layer
  is unchanged.
- Add a smoke test: the Pulse shell opens and closes on Escape; the Settings summary
  strip renders streak/today/total without mounting the full page.
- In-app verification per phase (respawn + observe), since layout/skin changes don't show
  up in unit tests.

## Open questions / risks

- **Shortcut collision** — ⌘⌥M must be confirmed free; pick a fallback chord if not.
- **"Today vs. baseline"** — needs a baseline definition (prior-period average vs.
  personal best vs. simple prior-day). Default: prior-period average over the active
  range; confirm during P2.
- **Heatmap hue** — amber (`--num`) is the default; if it reads too "warning-like" next
  to `--running` usage elsewhere, fall back to a neutral intensity ramp. Decide in P5.
