# Beacon Release UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix zoom-clipped tooltips, add expandable jobs+steps detail to Beacon run rows, and make the titlebar beacon icon a live release indicator.

**Architecture:** Tooltip clamp math moves to a pure layout-px function divided by `zoom.level()`. Run detail adds one backend command (`beacon_run_jobs` → GitHub `/actions/runs/{id}/jobs`) and inline expansion state in `BeaconPanel`. The indicator is a small poller module fed by the panel's own poll while the panel is open.

**Tech Stack:** Rust (reqwest, serde) + Tauri command; TypeScript (vanilla DOM, vitest/jsdom).

Spec: `docs/superpowers/specs/2026-07-12-beacon-release-ux-design.md`

## Global Constraints

- Worktree: all edits in `.claude/worktrees/beacon-release-ux`. Stage files explicitly — NEVER `git add -A` (node_modules symlinks).
- Run vitest from repo ROOT (`npm test -- --run <path>`), not `ui/`.
- Sharp corners (`border-radius: 0`) on any new UI; no native `title=` attributes — use `attachTooltip` from `ui/src/tooltip/tooltip.ts`.
- English-only UI copy. Conventional Commits, end commit messages with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Rust: no `unwrap()` outside tests; new structs derive `Debug, Clone, Serialize`.
- Pre-existing baseline failures (do not chase): `ui/notch/store.test.ts`, `ui/src/teammate/task-card.test.ts`, `ui/src/tasker/panel.test.ts`, `ui/src/settings/operators.test.ts`, `ui/src/spec-chat/index.test.ts`, and all `landing/` suites (env).

---

### Task 1: Tooltip zoom clamp fix

**Files:**
- Modify: `ui/src/tooltip/tooltip.ts` (function `position`, ~line 83)
- Test: `ui/src/tooltip/tooltip.test.ts` (create)

**Interfaces:**
- Produces: `computeTooltipPos(rect, tw, th, z, visualVw, visualVh) -> { top, left, below }` exported from `tooltip.ts` (layout-px result). No other task consumes it; it exists for testability.

- [ ] **Step 1: Write the failing test**

Create `ui/src/tooltip/tooltip.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { computeTooltipPos } from "./tooltip";

const rect = (left: number, top: number, w: number, h: number) => ({
  left,
  top,
  width: w,
  bottom: top + h,
});

describe("computeTooltipPos", () => {
  it("centers above the target at zoom 1", () => {
    const p = computeTooltipPos(rect(500, 300, 40, 20), 100, 30, 1, 1200, 800);
    expect(p.below).toBe(false);
    expect(p.left).toBe(500 + 20 - 50); // target center minus half tooltip
    expect(p.top).toBe(300 - 30 - 8);
  });

  it("flips below when there is no room above", () => {
    const p = computeTooltipPos(rect(500, 10, 40, 20), 100, 30, 1, 1200, 800);
    expect(p.below).toBe(true);
    expect(p.top).toBe(30 + 8);
  });

  it("clamps to the right edge at zoom 1", () => {
    const p = computeTooltipPos(rect(1180, 300, 20, 20), 120, 30, 1, 1200, 800);
    expect(p.left + 120).toBeLessThanOrEqual(1200 - 8);
  });

  it("clamps to the LAYOUT viewport under zoom > 1", () => {
    // Visual viewport 1200px at zoom 1.5 → layout viewport is 800px.
    // A target hugging the visual right edge (rect in visual px).
    const p = computeTooltipPos(rect(1160, 300, 30, 20), 120, 30, 1.5, 1200, 800);
    // Tooltip must fit inside the 800px layout viewport, not the 1200px visual one.
    expect(p.left + 120).toBeLessThanOrEqual(1200 / 1.5 - 8);
    expect(p.left).toBeGreaterThanOrEqual(8);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run ui/src/tooltip/tooltip.test.ts`
Expected: FAIL — `computeTooltipPos` is not exported.

- [ ] **Step 3: Implement**

In `ui/src/tooltip/tooltip.ts`:

Add import at top:

```ts
import { zoom } from "../zoom";
```

Add the pure function above `position()`:

```ts
/// Pure clamp math in LAYOUT px. `rect` comes from getBoundingClientRect(),
/// which WebKit reports in visual (zoomed) px, while a fixed element's
/// left/top are layout px — so everything is divided by the zoom level
/// (same semantics as the pane-menu fix, manager.ts / 970e45b).
export function computeTooltipPos(
  rect: { top: number; bottom: number; left: number; width: number },
  tw: number,
  th: number,
  z: number,
  visualVw: number,
  visualVh: number,
): { top: number; left: number; below: boolean } {
  const rTop = rect.top / z;
  const rBottom = rect.bottom / z;
  const rLeft = rect.left / z;
  const rWidth = rect.width / z;
  const vw = visualVw / z;
  const vh = visualVh / z;
  const below = rTop < th + EDGE_PAD + 8;
  let top = below ? rBottom + 8 : rTop - th - 8;
  let left = rLeft + rWidth / 2 - tw / 2;
  if (left < EDGE_PAD) left = EDGE_PAD;
  if (left + tw > vw - EDGE_PAD) left = vw - EDGE_PAD - tw;
  if (top < EDGE_PAD) top = EDGE_PAD;
  if (top + th > vh - EDGE_PAD) top = vh - EDGE_PAD - th;
  return { top, left, below };
}
```

Replace the body of `position()` (keep the measure/restore lines):

```ts
function position(target: HTMLElement): void {
  const el = ensureHost();
  const rect = target.getBoundingClientRect();
  // Measure
  el.style.visibility = "hidden";
  el.style.display = "block";
  const tw = el.offsetWidth;
  const th = el.offsetHeight;
  const pos = computeTooltipPos(rect, tw, th, zoom.level(), window.innerWidth, window.innerHeight);
  el.style.top = `${Math.round(pos.top)}px`;
  el.style.left = `${Math.round(pos.left)}px`;
  el.classList.toggle("ck-tooltip--below", pos.below);
  el.style.visibility = "";
}
```

