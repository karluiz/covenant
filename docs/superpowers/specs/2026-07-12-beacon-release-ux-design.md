# Beacon Release UX — Design

Date: 2026-07-12
Status: approved

## Problem

During a release, the Beacon panel (GitHub Actions runs) has three gaps:

1. Tooltips on right-edge controls (Re-run/Cancel) clip off-screen and are unreadable under CSS zoom.
2. A run row only shows aggregate state (`in progress · #195 · v0.9.7 · …`) — no visibility into which job/step is running (build? notarize? cask update?).
3. The titlebar beacon icon is static; there is no ambient signal that a release is running or has failed unless the panel is open.

## 1. Tooltip zoom clamp fix

`ui/src/tooltip/tooltip.ts` `position()` clamps against `window.innerWidth`/`innerHeight` (visual px) while the fixed tooltip's `left/top` are layout px. Under CSS zoom > 1 the clamp oversizes and right-edge tooltips overflow. Same bug class as pane-menu fix `970e45b`.

Fix: `const z = zoom.level()`; divide `rect` coords and viewport dimensions by `z` inside `position()`. No behavior change at zoom 1. `pointerOutside()` compares mouse client coords to `getBoundingClientRect()` — both visual px, already consistent; untouched.

## 2. Run detail — jobs + steps

### Backend (`crates/app/src/beacon.rs`)

New Tauri command:

```rust
beacon_run_jobs(cwd: String, run_id: u64) -> Result<Vec<Job>, String>
```

- `GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs?per_page=50` via existing `gh_get` + `owner_repo_token`.
- One call returns jobs AND their steps.

```rust
pub struct Job {
    pub id: u64,
    pub name: String,
    pub state: String,          // via run_state(status, conclusion)
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub steps: Vec<Step>,
}
pub struct Step {
    pub name: String,
    pub state: String,          // run_state(status, conclusion)
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
}
```

Both derive `Debug, Clone, Serialize`. Reuses existing `run_state()` mapping. Typed wrapper `beaconRunJobs(cwd, runId)` in `ui/src/api.ts`.

### Frontend (`ui/src/beacon/panel.ts`)

- Clicking a run row toggles inline expansion (chevron affordance on the row). **Behavior change:** row click no longer opens github.com; a new `↗` action button (Open on GitHub) joins Re-run/Cancel in `.rail-row-actions`.
- Expansion renders jobs as sub-rows: status dot (reuse `stateDotColor`), job name, duration (`completed_at - started_at`, or elapsed-so-far while running). Steps nest under each job with the same dot + name + duration, smaller type.
- Jobs are fetched on expand; while a run is `busy` and expanded, the existing 25s poll tick re-fetches its jobs. Collapsed runs cost zero extra API calls.
- Expanded-run ids survive re-render (the poll calls `renderBeacon` with `replaceChildren`): panel keeps a `Set<number>` of expanded run ids + a jobs cache keyed by run id, passed into the render.
- Failure: expansion shows an inline error line with the message; no modal.
- Styling in `beacon.css`: sharp corners, `rail-*` vocabulary, True Dark uses neutral lifts.

## 3. Titlebar beacon live indicator

New module `ui/src/beacon/indicator.ts`, started from `main.ts` after the titlebar button exists.

- Polls `beaconWorkflowRuns(cwd)` every 45s when a cwd resolves; skips silently on `not_authed` / `no_repo` / `repos` / `error` states (no icon noise from errors).
- **Pauses while the Beacon panel is open** — the panel's own 25s poll feeds the indicator via a callback, so state stays fresher and nothing double-polls.
- Aggregate state, priority: any `busy` run → `busy`; else any failed run *newer than the last acknowledged failure* → `fail`; else recent success transition → brief `ok` flash (~5s); else quiet.
- Icon classes on `#titlebar-beacon`: `is-busy` (amber pulse), `is-fail` (persistent red), `is-ok` (brief green). Pure CSS; `@media (prefers-reduced-motion: reduce)` swaps pulse for a static tint.
- Opening the panel acknowledges failures (stores newest failed run id; clears `is-fail`).
- cwd source: same `getCwd` used by the panel (active tab); cwd change resets acknowledged state.

## Error handling

- Backend errors keep the existing `"github: <cause> — <remedy>"` shape.
- Jobs fetch failure only affects the expanded row (inline message); list rendering unaffected.
- Indicator never surfaces errors — it goes quiet.

## Testing

- `ui/src/beacon/panel.test.ts`: expansion toggle renders job/step rows; expanded state survives re-render; duration formatting; open-on-GitHub action present; row click no longer calls openUrl.
- `ui/src/beacon/indicator.test.ts`: aggregate-state priority (busy > fail > ok > quiet); failure acknowledgment; pause-while-panel-open.
- `ui/src/tooltip/tooltip.test.ts` (or inline in existing suite): position clamps with mocked zoom level.
- Rust (`beacon.rs` tests): jobs JSON → `Vec<Job>` parsing incl. missing timestamps, step state collapse.
- In-app verify afterward via DOM-dump flow (separate step, noted as pending).

## Out of scope

- Per-step log streaming (GitHub log API + auth complexity — later).
- Notifications/dock badges.
- Watching repos other than the active tab's cwd.
