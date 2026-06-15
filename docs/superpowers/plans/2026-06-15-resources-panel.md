# Resources Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A right-rail "Resources" panel showing live CPU/memory of Covenant's own terminal sessions, grouped Group → Session, with whole-footprint totals.

**Architecture:** A new pure `crates/metrics` crate holds the data types + subtree aggregation (unit-tested, no `sysinfo`). `crates/pty`/`crates/session` expose each session's child PID. `crates/app/src/resources.rs` samples `sysinfo` every ~1.5s while active, builds a `metrics::ProcessTable`, and emits a `resources_update` event. The frontend panel joins the flat per-session snapshot with the frontend's group model to render the tree.

**Tech Stack:** Rust + Tokio + Tauri + `sysinfo`; TypeScript + Vite + vitest (jsdom).

---

## Conventions

- **All work happens in the worktree** `/Users/carlosgallardoarenas/Sources/karlTerminal-resources` (branch `feat/resources-panel`). All paths are relative to it.
- **Frontend tests run from the worktree ROOT** (vitest config is at the root, not in `ui/`): `npx vitest run ui/src/...`. Do NOT `cd ui`.
- Rust crate package names follow the repo convention `karl-<name>` (package) / `karl_<name>` (lib): the app crate is package `covenant` / lib `covenant_lib`; the agent crate is `karl-agent` / `karl_agent`.

## File Structure

- **Create** `crates/metrics/` (`Cargo.toml`, `src/lib.rs`) — pure types + `aggregate_subtree` + `build_snapshot`. No sysinfo. Unit-tested.
- **Modify** `crates/pty/src/lib.rs` — `PtySession::child_pid()`.
- **Modify** `crates/session/src/lib.rs` — `Session::pid()`.
- **Create** `crates/app/src/resources.rs` — sysinfo→ProcessTable builder, sampler task, `resources_set_active` / `resources_sample_now` commands.
- **Modify** `crates/app/src/lib.rs` — `mod resources;`, register the two commands, spawn the sampler in setup, add sampler state to `AppState`.
- **Modify** `crates/app/Cargo.toml` + workspace `Cargo.toml` — add `karl-metrics` + `sysinfo`.
- **Create** `ui/src/resources/panel.ts` (+ `panel.css`) — the panel component (mount/render/unmount), unit-tested.
- **Modify** `ui/src/api.ts` — `resourcesSetActive`, `resourcesSampleNow`, `onResourcesUpdate`, `ResourcesSnapshot` type.
- **Modify** `ui/src/titlebar/right-rail.ts` — add `"resources"` to `RailTarget`.
- **Modify** `ui/src/main.ts` — titlebar button + `openRail`/`closeRail` cases + panel lifecycle.

---

## Task 1: `crates/metrics` — types + `aggregate_subtree`

**Files:**
- Create: `crates/metrics/Cargo.toml`, `crates/metrics/src/lib.rs`
- Modify: `Cargo.toml` (workspace `members`)

- [ ] **Step 1: Create the crate manifest** `crates/metrics/Cargo.toml`

```toml
[package]
name = "karl-metrics"
version.workspace = true
edition.workspace = true

[lib]
name = "karl_metrics"

[dependencies]
serde = { workspace = true, features = ["derive"] }

[dev-dependencies]
```

(If `serde` is not in `[workspace.dependencies]`, use `serde = { version = "1", features = ["derive"] }` instead — check the root `Cargo.toml` first.)

- [ ] **Step 2: Register the crate** — add `"crates/metrics"` to the `members = [...]` array in the root `Cargo.toml`.

- [ ] **Step 3: Write the failing test** — create `crates/metrics/src/lib.rs` with ONLY the tests first (the types/functions don't exist yet, so it won't compile = red):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn sample(pid: u32, parent: u32, cpu: f32, mem: u64) -> ProcSample {
        ProcSample { pid, parent_pid: parent, cpu, mem_bytes: mem }
    }

    #[test]
    fn subtree_sums_root_and_all_descendants() {
        // 100 → 200 → 300, and 100 → 201; 999 is unrelated.
        let table = ProcessTable::from_samples(vec![
            sample(100, 1, 1.0, 10),
            sample(200, 100, 2.0, 20),
            sample(300, 200, 4.0, 40),
            sample(201, 100, 8.0, 80),
            sample(999, 1, 99.0, 990),
        ]);
        let m = aggregate_subtree(&table, 100);
        assert_eq!(m.cpu, 1.0 + 2.0 + 4.0 + 8.0);
        assert_eq!(m.mem_bytes, 10 + 20 + 40 + 80);
    }

    #[test]
    fn missing_root_contributes_zero_but_sums_its_children() {
        // root 500 has no own sample, but 600 lists it as parent.
        let table = ProcessTable::from_samples(vec![sample(600, 500, 3.0, 30)]);
        let m = aggregate_subtree(&table, 500);
        assert_eq!(m, ProcMetrics { cpu: 3.0, mem_bytes: 30 });
    }

    #[test]
    fn cycle_does_not_hang() {
        let table = ProcessTable::from_samples(vec![
            sample(1, 2, 1.0, 1),
            sample(2, 1, 1.0, 1),
        ]);
        let m = aggregate_subtree(&table, 1);
        assert_eq!(m.mem_bytes, 2); // each counted once
    }
}
```

- [ ] **Step 4: Run, confirm it fails to compile** (types undefined)

Run: `cargo test -p karl-metrics`
Expected: compile error — `cannot find type ProcSample` etc.

- [ ] **Step 5: Implement** — prepend to `crates/metrics/src/lib.rs` (above the `#[cfg(test)]` block):