Note: `pointerOutside()` compares mouse client coords to `getBoundingClientRect()` — both visual px, already consistent. Leave untouched.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --run ui/src/tooltip/tooltip.test.ts`
Expected: PASS (4 tests).

If importing `../zoom` at module scope breaks other suites that import tooltip.ts (zoom.ts touches localStorage at init), check `npm test -- --run ui/src` for NEW failures only; jsdom provides localStorage so this is unlikely.

- [ ] **Step 5: Commit**

```bash
git add ui/src/tooltip/tooltip.ts ui/src/tooltip/tooltip.test.ts
git commit -m "fix(tooltip): clamp to layout viewport under CSS zoom

getBoundingClientRect and window.inner* report visual px, but the fixed
tooltip's left/top are layout px — at zoom > 1 the clamp oversized and
right-edge tooltips (Beacon re-run/cancel) clipped off-screen. Same bug
class as the pane-menu fix (970e45b).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Backend — `beacon_run_jobs` command

**Files:**
- Modify: `crates/app/src/beacon.rs` (add `Job`, `Step`, `parse_jobs`, `run_jobs`; tests in existing `mod tests`)
- Modify: `crates/app/src/lib.rs` (command fn near line 2340; register near line 4750)
- Modify: `ui/src/api.ts` (types + wrapper after `beaconCancelWorkflow`, ~line 1388)

**Interfaces:**
- Consumes: existing `owner_repo_token`, `gh_get`, `run_state` in beacon.rs.
- Produces:
  - Rust: `pub async fn run_jobs(cwd: String, run_id: u64) -> Result<Vec<Job>, String>`; `pub fn parse_jobs(v: &serde_json::Value) -> Vec<Job>`; `Job { id: u64, name: String, state: String, started_at: Option<String>, completed_at: Option<String>, steps: Vec<Step> }`; `Step { name: String, state: String, started_at: Option<String>, completed_at: Option<String> }`.
  - TS: `beaconRunJobs(cwd: string, runId: number): Promise<BeaconJob[]>`; `BeaconJob = { id: number; name: string; state: string; started_at: string | null; completed_at: string | null; steps: BeaconStep[] }`; `BeaconStep = { name: string; state: string; started_at: string | null; completed_at: string | null }`.

- [ ] **Step 1: Write the failing test**

Append inside `mod tests` in `crates/app/src/beacon.rs`:

```rust
    #[test]
    fn parses_jobs_payload_with_steps() {
        let v: serde_json::Value = serde_json::json!({
            "jobs": [
                {
                    "id": 101,
                    "name": "build-sign-notarize",
                    "status": "in_progress",
                    "conclusion": null,
                    "started_at": "2026-07-12T18:00:00Z",
                    "completed_at": null,
                    "steps": [
                        { "name": "Checkout", "status": "completed", "conclusion": "success",
                          "started_at": "2026-07-12T18:00:01Z", "completed_at": "2026-07-12T18:00:03Z" },
                        { "name": "Notarize", "status": "in_progress", "conclusion": null,
                          "started_at": "2026-07-12T18:03:00Z", "completed_at": null }
                    ]
                },
                {
                    "id": 102,
                    "name": "update-cask",
                    "status": "queued",
                    "conclusion": null,
                    "started_at": null,
                    "completed_at": null
                    // no "steps" key at all — queued jobs omit it
                }
            ]
        });
        let jobs = parse_jobs(&v);
        assert_eq!(jobs.len(), 2);
        assert_eq!(jobs[0].id, 101);
        assert_eq!(jobs[0].state, "in_progress");
        assert_eq!(jobs[0].completed_at, None);
        assert_eq!(jobs[0].steps.len(), 2);
        assert_eq!(jobs[0].steps[0].state, "success");
        assert_eq!(jobs[0].steps[1].state, "in_progress");
        assert_eq!(jobs[0].steps[1].completed_at, None);
        assert_eq!(jobs[1].state, "queued");
        assert!(jobs[1].steps.is_empty());
    }

    #[test]
    fn parse_jobs_tolerates_garbage() {
        assert!(parse_jobs(&serde_json::json!({})).is_empty());
        assert!(parse_jobs(&serde_json::json!({ "jobs": "nope" })).is_empty());
        // A job missing its id is skipped, not a panic.
        let v = serde_json::json!({ "jobs": [ { "name": "x" } ] });
        assert!(parse_jobs(&v).is_empty());
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p karl-app beacon -- --nocapture` (use the crate name from `crates/app/Cargo.toml` if different; check with `rg '^name' crates/app/Cargo.toml`)
Expected: compile FAIL — `parse_jobs` not found.

- [ ] **Step 3: Implement in beacon.rs**

Add after the `SubRepo` struct (~line 36):

```rust
/// One job of a workflow run, with its steps — the expandable detail
/// behind a Beacon run row.
#[derive(Debug, Clone, Serialize)]
pub struct Job {
    pub id: u64,
    pub name: String,
    /// Collapsed state token (see `run_state`).
    pub state: String,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub steps: Vec<Step>,
}

/// One step of a job.
#[derive(Debug, Clone, Serialize)]
pub struct Step {
    pub name: String,
    pub state: String,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
}
```

Add after `cancel_workflow_run` (~line 146):

