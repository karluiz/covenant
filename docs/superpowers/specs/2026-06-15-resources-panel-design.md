# Resources panel — design

> 2026-06-15 · branch `feat/resources-panel`

A right-rail "Resources" panel: a live CPU & memory monitor of Covenant's own
terminal sessions, grouped Group → Session, with whole-footprint totals in the
header. Modeled on the reference resource-monitor dropdown (machine totals +
collapsible per-group tree), scoped to Covenant's sessions rather than a
system-wide app list.

## Decisions (locked)

- **Scope:** Covenant sessions only + aggregate totals header. No system-wide app
  list, no per-process expansion below the session leaf.
- **Placement:** a right-rail panel/toggle, consistent with Blocks/Activity/Tasker
  (via `RailTarget` + `RightRailController`).
- **Refresh:** live (~1.5s) while the panel is open, paused when closed; a manual
  ↻ forces an immediate sample.
- **Metrics source:** the `sysinfo` crate (cross-platform; also covers the
  deferred Windows M8 path). Rejected: hand-rolled libproc/sysctl (macOS-only,
  more code) and shelling out to `ps` (fragile).

## Architecture

Four units with clear boundaries:

### 1. `crates/metrics` (new, PURE — no sysinfo)

Holds the data types and the aggregation logic, with zero dependency on `sysinfo`
so it is fully unit-testable.

- `ProcSample { pid: u32, parent_pid: u32, cpu: f32, mem_bytes: u64 }`
- `ProcessTable` — a map `pid -> ProcSample` plus a derived `pid -> Vec<child pid>`
  adjacency built once per snapshot.
- `MachineTotals { mem_total_bytes: u64, ncpus: usize }`
- `aggregate_subtree(&table, root: u32) -> ProcMetrics` — sums `cpu` + `mem_bytes`
  over `root` and **all transitive descendants** (so a session row counts its
  shell + `claude` + any children). Cycles/missing pids are tolerated.
- `ProcMetrics { cpu: f32, mem_bytes: u64 }`
- `SessionMetric { id: String, cpu: f32, mem_bytes: u64 }`
- `ResourcesSnapshot { total_cpu: f32, total_mem_bytes: u64, ram_share: f32,
  mem_total_bytes: u64, sessions: Vec<SessionMetric> }`
- `build_snapshot(table, roots: &[(SessionId, u32)], machine) -> ResourcesSnapshot`
  — runs `aggregate_subtree` per root, sums into the header totals, computes
  `ram_share = total_mem_bytes / machine.mem_total_bytes`.

CPU normalization: machine `total_cpu` is divided by `ncpus` so it reads like the
reference's small percentages (Activity-Monitor style), not summed-per-core.

### 2. `crates/pty` + `crates/session` — expose the PID

- `crates/pty`: `PtySession::child_pid(&self) -> Option<u32>` from portable-pty's
  `Child::process_id()`.
- `crates/session`: `Session::pid(&self) -> Option<u32>` forwarding it.

### 3. `crates/app/src/resources.rs` — sysinfo glue, sampler task, commands

- A background sampler. While **active**, every ~1.5s it: refreshes a
  `sysinfo::System` (processes + cpu), builds a `metrics::ProcessTable` over the
  PIDs in the live session registry (and their descendants), calls
  `metrics::build_snapshot`, and emits a `resources_update` Tauri event. CPU% is a
  delta between two refreshes — sysinfo handles this across ticks.
- Commands:
  - `resources_set_active(active: bool)` — start/stop the loop (called by the panel
    on mount/unmount).
  - `resources_sample_now()` — force one immediate sample+emit (the ↻ button).
- The loop reads the session registry each tick, so sessions opening/closing are
  reflected without re-subscribing.

### 4. Frontend — `ui/src/resources/panel.ts` (+ css) + right-rail wiring

- Right-rail registration: add `"resources"` to `RailTarget`; add a titlebar button
  (CPU chip icon) in `ui/src/main.ts`'s `railButtons`; add cases in `openRail`
  (mount panel + `resourcesSetActive(true)` + subscribe) and `closeRail`
  (unsubscribe + `resourcesSetActive(false)` + unmount).
- The panel receives `ResourcesSnapshot` (machine totals + flat per-session list)
  and **joins it with the frontend group model** (`ui/src/tabs/manager.ts` owns
  Group → Tab → Session) to render: a header (total CPU / total memory / RAM share)
  and a collapsible Group → Session tree. Each session leaf is labeled by its
  foreground process name (from the existing `ForegroundChanged` /
  `crates/pty/src/fg_proc.rs`) or the shell, and shows its subtree CPU/mem.
- A Mem/CPU sort toggle (default Memory ↓), matching the reference. Frontend-only.
- `ui/src/api.ts` wrappers: `resourcesSetActive`, `resourcesSampleNow`,
  `onResourcesUpdate`.

## Data flow

```
sampler (1.5s, active only)
  → sysinfo refresh → metrics::ProcessTable (session PIDs + descendants)
  → metrics::build_snapshot
  → emit "resources_update" { total_cpu, total_mem_bytes, ram_share, sessions[] }
  → panel joins with manager.ts group model
  → render header + Group→Session tree
```

The backend stays group-agnostic: it emits flat per-`SessionId` metrics; the
frontend (authority on grouping) assembles the tree and per-group aggregates.

## Error handling / edge cases

- A PID that vanishes mid-sample is omitted from its subtree sum.
- macOS permission gaps: Covenant's own child processes are always readable; an
  unreadable foreign PID contributes 0.
- No sessions → header shows zeros, tree shows an empty hint.
- Panel closed → `resources_set_active(false)` → the loop idles, zero sampling
  cost.
- A session with no resolvable PID is shown with 0/—.

## Testing

- `crates/metrics` (pure, no sysinfo): `aggregate_subtree` sums root + descendants
  and tolerates missing pids / cycles; `build_snapshot` computes totals and
  `ram_share`; ordering is stable.
- `crates/pty` / `crates/session`: `pid()` returns `Some` for a spawned session.
- Frontend (jsdom): given a snapshot + group model the panel renders header +
  tree; the sort toggle reorders; the empty state renders; api wrappers invoke the
  right commands/events.
- The sysinfo glue in `resources.rs` is thin and integration-shaped; the testable
  logic lives in `crates/metrics`.

## Out of scope (YAGNI)

- System-wide app list (other apps like the reference's "Superset App").
- Per-process expansion below the session leaf (no "Main/Renderer/Other" rows).
- Historical graphs / sparklines — v1 shows instantaneous numbers.
- Windows-specific work now (sysinfo is cross-platform; the Windows path lands with
  M8).
- A dedicated "Covenant app self" row in the totals (can be added later; v1 totals
  are the session aggregate).

## Milestone note

This is an M5+ feature: it does not touch the super-agent loop. It is additive and
self-contained (one new pure crate + one panel + minor PID-exposure plumbing), and
was explicitly requested.