```rust
//! Pure metrics aggregation for the Resources panel. No system calls — the app
//! crate populates a `ProcessTable` from `sysinfo`; this crate only sums subtrees
//! and builds the snapshot, so it stays unit-testable.

use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ProcSample {
    pub pid: u32,
    pub parent_pid: u32,
    pub cpu: f32,
    pub mem_bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct ProcMetrics {
    pub cpu: f32,
    pub mem_bytes: u64,
}

/// Process snapshot indexed by pid, with a parent→children adjacency for
/// descendant walks.
pub struct ProcessTable {
    by_pid: HashMap<u32, ProcSample>,
    children: HashMap<u32, Vec<u32>>,
}

impl ProcessTable {
    pub fn from_samples(samples: Vec<ProcSample>) -> Self {
        let mut by_pid = HashMap::new();
        let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
        for s in samples {
            children.entry(s.parent_pid).or_default().push(s.pid);
            by_pid.insert(s.pid, s);
        }
        Self { by_pid, children }
    }
}

/// Sum cpu + memory over `root` and all its transitive descendants. Missing pids
/// contribute zero; cycles are visited once.
pub fn aggregate_subtree(table: &ProcessTable, root: u32) -> ProcMetrics {
    let mut out = ProcMetrics::default();
    let mut seen: HashSet<u32> = HashSet::new();
    let mut stack = vec![root];
    while let Some(pid) = stack.pop() {
        if !seen.insert(pid) {
            continue;
        }
        if let Some(s) = table.by_pid.get(&pid) {
            out.cpu += s.cpu;
            out.mem_bytes += s.mem_bytes;
        }
        if let Some(kids) = table.children.get(&pid) {
            stack.extend(kids.iter().copied());
        }
    }
    out
}
```

- [ ] **Step 6: Run, confirm PASS**

Run: `cargo test -p karl-metrics`
Expected: 3 passed.

- [ ] **Step 7: Commit**

```bash
cd /Users/carlosgallardoarenas/Sources/karlTerminal-resources
git add crates/metrics/Cargo.toml crates/metrics/src/lib.rs Cargo.toml
git commit -m "feat(metrics): pure crate with subtree aggregation"
```

---

## Task 2: `crates/metrics` — `build_snapshot` + totals/RAM-share

**Files:**
- Modify: `crates/metrics/src/lib.rs`

- [ ] **Step 1: Add failing tests** — append inside the existing `mod tests`:

```rust
    #[test]
    fn snapshot_sums_sessions_and_normalizes_cpu_by_cores() {
        // session A subtree = 200% cpu / 100MB; session B = 200% / 100MB.
        let table = ProcessTable::from_samples(vec![
            sample(10, 1, 200.0, 100_000_000),
            sample(20, 1, 200.0, 100_000_000),
        ]);
        let snap = build_snapshot(
            &table,
            &[("a".into(), 10), ("b".into(), 20)],
            MachineTotals { mem_total_bytes: 8_000_000_000, ncpus: 4 },
        );
        // per-session cpu normalized: 200/4 = 50
        assert_eq!(snap.sessions[0].cpu, 50.0);
        assert_eq!(snap.sessions[0].mem_bytes, 100_000_000);
        // total cpu = sum of normalized = 100; total mem = 200MB
        assert_eq!(snap.total_cpu, 100.0);
        assert_eq!(snap.total_mem_bytes, 200_000_000);
        // ram_share = 200MB / 8GB * 100 = 2.5
        assert!((snap.ram_share - 2.5).abs() < 1e-3);
        assert_eq!(snap.mem_total_bytes, 8_000_000_000);
    }

    #[test]
    fn snapshot_guards_zero_cores_and_zero_total_ram() {
        let table = ProcessTable::from_samples(vec![sample(10, 1, 5.0, 5)]);
        let snap = build_snapshot(
            &table,
            &[("a".into(), 10)],
            MachineTotals { mem_total_bytes: 0, ncpus: 0 },
        );
        assert_eq!(snap.sessions[0].cpu, 5.0); // no division by zero
        assert_eq!(snap.ram_share, 0.0);
    }
```

- [ ] **Step 2: Run, confirm fail** (`build_snapshot`, `MachineTotals`, etc. undefined)

Run: `cargo test -p karl-metrics`
Expected: compile error.