```rust
/// Parse the GitHub jobs-for-run payload into UI-shaped jobs. Queued jobs
/// omit `steps`; in-flight steps have null conclusion/completed_at.
pub fn parse_jobs(v: &serde_json::Value) -> Vec<Job> {
    let Some(arr) = v.get("jobs").and_then(|j| j.as_array()) else {
        return Vec::new();
    };
    arr.iter()
        .filter_map(|j| {
            let id = j.get("id")?.as_u64()?;
            let steps = j
                .get("steps")
                .and_then(|s| s.as_array())
                .map(|arr| {
                    arr.iter()
                        .map(|s| Step {
                            name: s.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                            state: run_state(
                                s.get("status").and_then(|x| x.as_str()).unwrap_or(""),
                                s.get("conclusion").and_then(|x| x.as_str()),
                            ),
                            started_at: s.get("started_at").and_then(|x| x.as_str()).map(str::to_string),
                            completed_at: s.get("completed_at").and_then(|x| x.as_str()).map(str::to_string),
                        })
                        .collect()
                })
                .unwrap_or_default();
            Some(Job {
                id,
                name: j.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                state: run_state(
                    j.get("status").and_then(|x| x.as_str()).unwrap_or(""),
                    j.get("conclusion").and_then(|x| x.as_str()),
                ),
                started_at: j.get("started_at").and_then(|x| x.as_str()).map(str::to_string),
                completed_at: j.get("completed_at").and_then(|x| x.as_str()).map(str::to_string),
                steps,
            })
        })
        .collect()
}

/// Jobs + steps for one workflow run.
pub async fn run_jobs(cwd: String, run_id: u64) -> Result<Vec<Job>, String> {
    let (owner, repo, token) = owner_repo_token(&cwd).await?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("http client init failed: {e}"))?;
    let url = format!(
        "https://api.github.com/repos/{owner}/{repo}/actions/runs/{run_id}/jobs?per_page=50"
    );
    let body = gh_get(&client, &token, &url).await?;
    Ok(parse_jobs(&body))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p <app-crate-name> beacon`
Expected: PASS (existing 2 + new 2 tests).

- [ ] **Step 5: Register the Tauri command**

In `crates/app/src/lib.rs`, after `beacon_cancel_workflow` (~line 2342):

```rust
#[tauri::command]
async fn beacon_run_jobs(cwd: String, run_id: u64) -> Result<Vec<beacon::Job>, String> {
    beacon::run_jobs(cwd, run_id).await
}
```

And add `beacon_run_jobs,` to the `generate_handler![...]` list right after `beacon_cancel_workflow,` (~line 4750).

Run: `cargo check -p <app-crate-name>`
Expected: clean.

- [ ] **Step 6: TS API wrapper**

In `ui/src/api.ts`, after `beaconCancelWorkflow` (~line 1388):

```ts
export type BeaconStep = {
  name: string;
  state: string; // success | failure | in_progress | queued | ...
  started_at: string | null;
  completed_at: string | null;
};

export type BeaconJob = {
  id: number;
  name: string;
  state: string;
  started_at: string | null;
  completed_at: string | null;
  steps: BeaconStep[];
};

export async function beaconRunJobs(cwd: string, runId: number): Promise<BeaconJob[]> {
  return invoke<BeaconJob[]>("beacon_run_jobs", { cwd, runId });
}
```

Run: `npm run build` (type-check)
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add crates/app/src/beacon.rs crates/app/src/lib.rs ui/src/api.ts
git commit -m "feat(beacon): beacon_run_jobs command — jobs + steps for a run

GET /actions/runs/{id}/jobs via the existing gh_get/owner_repo_token
plumbing; one call returns jobs and their steps. parse_jobs is pure and
regression-tested (queued jobs omit steps; in-flight steps have null
conclusion).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Panel — expandable run rows (jobs + steps)

**Files:**
- Modify: `ui/src/beacon/panel.ts`
- Modify: `ui/src/icons/index.ts` (add `externalLink` icon)
- Modify: `ui/src/beacon/beacon.css` (job/step sub-row styles)
- Test: `ui/src/beacon/panel.test.ts` (extend + update one existing test)

**Interfaces:**
- Consumes: `beaconRunJobs`, `BeaconJob` from `../api` (Task 2); `Icons.chevronRight`, new `Icons.externalLink`.
- Produces (consumed by Task 4):
  - `renderBeacon(root, state, onPick?, errorActions?, runActions?, detail?)` — new optional 6th param `detail: RunDetail`.
  - `export type RunDetailState = { kind: "loading" } | { kind: "error"; message: string } | { kind: "jobs"; jobs: BeaconJob[] }`.
  - `export type RunDetail = { expanded: ReadonlySet<number>; jobs: ReadonlyMap<number, RunDetailState>; onToggle: (runId: number) => void }`.
  - `export function fmtDuration(startIso: string | null, endIso: string | null, now?: number): string`.
  - `export function stateSpine(state: string): string` (currently private — export it).
  - `BeaconPanel` constructor opts gain `onState?: (state: BeaconState) => void` (fired after every successful poll — Task 4's indicator feed).
- **Behavior change:** clicking a run row toggles expansion; opening github.com moves to a `↗` action button.

- [ ] **Step 1: Add the externalLink icon**

In `ui/src/icons/index.ts`, after `chevronsDownUp` (~line 270):

```ts
  /** External link — arrow escaping a box. Beacon "open on GitHub". */
  externalLink: (o?: IconOptions): string =>
    svg(
      `<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h6"/>`,
      o,
    ),
```

- [ ] **Step 2: Write the failing tests**

In `ui/src/beacon/panel.test.ts`:

Add to the imports:

```ts
import { renderBeacon, renderLoading, stateDotColor, isHttpUrl, fmtDuration } from "./panel";
import type { RunDetail, RunDetailState } from "./panel";
import type { BeaconState, BeaconJob } from "../api";
```

REPLACE the existing test `"produces a clickable row for an https:// url"` (line ~201) with:

```ts
  it("opens the run URL via the ↗ action button, not the row", () => {
    const state: BeaconState = {
      kind: "ok",
      repo: "o/r",
      runs: [run({ url: "https://github.com/o/r/actions/runs/1" })],
    };
    renderBeacon(root, state, undefined, undefined, { onRerun: vi.fn(), onCancel: vi.fn() });
    const btn = root.querySelector<HTMLButtonElement>('[aria-label="Open on GitHub"]');
    expect(btn).not.toBeNull();
    btn!.click();
    expect(openUrl).toHaveBeenCalledWith("https://github.com/o/r/actions/runs/1");
  });
