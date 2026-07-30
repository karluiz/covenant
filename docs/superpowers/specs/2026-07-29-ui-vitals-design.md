# UI Vitals — terminal-speed metrics as a product signal

**Date:** 2026-07-29
**Status:** Approved (brainstorm with Karluiz)
**Consumer:** the builder. Purpose: detect speed regressions between
releases from real local usage. No network, no telemetry — everything
stays in the app-data dir.

## Why

Speed is the product metric for a terminal. The v0.11.2 tab-switch
investigation showed the failure mode: a 2-3s first switch shipped and
survived because the only instrumentation was a console breadcrumb that
(a) nobody persisted and (b) measured the wrong window (the heavy work
landed after the metric's frame). UI Vitals makes the three
speed-critical interactions continuously measured, persisted per
version, and comparable across releases.

## Metrics (v1 — the Core 3)

One SQLite table holds every event:

```sql
CREATE TABLE vitals_events (
  id          INTEGER PRIMARY KEY,
  ts          INTEGER NOT NULL,   -- unix ms, stamped by the backend on arrival
  app_version TEXT    NOT NULL,   -- stamped from CARGO_PKG_VERSION, never by the frontend
  metric      TEXT    NOT NULL,   -- 'switch' | 'input' | 'boot'
  value_ms    REAL    NOT NULL,
  aux_ms      REAL,               -- metric-specific secondary value
  detail      TEXT                -- JSON context blob
);
CREATE INDEX idx_vitals_metric_version ON vitals_events(metric, app_version);
CREATE INDEX idx_vitals_ts ON vitals_events(ts);
```

### `switch` — every shell-tab activation

- `value_ms`: activation start → the reveal rAF (what `activate()`
  already computes as `elapsedMs`).
- `aux_ms`: `postRevealStarvedMs` — event-loop lag sampled for ~1s after
  the reveal (`probePostRevealStarvation`). Kept separate from
  `value_ms` because they answer different questions: "was the switch
  mechanically slow" vs "did the terminal freeze right after".
- `detail`: the full breadcrumb — `fitMs`, `nudgeMs`, `colsDelta`,
  `rowsDelta`, `hiddenOutputBytes`, `hiddenOutputChunks`, `usedNudge`,
  `fitChangedDimensions`, plus `tabCount`.
- Recorded for **every** switch, not just slow ones. The console.warn
  breadcrumb stays as-is for the slow case.

### `input` — sampled keystroke → painted echo

The terminal metric. Sampling guards keep it honest and cheap:

- At most one sample per second, one measurement in flight.
- Only when the pane is `atPrompt` (OSC 133 state already tracked) and
  the key is a printable character — TUIs and non-echoing states are
  excluded by construction.
- Timeline: t0 = `term.onData` (keystroke handed to the PTY write) →
  first `OutputChunk` for that session after t0 → `term.write` parse
  callback → next rAF (painted). `value_ms` = painted − t0.
  `aux_ms` = chunk arrival − t0 (isolates PTY round-trip from
  parse+paint).
- Discards: >1000ms (not an echo), tab switched or pane hidden
  mid-sample, session ended.

### `boot` — launch → first interactive prompt

- `value_ms`: `performance.timeOrigin` → first OSC 133 `prompt_start`
  on the tab the boot restore activates.
- `detail`: `{ tabsRestored, replayBytesTotal, workspace }` — sizes the
  restore storm so regressions can be normalized against load.
- One event per app run.

## Architecture (approach A — frontend captures, backend persists)

```
activate() ─┐
input probe ├─▶ collector.ts (buffer) ─▶ vitals_record IPC (batch, 5s) ─▶ ui_vitals.rs ─▶ vitals.db
boot mark  ─┘                                                                  ▲
                         Vitals page ◀─ vitals_summary / vitals_worst ─────────┘
```

### Frontend

- `ui/src/vitals/collector.ts` — `recordVital(metric, value, aux, detail)`
  pushes into an in-memory buffer; a 5s interval (armed only while the
  buffer is non-empty) and a `beforeunload` hook flush it through one
  fire-and-forget IPC. Buffer cap 500 events (drop oldest). Never
  throws into a caller's hot path; IPC failures are swallowed.
- `ui/src/vitals/input-probe.ts` — pure state machine
  (idle → armed → awaiting-echo → awaiting-paint) with the sampling
  guards above; unit-testable without xterm. The tab manager calls two
  hooks: `onKeystroke(sessionId, atPrompt, printable)` and
  `onOutputChunk(sessionId)`; the probe drives parse-callback + rAF
  itself via injected callbacks.
- `activate()` — the existing `probePostRevealStarvation` callback also
  calls `recordVital("switch", …)` with the full breadcrumb.
- `main.ts` — boot mark: subscribe once to the first `prompt_start`
  after restore's `onActiveReady`, record, unsubscribe.

### Backend

- `crates/app/src/ui_vitals.rs`:
  - `vitals_record(events)` — inserts the batch into
    `<data_dir>/vitals.db` (rusqlite, WAL). File IO on
    `spawn_blocking`. Stamps `ts` (arrival) and `app_version`
    (`CARGO_PKG_VERSION`). Batching delay ≤5s is irrelevant at daily
    granularity.
  - `vitals_summary(days) -> Vec<{metric, app_version, n, p50, p95, max}>`
    — values fetched per group, percentiles computed in Rust (volumes
    are small: hundreds of switches/day, ≤1 input sample/s while
    typing).
  - `vitals_worst(metric, limit) -> Vec<event>` — worst rows with
    `detail`, for drill-down.
  - Retention: `DELETE WHERE ts < now − 90 days` once at startup.
- Dev build isolation is free: `com.karluiz.covenant.dev` has its own
  data dir, so dev-session noise never pollutes prod percentiles.

### Vitals page

Full-page surface (same pattern as the Worktrees page), reachable from
the command palette ("Vitals") plus a keyboard shortcut. v1 content:

1. **Three metric cards** — p50 / p95 / n for the running version.
2. **Version comparison table** — one row per installed version seen in
   the window (last 90 days): n, p50, p95 per metric. This is the
   "did 0.11.2 actually fix it" view.
3. **Trend sparkline** per metric — daily p95, last 30 days, inline SVG.
4. **Worst-10 switches table** — value, aux, and the breadcrumb fields
   (`colsDelta`, `hiddenOutputBytes`, `fitMs`…) so a bad switch is
   diagnosable from the page alone.

Follows `docs/DESIGN.md` hard rules: sharp corners, inline SVG icons
only, English chrome copy.

## Performance budget

The instrumentation must never degrade what it measures:

- Idle cost zero: no timers while the buffer is empty and no sample in
  flight.
- Keystroke path adds two number assignments and one branch when not
  sampling.
- All persistence is async and batched; a wedged backend loses vitals,
  never frames.

## Testing

- `input-probe` state machine: full unit coverage (arm/sample/discard
  paths, rate limiting, mid-sample tab switch).
- `collector`: buffering, cap, flush scheduling (fake timers).
- `ui_vitals.rs`: insert/summary/percentile/retention unit tests
  (tempdir DB), per crate convention.
- Percentile math: exact expectations on known distributions.

## Out of scope (v1)

- Remote/opt-in telemetry aggregation.
- Continuous frame-health metric (starvation outside interactions).
- Workspace-switch hydration as its own metric (visible via `switch` +
  `boot` context already).
- Alerts/notifications on regression.
- Windows-specific paint timing.