- [ ] **Step 3: Implement** — add to `crates/metrics/src/lib.rs` (above the test module, after `aggregate_subtree`):

```rust
#[derive(Debug, Clone, Copy)]
pub struct MachineTotals {
    pub mem_total_bytes: u64,
    pub ncpus: usize,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct SessionMetric {
    pub id: String,
    pub cpu: f32,
    pub mem_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct ResourcesSnapshot {
    pub total_cpu: f32,
    pub total_mem_bytes: u64,
    pub ram_share: f32,
    pub mem_total_bytes: u64,
    pub sessions: Vec<SessionMetric>,
}

/// Aggregate each session's subtree, normalize cpu to a 0..100 machine reading
/// (so a fully-pegged core under 8 cores reads ~12.5%, matching Activity-Monitor
/// style), and compute the footprint totals + RAM share.
pub fn build_snapshot(
    table: &ProcessTable,
    roots: &[(String, u32)],
    machine: MachineTotals,
) -> ResourcesSnapshot {
    let div = if machine.ncpus > 0 { machine.ncpus as f32 } else { 1.0 };
    let mut sessions = Vec::with_capacity(roots.len());
    let mut total_cpu = 0.0f32;
    let mut total_mem = 0u64;
    for (id, pid) in roots {
        let m = aggregate_subtree(table, *pid);
        let cpu = m.cpu / div;
        total_cpu += cpu;
        total_mem += m.mem_bytes;
        sessions.push(SessionMetric { id: id.clone(), cpu, mem_bytes: m.mem_bytes });
    }
    let ram_share = if machine.mem_total_bytes > 0 {
        total_mem as f32 / machine.mem_total_bytes as f32 * 100.0
    } else {
        0.0
    };
    ResourcesSnapshot {
        total_cpu,
        total_mem_bytes: total_mem,
        ram_share,
        mem_total_bytes: machine.mem_total_bytes,
        sessions,
    }
}
```

- [ ] **Step 4: Run, confirm PASS**

Run: `cargo test -p karl-metrics`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add crates/metrics/src/lib.rs
git commit -m "feat(metrics): build_snapshot with totals + RAM share"
```

---

## Task 3: Expose the child PID (pty → session)

**Files:**
- Modify: `crates/pty/src/lib.rs` (struct `PtySession`, has `child: Box<dyn Child + Send + Sync>`)
- Modify: `crates/session/src/lib.rs` (struct `Session`, has `pty: PtySession`)

- [ ] **Step 1: Add `child_pid` to `PtySession`** — inside `impl PtySession` in `crates/pty/src/lib.rs` (e.g. next to `master_fd`), add:

```rust
    /// The OS process id of the child shell, if the platform exposes it.
    pub fn child_pid(&self) -> Option<u32> {
        self.child.process_id()
    }
```

(`portable_pty::Child::process_id(&self) -> Option<u32>` is part of the trait already imported as `Child`.)

- [ ] **Step 2: Add `pid` to `Session`** — inside `impl Session` in `crates/session/src/lib.rs` (near other accessors), add:

```rust
    /// The OS process id of the underlying shell child, if available.
    pub fn pid(&self) -> Option<u32> {
        self.pty.child_pid()
    }
```

- [ ] **Step 3: Verify it compiles**

Run: `cargo check -p karl-pty -p karl-session`
Expected: compiles clean.

- [ ] **Step 4: Add a smoke test** — append to the `#[cfg(test)] mod tests` in `crates/session/src/lib.rs` (find the existing test module; if none, create one). Match how existing session tests spawn a session:

```rust
    #[tokio::test]
    async fn spawned_session_exposes_a_pid() {
        let (session, _streams) = Session::spawn(karl_pty::SpawnOptions::zsh_interactive())
            .expect("spawn");
        assert!(session.pid().is_some(), "child pid should be available after spawn");
    }
```

(If `SpawnOptions::zsh_interactive()` is not the right constructor, use whatever the existing session/pty tests use to spawn — grep `Session::spawn` and `SpawnOptions` in the test files.)

- [ ] **Step 5: Run the test**

Run: `cargo test -p karl-session spawned_session_exposes_a_pid`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/pty/src/lib.rs crates/session/src/lib.rs
git commit -m "feat(session): expose child PID for resource sampling"
```

---

## Task 4: `resources.rs` — sysinfo→ProcessTable + sampler state

**Files:**
- Modify: workspace `Cargo.toml` (`[workspace.dependencies]`), `crates/app/Cargo.toml`
- Create: `crates/app/src/resources.rs`

- [ ] **Step 1: Add dependencies.** In the root `Cargo.toml` `[workspace.dependencies]`, add:

```toml
sysinfo = "0.33"
karl-metrics = { path = "crates/metrics" }
```

In `crates/app/Cargo.toml` `[dependencies]`, add:

```toml
sysinfo = { workspace = true }
karl-metrics = { workspace = true }
```

- [ ] **Step 2: Write the sysinfo→samples helper with a test.** Create `crates/app/src/resources.rs`:

```rust
//! Resources panel backend: samples per-session process subtrees via `sysinfo`
//! and emits `resources_update` events while the panel is active.