```

(If the file has no `run(...)` helper, add one near the top of the `renderBeacon` describe:)

```ts
  const run = (over: Partial<import("../api").BeaconRun> = {}): import("../api").BeaconRun => ({
    id: 1,
    name: "Release macOS",
    state: "success",
    run_number: 195,
    branch: "main",
    sha: "da34d4b",
    actor: "karluiz",
    url: null,
    updated_at: new Date().toISOString(),
    ...over,
  });
```

Add a new describe block:

```ts
describe("fmtDuration", () => {
  it("formats seconds, minutes, hours", () => {
    const t0 = "2026-07-12T18:00:00Z";
    expect(fmtDuration(t0, "2026-07-12T18:00:41Z")).toBe("41s");
    expect(fmtDuration(t0, "2026-07-12T18:03:10Z")).toBe("3m10s");
    expect(fmtDuration(t0, "2026-07-12T19:05:00Z")).toBe("1h5m");
  });

  it("uses `now` for still-running spans and empties on bad input", () => {
    const t0 = "2026-07-12T18:00:00Z";
    const now = Date.parse("2026-07-12T18:00:30Z");
    expect(fmtDuration(t0, null, now)).toBe("30s");
    expect(fmtDuration(null, null)).toBe("");
    expect(fmtDuration("garbage", null)).toBe("");
  });
});

describe("run detail expansion", () => {
  let root: HTMLElement;
  beforeEach(() => {
    root = document.createElement("div");
    openUrl.mockClear();
  });

  const jobs: BeaconJob[] = [
    {
      id: 101,
      name: "build-sign-notarize",
      state: "in_progress",
      started_at: "2026-07-12T18:00:00Z",
      completed_at: null,
      steps: [
        { name: "Checkout", state: "success", started_at: "2026-07-12T18:00:01Z", completed_at: "2026-07-12T18:00:03Z" },
        { name: "Notarize", state: "in_progress", started_at: "2026-07-12T18:03:00Z", completed_at: null },
      ],
    },
  ];

  const okState: BeaconState = {
    kind: "ok",
    repo: "o/r",
    runs: [{
      id: 7, name: "Release macOS", state: "in_progress", run_number: 195,
      branch: "v0.9.7", sha: "da34d4b", actor: "karluiz",
      url: "https://github.com/o/r/actions/runs/7", updated_at: new Date().toISOString(),
    }],
  };

  const detail = (over: Partial<RunDetail> = {}): RunDetail => ({
    expanded: new Set<number>(),
    jobs: new Map<number, RunDetailState>(),
    onToggle: vi.fn(),
    ...over,
  });

  it("row click toggles expansion instead of opening the URL", () => {
    const d = detail();
    renderBeacon(root, okState, undefined, undefined, undefined, d);
    (root.querySelector(".rail-row") as HTMLElement).click();
    expect(d.onToggle).toHaveBeenCalledWith(7);
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("renders job and step rows when expanded", () => {
    const d = detail({
      expanded: new Set([7]),
      jobs: new Map([[7, { kind: "jobs", jobs }]]),
    });
    renderBeacon(root, okState, undefined, undefined, undefined, d);
    const jobNames = [...root.querySelectorAll(".rail-job-name")].map((e) => e.textContent);
    expect(jobNames).toEqual(["build-sign-notarize"]);
    const stepNames = [...root.querySelectorAll(".rail-step-name")].map((e) => e.textContent);
    expect(stepNames).toEqual(["Checkout", "Notarize"]);
    // Chevron marks the open state.
    expect(root.querySelector(".rail-chevron.is-open")).not.toBeNull();
  });

  it("renders loading and error detail states", () => {
    const dLoading = detail({ expanded: new Set([7]), jobs: new Map([[7, { kind: "loading" }]]) });
    renderBeacon(root, okState, undefined, undefined, undefined, dLoading);
    expect(root.querySelector(".rail-jobs-loading")).not.toBeNull();

    const dErr = detail({ expanded: new Set([7]), jobs: new Map([[7, { kind: "error", message: "github: boom" }]]) });
    renderBeacon(root, okState, undefined, undefined, undefined, dErr);
    expect(root.querySelector(".rail-jobs-error")?.textContent).toContain("boom");
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- --run ui/src/beacon/panel.test.ts`
Expected: FAIL — `fmtDuration` not exported, detail param unknown, `Open on GitHub` button absent.

- [ ] **Step 4: Implement panel.ts**

Changes to `ui/src/beacon/panel.ts`:

1. Imports:

```ts
import {
  beaconWorkflowRuns,
  beaconRerunWorkflow,
  beaconCancelWorkflow,
  beaconRunJobs,
  type BeaconState,
  type BeaconJob,
} from "../api";
```

2. Export `stateSpine` (change `function stateSpine` → `export function stateSpine`).

3. Add after `relTime`:

```ts
/// "41s" / "3m10s" / "1h5m". Open-ended spans (running) measure to `now`.
export function fmtDuration(startIso: string | null, endIso: string | null, now = Date.now()): string {
  if (!startIso) return "";
  const start = Date.parse(startIso);
  if (Number.isNaN(start)) return "";
  const end = endIso ? Date.parse(endIso) : now;
  if (Number.isNaN(end)) return "";
  const s = Math.max(0, Math.round((end - start) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60 ? `${s % 60}s` : ""}`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60 ? `${m % 60}m` : ""}`;
}

export type RunDetailState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "jobs"; jobs: BeaconJob[] };

export type RunDetail = {
  expanded: ReadonlySet<number>;
  jobs: ReadonlyMap<number, RunDetailState>;
  onToggle: (runId: number) => void;
};

/// Jobs/steps detail block appended under an expanded run row.
function renderJobs(state: RunDetailState): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "rail-jobs";
  if (state.kind === "loading") {
    const el = document.createElement("div");
    el.className = "rail-jobs-loading";
    el.textContent = "Loading jobs…";
    wrap.append(el);
    return wrap;
  }
  if (state.kind === "error") {
    const el = document.createElement("div");
    el.className = "rail-jobs-error";
    el.textContent = state.message.replace(/^github:\s*/i, "");
    wrap.append(el);
    return wrap;
  }
  for (const job of state.jobs) {
    const line = document.createElement("div");
    line.className = "rail-job-line";
    const dot = document.createElement("span");
    dot.className = `rail-dot is-${stateSpine(job.state)}`;
    const name = document.createElement("span");
    name.className = "rail-job-name";
    name.textContent = job.name;
    const dur = document.createElement("span");
    dur.className = "rail-job-dur";
    dur.textContent = fmtDuration(job.started_at, job.completed_at);
    line.append(dot, name, dur);
    wrap.append(line);
    if (job.steps.length) {
      const steps = document.createElement("div");
      steps.className = "rail-steps";
      for (const step of job.steps) {
        const row = document.createElement("div");
        row.className = "rail-step";
        const sdot = document.createElement("span");
        sdot.className = `rail-dot is-${stateSpine(step.state)}`;
        const sname = document.createElement("span");
        sname.className = "rail-step-name";
        sname.textContent = step.name;
        const sdur = document.createElement("span");
        sdur.className = "rail-step-dur";
        sdur.textContent = fmtDuration(step.started_at, step.completed_at);
        row.append(sdot, sname, sdur);
        steps.append(row);
      }
      wrap.append(steps);
    }
  }
  return wrap;
}
```

4. `renderBeacon` signature gains the 6th param:

```ts
export function renderBeacon(
  root: HTMLElement,
  state: BeaconState,
  onPick?: (path: string) => void,
  errorActions?: { onRetry?: () => void; onReconnect?: () => void },
  runActions?: { onRerun?: (runId: number) => void; onCancel?: (runId: number) => void },
  detail?: RunDetail,
): void {
```

5. Inside `case "ok"`, rework the per-run row (replacing the current clickable-row block and action-button block):

```ts
      for (const run of state.runs) {
        const expanded = !!detail && run.id !== 0 && detail.expanded.has(run.id);
        const row = document.createElement("div");
        row.className = "rail-row";
        row.setAttribute("data-spine", stateSpine(run.state));

        const line = document.createElement("div");
        line.className = "rail-row-line";
        if (detail) {
          const chev = document.createElement("span");
          chev.className = `rail-chevron${expanded ? " is-open" : ""}`;
          chev.innerHTML = Icons.chevronRight({ size: 12 });
          line.append(chev);
        }
        const name = document.createElement("span");
        name.className = "rail-name";
        name.textContent = run.name || "(workflow)";
        const when = document.createElement("span");
        when.className = "rail-when";
        when.textContent = relTime(run.updated_at);
        line.append(name, when);

        const meta = document.createElement("div");
        meta.className = "rail-meta";
        const runLabel = run.run_number ? `#${run.run_number}` : "";
        const bits = [
          run.state.replace(/_/g, " "),
          runLabel,
          run.branch,
          run.sha,
          run.actor,
        ].filter(Boolean) as string[];
        meta.textContent = bits.join(" · ");
        row.append(line, meta);

        // Row interaction: expand/collapse when detail is wired; otherwise
        // (legacy callers/tests without detail) fall back to opening the URL.
        const clickable = isHttpUrl(run.url);
        if (detail && run.id) {
          row.setAttribute("role", "button");
          row.setAttribute("tabindex", "0");
          row.setAttribute("aria-expanded", String(expanded));
          row.addEventListener("click", () => detail.onToggle(run.id));
          row.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") detail.onToggle(run.id);
          });
        } else if (clickable) {
          row.setAttribute("role", "link");
          row.setAttribute("tabindex", "0");
          const open = () =>
            void openUrl(run.url!).catch((e) => console.error("beacon openUrl failed", e));
          row.addEventListener("click", open);
          row.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") open();
          });
        } else {
          row.style.cursor = "default";
        }

        // Action cluster: ↗ open-on-GitHub + re-run/cancel.
        const actions = document.createElement("div");
        actions.className = "rail-row-actions";
        if (clickable) {
          const openBtn = document.createElement("button");
          openBtn.type = "button";
          openBtn.className = "rail-row-action";
          openBtn.setAttribute("aria-label", "Open on GitHub");
          openBtn.innerHTML = Icons.externalLink({ size: 13 });
          attachTooltip(openBtn, "Open on GitHub");
          openBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            void openUrl(run.url!).catch((err) => console.error("beacon openUrl failed", err));
          });
          actions.append(openBtn);
        }
        if (runActions && run.id) {
          const busy = stateDotColor(run.state) === "busy";
          const action = document.createElement("button");
          action.type = "button";
          action.className = "rail-row-action";
          if (busy) {
            action.setAttribute("aria-label", "Cancel run");
            action.innerHTML = Icons.ban({ size: 13 });
            attachTooltip(action, "Cancel run");
            action.addEventListener("click", (e) => {
              e.stopPropagation();
              runActions.onCancel?.(run.id);
            });
          } else {
            action.setAttribute("aria-label", "Re-run workflow");
            action.innerHTML = Icons.refresh({ size: 13 });
            attachTooltip(action, "Re-run workflow");
            action.addEventListener("click", (e) => {
              e.stopPropagation();
              runActions.onRerun?.(run.id);
            });
          }
          actions.append(action);
        }
        if (actions.childElementCount) row.appendChild(actions);

        root.appendChild(row);
        if (expanded) {
          root.appendChild(renderJobs(detail!.jobs.get(run.id) ?? { kind: "loading" }));
        }
      }
```

6. `BeaconPanel` additions:

```ts
  private expanded = new Set<number>();
  private jobsCache = new Map<number, RunDetailState>();
  private lastState: BeaconState | null = null;