use karl_metrics::{build_snapshot, MachineTotals, ProcSample, ProcessTable, ResourcesSnapshot};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use sysinfo::{ProcessRefreshKind, RefreshKind, System};

/// Build a `ProcessTable` from a refreshed `sysinfo::System`.
fn table_from_system(sys: &System) -> ProcessTable {
    let samples = sys
        .processes()
        .iter()
        .map(|(pid, proc_)| ProcSample {
            pid: pid.as_u32(),
            parent_pid: proc_.parent().map(|p| p.as_u32()).unwrap_or(0),
            cpu: proc_.cpu_usage(),
            mem_bytes: proc_.memory(), // sysinfo >= 0.30 returns bytes
        })
        .collect();
    ProcessTable::from_samples(samples)
}

/// Sample the given session roots into a snapshot. `sys` must already have had
/// processes + cpu refreshed at least twice (cpu usage is a delta).
pub fn snapshot(sys: &System, roots: &[(String, u32)]) -> ResourcesSnapshot {
    let table = table_from_system(sys);
    let machine = MachineTotals {
        mem_total_bytes: sys.total_memory(),
        ncpus: sys.cpus().len(),
    };
    build_snapshot(&table, roots, machine)
}

/// Shared on/off switch for the sampler loop, flipped by the Tauri commands.
#[derive(Clone, Default)]
pub struct ResourcesState {
    active: Arc<AtomicBool>,
}

impl ResourcesState {
    pub fn set_active(&self, on: bool) {
        self.active.store(on, Ordering::Relaxed);
    }
    pub fn is_active(&self) -> bool {
        self.active.load(Ordering::Relaxed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_over_real_system_has_machine_totals() {
        let mut sys = System::new_with_specifics(
            RefreshKind::nothing().with_processes(ProcessRefreshKind::everything()),
        );
        sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
        // own pid subtree should be non-empty
        let me = std::process::id();
        let snap = snapshot(&sys, &[("self".into(), me)]);
        assert!(snap.mem_total_bytes > 0, "machine RAM total should be known");
        assert!(snap.sessions[0].mem_bytes > 0, "our own process uses memory");
    }
}
```

(`sysinfo` 0.33 API: `System::new_with_specifics`, `refresh_processes(ProcessesToUpdate::All, true)`, `process.cpu_usage()`, `process.memory()` (bytes), `process.parent()`, `Pid::as_u32()`, `sys.total_memory()`, `sys.cpus().len()`. If the pinned version's API differs, adjust the three calls in `table_from_system`/`snapshot` to match — the `karl_metrics` boundary is unaffected.)

- [ ] **Step 3: Wire the module** — add `mod resources;` near the other `mod` declarations in `crates/app/src/lib.rs` (e.g. by `mod vitals;`).

- [ ] **Step 4: Run, confirm PASS**

Run: `cargo test -p covenant resources::tests::snapshot_over_real_system_has_machine_totals`
Expected: PASS (compiles + the assertions hold).

- [ ] **Step 5: Commit**

```bash
git add Cargo.toml crates/app/Cargo.toml crates/app/src/resources.rs crates/app/src/lib.rs Cargo.lock
git commit -m "feat(resources): sysinfo snapshot helper + sampler state"
```

---

## Task 5: Sampler task + commands + setup wiring

**Files:**
- Modify: `crates/app/src/resources.rs` (sampler loop + commands)
- Modify: `crates/app/src/lib.rs` (`AppState` field, `generate_handler!` registration, spawn in setup)

- [ ] **Step 1: Add the commands + sampler loop** to `crates/app/src/resources.rs`:

```rust
use tauri::{AppHandle, Emitter, Manager};
use std::time::Duration;

/// Force one immediate sample + emit, regardless of the active flag (the ↻ button).
#[tauri::command]
pub async fn resources_sample_now(app: AppHandle) -> Result<(), String> {
    emit_one(&app).await;
    Ok(())
}

/// Start/stop the live sampler loop (panel mount/unmount).
#[tauri::command]
pub async fn resources_set_active(
    app: AppHandle,
    active: bool,
) -> Result<(), String> {
    app.state::<crate::AppState>().resources.set_active(active);
    if active {
        // Kick an immediate sample so the panel isn't blank for ~1.5s.
        emit_one(&app).await;
    }
    Ok(())
}

/// Collect the live session roots (id, pid) from the registry.
async fn session_roots(app: &AppHandle) -> Vec<(String, u32)> {
    let state = app.state::<crate::AppState>();
    let sessions = state.sessions.lock().await;
    sessions
        .iter()
        .filter_map(|(id, managed)| managed.session.pid().map(|pid| (id.0.to_string(), pid)))
        .collect()
}

/// Refresh sysinfo twice (cpu is a delta) and emit a snapshot.
async fn emit_one(app: &AppHandle) {
    let roots = session_roots(app).await;
    let mut sys = System::new_with_specifics(
        RefreshKind::nothing().with_processes(ProcessRefreshKind::everything()),
    );
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    // second refresh after the minimum cpu interval gives a real cpu delta
    tokio::time::sleep(sysinfo::MINIMUM_CPU_UPDATE_INTERVAL).await;
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    let snap = snapshot(&sys, &roots);
    let _ = app.emit("resources_update", &snap);
}

/// Spawn the background sampler. Ticks ~1.5s, but only emits while active.
pub fn spawn_sampler(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_millis(1500));
        loop {
            tick.tick().await;
            if app.state::<crate::AppState>().resources.is_active() {
                emit_one(&app).await;
            }
        }
    });
}
```

- [ ] **Step 2: Add the `resources` field to `AppState`** in `crates/app/src/lib.rs` (struct `AppState`, near `vitals`):

```rust
    pub(crate) resources: resources::ResourcesState,