```

Constructor opts gain `onState?: (state: BeaconState) => void`.

Replace the `renderBeacon(...)` call inside `fetch()` with a shared private method, and hook expanded-busy refresh:

```ts
  private renderState(state: BeaconState): void {
    const cwd = this.selectedPath ?? this.baseCwd;
    renderBeacon(
      this.body,
      state,
      (path) => {
        this.selectedPath = path;
        void this.fetch();
      },
      { onRetry: () => this.render(), onReconnect: this.opts.onReconnect },
      {
        onRerun: (runId) => void this.runAction(() => beaconRerunWorkflow(cwd!, runId)),
        onCancel: (runId) => {
          if (!confirm("Cancel this workflow run?")) return;
          void this.runAction(() => beaconCancelWorkflow(cwd!, runId));
        },
      },
      {
        expanded: this.expanded,
        jobs: this.jobsCache,
        onToggle: (runId) => this.toggleRun(runId),
      },
    );
    if (this.selectedPath) this.prependBack();
  }

  private toggleRun(runId: number): void {
    if (this.expanded.has(runId)) {
      this.expanded.delete(runId);
    } else {
      this.expanded.add(runId);
      if (!this.jobsCache.has(runId)) this.jobsCache.set(runId, { kind: "loading" });
      void this.refreshJobs(runId);
    }
    if (this.lastState) this.renderState(this.lastState);
  }

  private async refreshJobs(runId: number): Promise<void> {
    const cwd = this.selectedPath ?? this.baseCwd;
    if (!cwd) return;
    const gen = this.generation;
    try {
      const jobs = await beaconRunJobs(cwd, runId);
      if (gen !== this.generation || !this.expanded.has(runId)) return;
      this.jobsCache.set(runId, { kind: "jobs", jobs });
    } catch (e) {
      if (gen !== this.generation || !this.expanded.has(runId)) return;
      this.jobsCache.set(runId, { kind: "error", message: String(e) });
    }
    if (this.lastState) this.renderState(this.lastState);
  }
```

In `fetch()` (success path), replace the inline `renderBeacon(...)` + `prependBack` with:

```ts
      if (gen !== this.generation) return; // superseded
      this.lastState = state;
      this.opts.onState?.(state);
      if (state.kind === "ok") {
        // Drop expansion state for runs that no longer exist.
        const ids = new Set(state.runs.map((r) => r.id));
        for (const id of [...this.expanded]) if (!ids.has(id)) this.expanded.delete(id);
        for (const id of [...this.jobsCache.keys()]) if (!ids.has(id)) this.jobsCache.delete(id);
        // Live-refresh jobs for expanded, still-running runs on each poll.
        for (const r of state.runs) {
          if (this.expanded.has(r.id) && stateDotColor(r.state) === "busy") {
            void this.refreshJobs(r.id);
          }
        }
      }
      this.renderState(state);
```

Also in `fetch()`: when cwd changes (`base !== this.baseCwd`), additionally clear `this.expanded` and `this.jobsCache`.

The error path of `fetch()` and `runAction` keep calling `renderBeacon(...)` directly (error states render no rows, detail irrelevant) — but set `this.lastState = null` there is NOT needed; leave `lastState` as-is.

7. `beacon.css` — replace the placeholder comment file content with:

```css
/* Beacon-specific styles. The shared chrome lives in the `.rail-*` design
   system (ui/src/styles.css); this file holds only the run-detail
   (jobs/steps) tree and the titlebar live-indicator states. */

.rail-chevron { display: inline-flex; flex: none; color: var(--text-tertiary); transition: transform 120ms ease; }
.rail-chevron.is-open { transform: rotate(90deg); }

.rail-jobs { display: flex; flex-direction: column; gap: 2px; padding: 2px 10px 8px 24px; }
.rail-job-line, .rail-step { display: flex; align-items: center; gap: 6px; min-width: 0; }
.rail-job-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.rail-step { padding-left: 13px; }
.rail-step-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; color: var(--text-tertiary); }
.rail-job-dur, .rail-step-dur { flex: none; font-size: 10px; color: var(--text-tertiary); font-variant-numeric: tabular-nums; }
.rail-jobs .rail-dot { width: 5px; height: 5px; }
.rail-jobs-loading, .rail-jobs-error { font-size: 11px; color: var(--text-tertiary); }
.rail-jobs-error { color: var(--fail); }