```

Initialize it where `AppState` is constructed (find the `AppState { ... }` literal in setup and add `resources: resources::ResourcesState::default(),`).

- [ ] **Step 3: Register the commands** — add to the `tauri::generate_handler![ ... ]` list in `crates/app/src/lib.rs`:

```rust
            resources::resources_set_active,
            resources::resources_sample_now,
```

- [ ] **Step 4: Spawn the sampler in setup** — in the setup/run function where other background tasks are spawned (search for `spawn_superpowers_watcher` or the vitals spawn), add:

```rust
    resources::spawn_sampler(app.handle().clone());
```

(`app` here is the `tauri::App`/`AppHandle` available in `setup`; match the exact handle expression the sibling spawns use.)

- [ ] **Step 5: Verify it compiles**

Run: `cargo check -p covenant`
Expected: compiles (pre-existing warnings OK).

- [ ] **Step 6: Commit**

```bash
git add crates/app/src/resources.rs crates/app/src/lib.rs
git commit -m "feat(resources): live sampler task + set_active/sample_now commands"
```

---

## Task 6: `api.ts` wrappers + snapshot type

**Files:**
- Modify: `ui/src/api.ts`

- [ ] **Step 1: Add the type + wrappers** near the other spec/vitals wrappers in `ui/src/api.ts`:

```ts
export interface ResourcesSessionMetric { id: string; cpu: number; mem_bytes: number; }
export interface ResourcesSnapshot {
  total_cpu: number;
  total_mem_bytes: number;
  ram_share: number;
  mem_total_bytes: number;
  sessions: ResourcesSessionMetric[];
}

/** Start/stop the live resources sampler (panel mount/unmount). */
export async function resourcesSetActive(active: boolean): Promise<void> {
  return invoke<void>("resources_set_active", { active });
}

/** Force one immediate resources sample (the ↻ button). */
export async function resourcesSampleNow(): Promise<void> {
  return invoke<void>("resources_sample_now", {});
}

/** Subscribe to live resources snapshots. Returns an unlisten fn. */
export async function onResourcesUpdate(
  handler: (s: ResourcesSnapshot) => void,
): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  const unlisten = await listen<ResourcesSnapshot>("resources_update", (e) =>
    handler(e.payload),
  );
  return unlisten;
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add ui/src/api.ts
git commit -m "feat(resources): api wrappers + snapshot type"
```

---

## Task 7: Resources panel component (render + sort + lifecycle)

**Files:**
- Create: `ui/src/resources/panel.ts`, `ui/src/resources/panel.css`
- Test: `ui/src/resources/panel.test.ts`

The panel is decoupled from `manager.ts` via a `deps` object so it's unit-testable. The integration task (Task 8) supplies the real deps.

- [ ] **Step 1: Write the failing test** `ui/src/resources/panel.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mountResourcesPanel, type ResourcesPanelDeps } from './panel';
import type { ResourcesSnapshot } from '../api';

const groups = () => [
  { id: 'g1', name: 'KARLUIZ-SITE', sessionIds: ['s1', 's2'], titleFor: (id: string) => (id === 's1' ? 'zsh' : 'Claude Code') },
];

function makeDeps(over: Partial<ResourcesPanelDeps> = {}): ResourcesPanelDeps {
  return {
    getGroups: groups,
    setActive: vi.fn(async () => {}),
    sampleNow: vi.fn(async () => {}),
    onUpdate: vi.fn(async () => () => {}),
    ...over,
  };
}

const snap: ResourcesSnapshot = {
  total_cpu: 3.1, total_mem_bytes: 1_300_000_000, ram_share: 7, mem_total_bytes: 18_000_000_000,
  sessions: [
    { id: 's1', cpu: 0.0, mem_bytes: 4_600_000 },
    { id: 's2', cpu: 0.8, mem_bytes: 315_900_000 },
  ],
};