@media (prefers-reduced-motion: reduce) {
  .rail-chevron { transition: none; }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- --run ui/src/beacon/panel.test.ts` then `npm run build`
Expected: PASS; type-check clean. Also confirm the OTHER existing renderBeacon tests still pass unchanged (they call without `detail`, hitting the legacy URL fallback).

- [ ] **Step 6: Commit**

```bash
git add ui/src/beacon/panel.ts ui/src/beacon/panel.test.ts ui/src/beacon/beacon.css ui/src/icons/index.ts
git commit -m "feat(beacon): expandable run detail — jobs and steps inline

Run rows now expand on click (chevron) into a jobs tree with per-step
state dots and durations, fetched via beacon_run_jobs and live-refreshed
on the 25s poll while the run is busy. Opening github.com moves from the
row to a dedicated ↗ action button.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Titlebar beacon live indicator

**Files:**
- Create: `ui/src/beacon/indicator.ts`
- Test: `ui/src/beacon/indicator.test.ts` (create)
- Modify: `ui/src/beacon/beacon.css` (append icon states)
- Modify: `ui/src/main.ts` (~lines 904–927: create indicator, feed from panel, ack on open)

**Interfaces:**
- Consumes: `beaconWorkflowRuns`, `BeaconState` from `../api`; `stateDotColor` from `./panel`; `BeaconPanel` `onState` callback (Task 3).
- Produces: `aggregateRuns(runs, ackedFailId, wasBusy) -> { agg: Aggregate; newestFailId: number | null }`; `class BeaconIndicator { constructor(btn: HTMLElement, getCwd: () => string | null); start(): void; stop(): void; setPanelOpen(open: boolean): void; feed(state: BeaconState): void }`; `type Aggregate = "quiet" | "busy" | "fail" | "ok"`.

- [ ] **Step 1: Write the failing test**

Create `ui/src/beacon/indicator.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { beaconWorkflowRuns } = vi.hoisted(() => ({
  beaconWorkflowRuns: vi.fn(),
}));
vi.mock("../api", () => ({ beaconWorkflowRuns }));

import { aggregateRuns, BeaconIndicator } from "./indicator";
import type { BeaconState } from "../api";

const r = (id: number, state: string) => ({ id, state });

describe("aggregateRuns", () => {
  it("busy wins over everything", () => {
    const { agg } = aggregateRuns([r(2, "in_progress"), r(1, "failure")], null, false);
    expect(agg).toBe("busy");
  });

  it("unacked failure flags fail; acked failure stays quiet", () => {
    expect(aggregateRuns([r(9, "failure"), r(1, "success")], null, false).agg).toBe("fail");
    expect(aggregateRuns([r(9, "failure"), r(1, "success")], 9, false).agg).toBe("quiet");
  });

  it("a NEW failure re-flags even after an older ack", () => {
    expect(aggregateRuns([r(10, "failure")], 9, false).agg).toBe("fail");
  });

  it("busy → all green transitions to ok (flash), then quiet", () => {
    expect(aggregateRuns([r(1, "success")], null, true).agg).toBe("ok");
    expect(aggregateRuns([r(1, "success")], null, false).agg).toBe("quiet");
  });
});

describe("BeaconIndicator", () => {
  let btn: HTMLElement;
  beforeEach(() => {
    vi.useFakeTimers();
    btn = document.createElement("button");
  });
  afterEach(() => vi.useRealTimers());

  const okState = (runs: { id: number; state: string }[]): BeaconState =>
    ({ kind: "ok", repo: "o/r", runs } as BeaconState);

  it("feed() applies is-busy / is-fail classes", () => {
    const ind = new BeaconIndicator(btn, () => "/repo");
    ind.feed(okState([r(1, "in_progress")]));
    expect(btn.classList.contains("is-busy")).toBe(true);
    ind.feed(okState([r(1, "failure")]));
    expect(btn.classList.contains("is-busy")).toBe(false);
    expect(btn.classList.contains("is-fail")).toBe(true);
  });

  it("opening the panel acknowledges the failure", () => {
    const ind = new BeaconIndicator(btn, () => "/repo");
    ind.feed(okState([r(5, "failure")]));
    expect(btn.classList.contains("is-fail")).toBe(true);
    ind.setPanelOpen(true);
    expect(btn.classList.contains("is-fail")).toBe(false);
    // Same failure doesn't re-flag on the next feed…
    ind.feed(okState([r(5, "failure")]));
    expect(btn.classList.contains("is-fail")).toBe(false);
    // …but a new one does.
    ind.setPanelOpen(false);
    ind.feed(okState([r(6, "failure")]));
    expect(btn.classList.contains("is-fail")).toBe(true);
  });

  it("busy → success flashes is-ok, then clears after 5s", () => {
    const ind = new BeaconIndicator(btn, () => "/repo");
    ind.feed(okState([r(1, "in_progress")]));
    ind.feed(okState([r(1, "success")]));
    expect(btn.classList.contains("is-ok")).toBe(true);
    vi.advanceTimersByTime(5100);
    expect(btn.classList.contains("is-ok")).toBe(false);
  });

  it("non-ok states go quiet without classes", () => {
    const ind = new BeaconIndicator(btn, () => "/repo");
    ind.feed(okState([r(1, "in_progress")]));
    ind.feed({ kind: "not_authed" } as BeaconState);
    expect(btn.className).toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run ui/src/beacon/indicator.test.ts`
Expected: FAIL — module `./indicator` does not exist.

- [ ] **Step 3: Implement `ui/src/beacon/indicator.ts`**

```ts
// Titlebar beacon live indicator — ambient GitHub Actions state on the
// #titlebar-beacon icon: amber pulse while any run is busy, persistent
// red on an unacknowledged failure, brief green flash when a busy repo
// goes all-green. Polls on its own only while the Beacon panel is
// closed; the open panel's 25s poll feeds it via feed() instead.

import { beaconWorkflowRuns, type BeaconState } from "../api";
import { stateDotColor } from "./panel";

const POLL_MS = 45_000;
const OK_FLASH_MS = 5_000;

export type Aggregate = "quiet" | "busy" | "fail" | "ok";

/// Collapse a runs list into one icon state. `ackedFailId` is the newest
/// failed run the user has already seen (opening the panel acks it);
/// `wasBusy` turns the busy→all-green edge into a brief "ok" flash.
export function aggregateRuns(
  runs: { id: number; state: string }[],
  ackedFailId: number | null,
  wasBusy: boolean,
): { agg: Aggregate; newestFailId: number | null } {
  const busy = runs.some((r) => stateDotColor(r.state) === "busy");
  // Runs arrive most-recently-updated first — the first bad one is newest.
  const newestFailId = runs.find((r) => stateDotColor(r.state) === "bad")?.id ?? null;
  if (busy) return { agg: "busy", newestFailId };
  if (newestFailId != null && newestFailId !== ackedFailId) return { agg: "fail", newestFailId };
  if (wasBusy) return { agg: "ok", newestFailId };
  return { agg: "quiet", newestFailId };
}

export class BeaconIndicator {
  private timer: number | null = null;
  private okTimer: number | null = null;
  private panelOpen = false;
  private wasBusy = false;
  private ackedFailId: number | null = null;
  private lastFailId: number | null = null;
  private lastCwd: string | null = null;

  constructor(
    private btn: HTMLElement,
    private getCwd: () => string | null,
  ) {}

  start(): void {
    this.stop();
    this.timer = window.setInterval(() => void this.poll(), POLL_MS);
    void this.poll();
  }

  stop(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  }

  /// Panel open: ack the visible failure and pause our poll (the panel's
  /// own 25s poll calls feed()). Close: resume polling.
  setPanelOpen(open: boolean): void {
    this.panelOpen = open;
    if (open) {
      this.ackedFailId = this.lastFailId;
      this.btn.classList.remove("is-fail");
      this.stop();
    } else {
      this.start();
    }
  }

  /// State pushed from the open panel's poll.
  feed(state: BeaconState): void {
    this.apply(state);
  }

  private async poll(): Promise<void> {
    if (this.panelOpen) return;
    const cwd = this.getCwd();
    if (cwd !== this.lastCwd) {
      // New repo context — old acks don't apply.
      this.lastCwd = cwd;
      this.ackedFailId = null;
      this.wasBusy = false;
    }
    if (!cwd) {
      this.setClasses("quiet");
      return;
    }
    try {
      this.apply(await beaconWorkflowRuns(cwd));
    } catch {
      this.setClasses("quiet"); // indicator never surfaces errors
    }
  }

  private apply(state: BeaconState): void {
    if (state.kind !== "ok") {
      this.wasBusy = false;
      this.setClasses("quiet");
      return;
    }
    const { agg, newestFailId } = aggregateRuns(state.runs, this.ackedFailId, this.wasBusy);
    this.lastFailId = newestFailId;
    this.wasBusy = agg === "busy";
    this.setClasses(agg);
  }

  private setClasses(agg: Aggregate): void {
    this.btn.classList.toggle("is-busy", agg === "busy");
    this.btn.classList.toggle("is-fail", agg === "fail");
    if (this.okTimer !== null) {
      window.clearTimeout(this.okTimer);
      this.okTimer = null;
    }
    this.btn.classList.toggle("is-ok", agg === "ok");
    if (agg === "ok") {
      this.okTimer = window.setTimeout(() => {
        this.btn.classList.remove("is-ok");
        this.okTimer = null;
      }, OK_FLASH_MS);
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --run ui/src/beacon/indicator.test.ts`
Expected: PASS.

- [ ] **Step 5: CSS + main.ts wiring**

Append to `ui/src/beacon/beacon.css`:

```css
/* Titlebar live-release indicator (BeaconIndicator drives the classes). */
#titlebar-beacon.is-busy { color: var(--running); opacity: 1; }
#titlebar-beacon.is-busy svg { animation: beacon-pulse 1.6s ease-in-out infinite; }
#titlebar-beacon.is-fail { color: var(--fail); opacity: 1; }
#titlebar-beacon.is-ok { color: var(--ok); opacity: 1; }

@keyframes beacon-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}

@media (prefers-reduced-motion: reduce) {
  #titlebar-beacon.is-busy svg { animation: none; }
}
```

In `ui/src/main.ts`:

Add to the beacon import (line ~62): `import { BeaconPanel } from "./beacon/panel";` stays; add `import { BeaconIndicator } from "./beacon/indicator";`

Rework the Beacon wiring block (~lines 904–927) to:

```ts
  // Beacon sidebar — GitHub Actions status for the active repo.
  const beaconPanelHost = requireEl<HTMLElement>("beacon-panel");
  const beaconIndicator = beaconBtn
    ? new BeaconIndicator(beaconBtn, () => manager.activeCwd())
    : null;
  const beaconPanel = new BeaconPanel(beaconPanelHost, {
    getCwd: () => manager.activeCwd(),
    onClose: () => rail.toggle("beacon"),
    onReconnect: () => void settingsRef.panel?.open("covenant"),
    onState: (s) => beaconIndicator?.feed(s),
  });
  const closeBeaconPanel = (): void => {
    if (!document.body.classList.contains("sidebar-view-beacon")) return;
    document.body.classList.remove("sidebar-view-beacon");
    beaconPanelHost.classList.add("hidden");
    beaconPanel.close();
    beaconIndicator?.setPanelOpen(false);
  };
  const openBeaconPanel = (): void => {
    document.body.classList.add("sidebar-view-beacon");
    beaconPanelHost.classList.remove("hidden");
    beaconPanel.render();
    beaconIndicator?.setPanelOpen(true);
  };

  if (beaconBtn) {
    beaconBtn.innerHTML = Icons.radioTower({ size: 14 });
    attachTooltip(beaconBtn, "Beacon");
    beaconBtn.addEventListener("click", () => rail.toggle("beacon"));
  }
  beaconIndicator?.start();
```

- [ ] **Step 6: Full check**

Run: `npm run build && npm test -- --run ui/src/beacon ui/src/tooltip`
Expected: type-check clean; beacon + tooltip suites PASS.
Run: `cargo test -p <app-crate-name> beacon && cargo clippy --workspace --all-targets 2>&1 | tail -5`
Expected: PASS / no new warnings.

- [ ] **Step 7: Commit**

```bash
git add ui/src/beacon/indicator.ts ui/src/beacon/indicator.test.ts ui/src/beacon/beacon.css ui/src/main.ts
git commit -m "feat(beacon): titlebar icon becomes a live release indicator

45s background poll (paused while the panel is open — its own poll feeds
the indicator) drives icon states: amber pulse while a run is busy,
persistent red on an unacknowledged failure (opening the panel acks it),
brief green flash on busy→all-green. Errors stay silent.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Verification (after all tasks)

1. `npm test -- --run` from repo root — no NEW failures vs. baseline (baseline list in Global Constraints).
2. `cargo test --workspace` may hang on telegram long-poll tests (known) — scope to `cargo test -p <app-crate-name>`.
3. `cargo fmt --all && cargo clippy --workspace --all-targets`.
4. In-app verify (separate pass, DOM-dump flow): tooltip readable on Re-run button at zoom > 1; run row expands to jobs/steps during a live run; titlebar icon pulses during a run. Mark PENDING in memory if not performed.