describe('mountResourcesPanel', () => {
  let host: HTMLElement;
  beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); });

  it('activates the sampler on mount and deactivates on unmount', async () => {
    const deps = makeDeps();
    const unmount = mountResourcesPanel(host, deps);
    await Promise.resolve();
    expect(deps.setActive).toHaveBeenCalledWith(true);
    unmount();
    expect(deps.setActive).toHaveBeenCalledWith(false);
  });

  it('renders header totals and a Group→Session tree from a snapshot', async () => {
    let cb: (s: ResourcesSnapshot) => void = () => {};
    const deps = makeDeps({ onUpdate: vi.fn(async (h) => { cb = h; return () => {}; }) });
    mountResourcesPanel(host, deps);
    await Promise.resolve();
    cb(snap);
    expect(host.querySelector('.res-total-cpu')!.textContent).toContain('3.1');
    expect(host.querySelector('.res-group')!.textContent).toContain('KARLUIZ-SITE');
    const rows = host.querySelectorAll('.res-session');
    expect(rows.length).toBe(2);
    expect(host.textContent).toContain('Claude Code');
    expect(host.textContent).toContain('zsh');
  });

  it('sorts sessions by memory desc by default', async () => {
    let cb: (s: ResourcesSnapshot) => void = () => {};
    const deps = makeDeps({ onUpdate: vi.fn(async (h) => { cb = h; return () => {}; }) });
    mountResourcesPanel(host, deps);
    await Promise.resolve();
    cb(snap);
    const rows = [...host.querySelectorAll('.res-session')];
    // s2 (315MB) before s1 (4.6MB)
    expect(rows[0].textContent).toContain('Claude Code');
  });

  it('calls sampleNow when the refresh button is clicked', async () => {
    const deps = makeDeps();
    mountResourcesPanel(host, deps);
    await Promise.resolve();
    (host.querySelector('.res-refresh') as HTMLElement).click();
    expect(deps.sampleNow).toHaveBeenCalled();
  });

  it('shows an empty hint when there are no sessions', async () => {
    let cb: (s: ResourcesSnapshot) => void = () => {};
    const deps = makeDeps({ getGroups: () => [], onUpdate: vi.fn(async (h) => { cb = h; return () => {}; }) });
    mountResourcesPanel(host, deps);
    await Promise.resolve();
    cb({ total_cpu: 0, total_mem_bytes: 0, ram_share: 0, mem_total_bytes: 18e9, sessions: [] });
    expect(host.querySelector('.res-empty')).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run, confirm fail** (module not found)

Run: `npx vitest run ui/src/resources/panel.test.ts`
Expected: FAIL — cannot resolve `./panel`.

- [ ] **Step 3: Implement** `ui/src/resources/panel.ts`:

```ts
import './panel.css';
import type { ResourcesSnapshot } from '../api';

export interface ResourcesGroupView {
  id: string;
  name: string;
  sessionIds: string[];
  /** Display label for a session leaf (foreground process / tab title). */
  titleFor: (sessionId: string) => string;
}

export interface ResourcesPanelDeps {
  getGroups: () => ResourcesGroupView[];
  setActive: (active: boolean) => Promise<void>;
  sampleNow: () => Promise<void>;
  onUpdate: (cb: (s: ResourcesSnapshot) => void) => Promise<() => void>;
}

type SortKey = 'mem' | 'cpu';

const fmtPct = (n: number) => `${n.toFixed(1)}%`;
const fmtBytes = (b: number) => {
  if (b >= 1e9) return `${(b / 1e9).toFixed(2)} GB`;
  if (b >= 1e6) return `${(b / 1e6).toFixed(1)} MB`;
  if (b >= 1e3) return `${(b / 1e3).toFixed(0)} KB`;
  return `${b} B`;
};

export function mountResourcesPanel(host: HTMLElement, deps: ResourcesPanelDeps): () => void {
  let sort: SortKey = 'mem';
  let latest: ResourcesSnapshot | null = null;

  host.innerHTML =
    `<div class="res-panel">` +
    `<div class="res-head"><span class="res-title">Resources</span>` +
    `<span class="res-sort" role="button" tabindex="0">Memory</span>` +
    `<span class="res-refresh" role="button" tabindex="0" aria-label="Refresh">↻</span></div>` +
    `<div class="res-totals">` +
    `<div><span class="res-cap">CPU</span><span class="res-total-cpu">—</span></div>` +
    `<div><span class="res-cap">MEMORY</span><span class="res-total-mem">—</span></div>` +
    `<div><span class="res-cap">RAM SHARE</span><span class="res-total-share">—</span></div>` +
    `</div><div class="res-body"></div></div>`;

  const body = host.querySelector('.res-body') as HTMLElement;
  const sortEl = host.querySelector('.res-sort') as HTMLElement;

  const render = () => {
    const s = latest;
    if (!s) return;
    (host.querySelector('.res-total-cpu') as HTMLElement).textContent = fmtPct(s.total_cpu);
    (host.querySelector('.res-total-mem') as HTMLElement).textContent = fmtBytes(s.total_mem_bytes);
    (host.querySelector('.res-total-share') as HTMLElement).textContent = fmtPct(s.ram_share);

    const metric = new Map(s.sessions.map((m) => [m.id, m]));
    const groups = deps.getGroups();
    body.replaceChildren();
    if (groups.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'res-empty';
      empty.textContent = 'No active sessions.';
      body.appendChild(empty);
      return;
    }
    for (const g of groups) {
      const gEl = document.createElement('div');
      gEl.className = 'res-group';
      gEl.textContent = g.name;
      body.appendChild(gEl);
      const rows = g.sessionIds
        .map((id) => ({ id, m: metric.get(id) }))
        .sort((a, b) => {
          const av = a.m ? (sort === 'mem' ? a.m.mem_bytes : a.m.cpu) : -1;
          const bv = b.m ? (sort === 'mem' ? b.m.mem_bytes : b.m.cpu) : -1;
          return bv - av;
        });
      for (const { id, m } of rows) {
        const r = document.createElement('div');
        r.className = 'res-session';
        r.innerHTML =
          `<span class="res-name">${g.titleFor(id)}</span>` +
          `<span class="res-cpu">${m ? fmtPct(m.cpu) : '—'}</span>` +
          `<span class="res-mem">${m ? fmtBytes(m.mem_bytes) : '—'}</span>`;
        body.appendChild(r);
      }
    }
  };

  sortEl.addEventListener('click', () => {
    sort = sort === 'mem' ? 'cpu' : 'mem';
    sortEl.textContent = sort === 'mem' ? 'Memory' : 'CPU';
    render();
  });
  (host.querySelector('.res-refresh') as HTMLElement).addEventListener('click', () => {
    void deps.sampleNow();
  });

  let unlisten: (() => void) | null = null;
  void deps.setActive(true);
  void deps.onUpdate((s) => { latest = s; render(); }).then((u) => { unlisten = u; });

  return () => {
    unlisten?.();
    void deps.setActive(false);
    host.replaceChildren();
  };
}
```

- [ ] **Step 4: Add minimal CSS** `ui/src/resources/panel.css`:

```css
.res-panel { display: flex; flex-direction: column; height: 100%; font-size: 13px; color: var(--txt, #e6e7ee); }
.res-head { display: flex; align-items: center; gap: 12px; padding: 12px 14px; }
.res-title { font-weight: 600; font-size: 15px; }
.res-sort, .res-refresh { margin-left: auto; cursor: pointer; color: var(--txt-faint, #8a8d99); font-size: 12px; }
.res-refresh { margin-left: 0; }
.res-totals { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; padding: 6px 14px 14px; border-bottom: 1px solid var(--line-soft, #23252d); }
.res-cap { display: block; font-size: 10px; letter-spacing: 1px; color: var(--txt-faint, #8a8d99); }
.res-total-cpu, .res-total-mem, .res-total-share { font-size: 18px; }
.res-body { flex: 1; overflow-y: auto; padding: 8px 14px; }
.res-group { font-weight: 600; letter-spacing: .5px; margin: 12px 0 4px; }
.res-session { display: grid; grid-template-columns: 1fr auto auto; gap: 14px; padding: 4px 0 4px 14px; color: var(--txt-dim, #b6b9c5); }
.res-empty { color: var(--txt-faint, #8a8d99); padding: 16px 2px; }
```

- [ ] **Step 5: Run, confirm PASS**

Run: `npx vitest run ui/src/resources/panel.test.ts`
Expected: 5 passed.

- [ ] **Step 6: Commit**

```bash
git add ui/src/resources/panel.ts ui/src/resources/panel.css ui/src/resources/panel.test.ts
git commit -m "feat(resources): panel component — header totals + Group→Session tree"
```

---

## Task 8: Right-rail wiring (toggle + panel lifecycle)

**Files:**
- Modify: `ui/src/titlebar/right-rail.ts` (`RailTarget`)
- Modify: `ui/src/main.ts` (button map, `openRail`/`closeRail`, panel mount/unmount, group-view adapter)

This task integrates the panel into the existing right-rail. Read the file regions first; follow the **Tasker** panel as the template (how it mounts on `openRail` and tears down on `closeRail`).

- [ ] **Step 1: Extend `RailTarget`** in `ui/src/titlebar/right-rail.ts` — add `"resources"`:

```ts
export type RailTarget =
  | "blocks" | "structure" | "activity" | "recall"
  | "notes" | "teammate" | "tasker" | "resources";
```

- [ ] **Step 2: Add the titlebar button.** In `ui/src/main.ts`, find the `railButtons` record (maps each `RailTarget` to its titlebar button element) and add a `resources` entry wired to a new titlebar button. Add the button to the titlebar markup next to the Tasker/Browser buttons, using a CPU/chip icon from `ui/src/icons` (use an existing icon such as `Icons.cpu` if present; otherwise reuse the closest existing glyph and note it). Follow the exact pattern the sibling buttons use (class names, `attachTooltip` from `ui/src/tooltip/tooltip.ts` — do NOT set `element.title`).

- [ ] **Step 3: Add the group-view adapter.** In `ui/src/main.ts`, add a helper that converts the tab manager's current grouping into `ResourcesGroupView[]` (the panel's input). Use the manager's existing rail-group accessor (search for `RailGroupView` / the function that returns groups with their tabs). For each group, collect its tabs' session ids and a `titleFor(sessionId)` that returns the tab's display title (prefer a foreground-process name if the frontend already tracks one; otherwise the tab title):

```ts
import { mountResourcesPanel, type ResourcesGroupView } from "./resources/panel";
import { resourcesSetActive, resourcesSampleNow, onResourcesUpdate } from "./api";

function resourcesGroupViews(): ResourcesGroupView[] {
  // Adapt the manager's current groups → panel view. Replace `manager.railGroups()`
  // and the tab→sessionId/title accessors with the real ones from manager.ts.
  return manager.railGroups().map((g) => ({
    id: g.id,
    name: g.name,
    sessionIds: g.tabs.map((t) => t.sessionId).filter((x): x is string => !!x),
    titleFor: (sid) => g.tabs.find((t) => t.sessionId === sid)?.title ?? sid,
  }));
}
```

(Read `ui/src/tabs/manager.ts` for the actual accessor + `RailTabView` field names — `sessionId`/`title` may differ; use the real ones.)

- [ ] **Step 4: Mount/unmount on rail open/close.** Add a module-scoped `let resourcesUnmount: (() => void) | null = null;`. In `openRail()` add a `case "resources":` that mounts the panel into the right-rail panel host (same host the Tasker/Activity panels use), e.g.:

```ts
    case "resources": {
      const host = /* the right-rail panel host element, as Tasker uses */;
      resourcesUnmount = mountResourcesPanel(host, {
        getGroups: resourcesGroupViews,
        setActive: resourcesSetActive,
        sampleNow: resourcesSampleNow,
        onUpdate: onResourcesUpdate,
      });
      break;
    }
```

In `closeRail()` add:

```ts
    case "resources":
      resourcesUnmount?.();
      resourcesUnmount = null;
      break;
```

(Mirror exactly how Tasker acquires its panel host and toggles `activeSidebarTitlebarView` / localStorage if the siblings do so.)

- [ ] **Step 5: Typecheck + run the full UI suite**

Run: `npx tsc -p tsconfig.json --noEmit && npx vitest run ui/src/resources/`
Expected: typecheck clean; panel tests still pass.

- [ ] **Step 6: Commit**

```bash
git add ui/src/titlebar/right-rail.ts ui/src/main.ts
git commit -m "feat(resources): right-rail toggle + panel lifecycle"
```

---

## Task 9: Full verification

- [ ] **Step 1: Rust — metrics + session + app compile/tests**

Run: `cargo test -p karl-metrics && cargo test -p karl-session spawned_session_exposes_a_pid && cargo check -p covenant`
Expected: metrics tests pass, session pid test passes, app compiles.

- [ ] **Step 2: Frontend — panel tests + typecheck**

Run: `npx vitest run ui/src/resources/ && npx tsc -p tsconfig.json --noEmit`
Expected: all green, no type errors.

- [ ] **Step 3: Manual smoke (requires running the app — `respawn`/`npm run tauri:dev`)**

1. Open the titlebar Resources toggle → the panel mounts on the right rail.
2. With a couple of sessions open (one running e.g. `claude`), confirm the header shows CPU%/Memory/RAM-share and the tree shows Group → Session rows with per-session CPU% + memory, sorted by memory.
3. Run something CPU-heavy in a session → its CPU% rises within ~1.5s.
4. Click ↻ → an immediate refresh.
5. Close the toggle → panel unmounts; confirm sampling stops (no further `resources_update` activity).

---

## Self-Review notes

- **Spec coverage:** metrics crate → Tasks 1–2; PID exposure → Task 3; sysinfo glue + sampler + commands → Tasks 4–5; api → Task 6; panel (header/tree/sort/empty/lifecycle) → Task 7; right-rail placement + live refresh wiring → Task 8; verification → Task 9. Scope decisions (Covenant-only, right-rail, live-while-open) all reflected.
- **Type consistency:** `ProcSample`, `ProcMetrics`, `ProcessTable::from_samples`, `aggregate_subtree`, `MachineTotals`, `SessionMetric`, `ResourcesSnapshot`, `build_snapshot` (Rust) and `ResourcesSnapshot`/`ResourcesSessionMetric`, `mountResourcesPanel`, `ResourcesPanelDeps`, `ResourcesGroupView` (TS) are used identically across tasks. The snapshot field names (`total_cpu`, `total_mem_bytes`, `ram_share`, `mem_total_bytes`, `sessions[].mem_bytes`) match between the Rust `serde::Serialize` structs and the TS interface.
- **No placeholders:** every code step is complete. Tasks 5 & 8 reference existing code regions the implementer must read (AppState literal, setup spawn site, Tasker panel host, manager group accessor) — these are integration seams, not placeholders, and each names the exact symbol to find.
```
