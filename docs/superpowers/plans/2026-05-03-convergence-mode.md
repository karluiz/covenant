# Convergence Mode (3.8) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the `⌘⇧O` Convergence Mode overlay that renders every open terminal session as a live observability tile, per `docs/specs/3.8-convergence-mode.md`.

**Architecture:** Backend exposes one new Tauri command, `get_convergence_snapshot`, that aggregates read-only state from existing handles (`AppState.sessions` for `OperatorState` tail + last_byte_at, `OperatorWatcher` for enabled/aom-excluded, `Storage.list_operator_decisions` for last decision + per-session cost, `AomHandle` for budget). Frontend mounts a full-window overlay, polls the snapshot every 1 s while visible, renders one CSS-grid tile per session.

**Tech Stack:** Rust (existing AppState handles, no schema changes), Tauri 2 command, TypeScript class + manual DOM (no framework), CSS grid.

**Source spec:** `docs/specs/3.8-convergence-mode.md` — read first. Acceptance criteria, file boundaries, and line caps in the spec are binding.

**Resolved decisions (from brainstorm):**
- Update mechanism: 1 s frontend polling of `get_convergence_snapshot`. No event-bus push.
- Tile sort order: tab position. No activity sort.
- Cost row when tab excluded from AOM: hide entirely, no chip.

---

## File Structure

**Create:**
- `crates/app/src/convergence.rs` — `ConvergenceTileState`, `ConvergenceSnapshot`, `build_convergence_snapshot()` aggregator, `classify_status()` helper, unit tests. ≤220 lines incl. tests.
- `ui/src/convergence/overlay.ts` — `ConvergenceOverlay` class: mount/unmount/toggle, 1s poll loop, Esc handler, click-to-activate. ≤220 lines.
- `ui/src/convergence/tile.ts` — `renderTile(state)` function returning an `HTMLElement`, plus `updateTile(el, state)`. ≤200 lines.

**Modify:**
- `crates/app/src/lib.rs` — `mod convergence;`, `get_convergence_snapshot` command + register in `invoke_handler!`. ≤25 lines added.
- `ui/src/api.ts` — typed `getConvergenceSnapshot()` wrapper + types. ≤30 lines.
- `ui/src/main.ts` — instantiate overlay, wire `⌘⇧O` toggle + Esc close. ≤30 lines added.
- `ui/src/styles.css` — overlay + tile styles appended at file end. ≤220 lines. Reuse `--bg-overlay`, `--bg-panel`, `--border`, `--muted`, `--accent`. **No new color tokens.**

**Do NOT touch:** `crates/agent/`, `crates/blocks/`, `crates/session/`, `crates/pty/`, `crates/app/src/operator.rs`, `crates/app/src/aom.rs`, `crates/app/src/safety.rs`, `crates/app/src/settings.rs`, `crates/app/src/storage.rs`, `ui/src/operator/`, `ui/src/aom/`, `ui/src/recall/`, `ui/src/blocks/`, `ui/src/structure/`, `ui/src/tabs/`, `ui/src/settings/`.

If a tile field cannot be populated from the existing public surface of those modules, ESCALATE to the user instead of widening the surface.

---

## Task 1: Backend — `convergence.rs` types + status classifier (TDD)

**Files:**
- Create: `crates/app/src/convergence.rs`

The aggregator is data-only; we test the pure status classifier in isolation, then wire it in Task 2.

- [ ] **Step 1: Create `convergence.rs` skeleton with types and a failing test for the classifier**

```rust
//! Convergence Mode (spec 3.8) — read-only aggregator that builds one
//! tile per open session for the ⌘⇧O overlay. NO schema changes; pulls
//! from existing AppState handles only.

use serde::Serialize;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum TileStatus {
    Idle,
    Working,
    AwaitingInput,
    Blocked,
    OperatorThinking,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConvergenceTileState {
    pub session_id: String,
    pub title: String,
    pub color: Option<String>,
    pub status: TileStatus,
    pub last_decision_action: Option<String>,
    pub last_decision_rationale: Option<String>,
    pub last_command: Option<String>,
    pub last_output_line: Option<String>,
    /// Hidden in the UI when `None`. Spec rule: only present when the
    /// tab is enrolled in AOM (operator-enabled, AOM on, not excluded).
    pub cost_usd: Option<f64>,
    pub budget_usd: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConvergenceSnapshot {
    pub tiles: Vec<ConvergenceTileState>,
}

/// Inputs the classifier needs. Kept separate from `OperatorState` so
/// we can unit-test without spinning up the watcher.
pub struct StatusInputs<'a> {
    pub last_byte_at: Instant,
    pub bytes_total: u64,
    pub last_decision_at_bytes_total: u64,
    pub last_decision_action: Option<&'a str>,
    pub now: Instant,
}

/// Pure status classifier. Rules (v1):
/// - `Working`     → bytes arrived within the last 750 ms
/// - `Blocked`     → last decision was `escalate` AND no new bytes
///                   since that decision
/// - `AwaitingInput` → bytes have arrived since the last decision AND
///                     the stream has been idle > 1500 ms
/// - `Idle`        → default
/// `OperatorThinking` is reserved for v2 (would require new surface
/// on OperatorWatcher). Always returns one of the four above in v1.
pub fn classify_status(inp: &StatusInputs) -> TileStatus {
    let idle = inp.now.duration_since(inp.last_byte_at);
    if idle < Duration::from_millis(750) {
        return TileStatus::Working;
    }
    let bytes_since_last_decision =
        inp.bytes_total.saturating_sub(inp.last_decision_at_bytes_total);
    if inp.last_decision_action == Some("escalate") && bytes_since_last_decision == 0 {
        return TileStatus::Blocked;
    }
    if bytes_since_last_decision > 0 && idle > Duration::from_millis(1500) {
        return TileStatus::AwaitingInput;
    }
    TileStatus::Idle
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(now: Instant, ms_ago: u64) -> Instant {
        now - Duration::from_millis(ms_ago)
    }

    #[test]
    fn working_when_bytes_recent() {
        let now = Instant::now();
        let s = classify_status(&StatusInputs {
            last_byte_at: at(now, 200),
            bytes_total: 100,
            last_decision_at_bytes_total: 50,
            last_decision_action: Some("reply"),
            now,
        });
        assert_eq!(s, TileStatus::Working);
    }

    #[test]
    fn blocked_when_last_decision_escalate_and_no_new_bytes() {
        let now = Instant::now();
        let s = classify_status(&StatusInputs {
            last_byte_at: at(now, 5_000),
            bytes_total: 200,
            last_decision_at_bytes_total: 200,
            last_decision_action: Some("escalate"),
            now,
        });
        assert_eq!(s, TileStatus::Blocked);
    }

    #[test]
    fn awaiting_input_when_idle_with_new_bytes_since_decision() {
        let now = Instant::now();
        let s = classify_status(&StatusInputs {
            last_byte_at: at(now, 3_000),
            bytes_total: 500,
            last_decision_at_bytes_total: 200,
            last_decision_action: Some("reply"),
            now,
        });
        assert_eq!(s, TileStatus::AwaitingInput);
    }

    #[test]
    fn idle_default() {
        let now = Instant::now();
        let s = classify_status(&StatusInputs {
            last_byte_at: at(now, 10_000),
            bytes_total: 100,
            last_decision_at_bytes_total: 100,
            last_decision_action: None,
            now,
        });
        assert_eq!(s, TileStatus::Idle);
    }
}
```

- [ ] **Step 2: Add `pub mod convergence;` to `crates/app/src/lib.rs`** (top of file with the other `mod` declarations).

- [ ] **Step 3: Run tests — should pass**

Run: `cargo test -p covenant convergence:: --no-fail-fast`
Expected: 4 passing tests.

- [ ] **Step 4: Commit**

```bash
git add crates/app/src/convergence.rs crates/app/src/lib.rs
git commit -m "feat(convergence): tile state types + status classifier with tests"
```

---

## Task 2: Backend — last-output-line helper + `build_convergence_snapshot`

**Files:**
- Modify: `crates/app/src/convergence.rs`

The aggregator pulls from `AppState`. We pass concrete handles rather than `&AppState` so the function is testable without Tauri state. We also write a small ANSI-stripped last-non-empty-line helper (testable in isolation).

- [ ] **Step 1: Add a failing test for `last_non_empty_line` in `convergence.rs`**

```rust
#[test]
fn last_non_empty_line_strips_ansi_and_skips_blanks() {
    let raw = b"foo\n\x1b[31mbar\x1b[0m\n   \n";
    let got = last_non_empty_line(raw, 200);
    assert_eq!(got.as_deref(), Some("bar"));
}

#[test]
fn last_non_empty_line_truncates() {
    let raw = b"hello world this is a long tail line";
    let got = last_non_empty_line(raw, 10);
    assert_eq!(got.as_deref(), Some("hello worl"));
}

#[test]
fn last_non_empty_line_returns_none_when_all_blank() {
    let raw = b"\n   \n\t\n";
    assert!(last_non_empty_line(raw, 200).is_none());
}
```

- [ ] **Step 2: Implement `last_non_empty_line` (above the `tests` module)**

```rust
/// ANSI-strips the byte slice and returns the last non-empty line,
/// truncated to `max_chars` (chars, not bytes — emoji-safe).
pub fn last_non_empty_line(bytes: &[u8], max_chars: usize) -> Option<String> {
    let stripped = strip_ansi_escapes::strip(bytes);
    let s = String::from_utf8_lossy(&stripped);
    let line = s
        .lines()
        .rev()
        .find(|l| !l.trim().is_empty())?
        .to_string();
    Some(line.chars().take(max_chars).collect())
}
```

- [ ] **Step 3: Run tests**

Run: `cargo test -p covenant convergence:: --no-fail-fast`
Expected: 7 passing.

- [ ] **Step 4: Add the aggregator function (no test — it pulls from live AppState; we'll smoke-test via the Tauri command in Task 3)**

Append to `convergence.rs`:

```rust
use crate::aom::AomHandle;
use crate::operator::{OperatorState, OperatorWatcher};
use crate::storage::{OperatorDecisionRow, Storage};
use covenant_session::SessionId;
use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};

/// Per-session inputs the aggregator needs. The frontend supplies
/// title/color (it owns tab metadata); the backend supplies status +
/// activity. `op_state` is shared with the byte pump — we lock it
/// only briefly to snapshot the tail.
pub struct SessionInput {
    pub session_id: SessionId,
    pub op_state: Arc<StdMutex<OperatorState>>,
}

/// Builds a snapshot for the given sessions. The frontend will merge
/// its own tab title/color in (we do not duplicate that state here).
pub async fn build_convergence_snapshot(
    sessions: Vec<SessionInput>,
    operator: &OperatorWatcher,
    storage: &Storage,
    aom: &AomHandle,
) -> ConvergenceSnapshot {
    // Pull recent decisions in one shot; index by full session id.
    // 200 covers the common case (12 tiles × ~16 recent decisions).
    let recent = storage
        .list_operator_decisions(200)
        .await
        .unwrap_or_default();
    let by_short = index_decisions_by_short_id(&recent);

    let aom_state = aom.read().await;
    let aom_enabled = aom_state.enabled;
    let aom_budget = aom_state.budget_usd;
    drop(aom_state);

    let now = Instant::now();
    let mut tiles = Vec::with_capacity(sessions.len());
    for s in sessions {
        let id_str = s.session_id.to_string();
        let short = shorten6(&id_str);

        let (last_byte_at, bytes_total, last_decision_at_bytes_total, tail_bytes) = {
            let st = s.op_state.lock().expect("op_state poisoned");
            (
                st.last_byte_at,
                st.bytes_total,
                st.last_decision_at_bytes_total,
                st.snapshot_tail(8 * 1024),
            )
        };

        let last = by_short.get(short.as_str()).copied();
        let last_action = last.map(|d| d.action.as_str());

        let status = classify_status(&StatusInputs {
            last_byte_at,
            bytes_total,
            last_decision_at_bytes_total,
            last_decision_action: last_action,
            now,
        });

        let op_enabled = operator.is_enabled(s.session_id).await;
        let aom_excluded = operator.is_aom_excluded(s.session_id).await;
        let enrolled = aom_enabled && op_enabled && !aom_excluded;

        let cost_usd = if enrolled {
            Some(sum_cost_for_short(&recent, &short))
        } else {
            None
        };

        tiles.push(ConvergenceTileState {
            session_id: id_str,
            title: String::new(),  // frontend overrides
            color: None,            // frontend overrides
            status,
            last_decision_action: last.map(|d| d.action.clone()),
            last_decision_rationale: last.and_then(|d| d.rationale.clone()),
            last_command: last.and_then(|d| d.in_flight_command.clone()),
            last_output_line: last_non_empty_line(&tail_bytes, 160),
            cost_usd,
            budget_usd: if enrolled { Some(aom_budget) } else { None },
        });
    }

    ConvergenceSnapshot { tiles }
}

fn shorten6(id: &str) -> String {
    let n = id.len();
    if n > 6 { id[n - 6..].to_string() } else { id.to_string() }
}

fn index_decisions_by_short_id(rows: &[OperatorDecisionRow]) -> HashMap<&str, &OperatorDecisionRow> {
    // rows are ORDER BY id DESC, so the first occurrence per short id
    // is the most recent decision for that session.
    let mut out = HashMap::new();
    for r in rows {
        out.entry(r.session_id_short.as_str()).or_insert(r);
    }
    out
}

/// Sum cost_usd is not exposed on OperatorDecisionRow today — v1 falls
/// back to counting decisions × estimated avg. ESCALATE if the user
/// wants accurate per-tab cost (requires extending the row struct,
/// which would touch storage.rs).
fn sum_cost_for_short(rows: &[OperatorDecisionRow], short: &str) -> f64 {
    // Placeholder accurate enough for the cost footer in v1: 0.0.
    // The tile shows "$0.00 / $5.00 budget" for enrolled tabs until
    // OperatorDecisionRow exposes cost_usd. This is intentional — see
    // ESCALATE note above.
    let _ = (rows, short);
    0.0
}
```

- [ ] **Step 5: Verify it compiles**

Run: `cargo check -p covenant`
Expected: clean (warnings about unused `_` are fine).

- [ ] **Step 6: ESCALATE checkpoint to user (in plan execution, not in code)**

Stop here and ask the user: "Per-tab cost in the tile footer is stubbed to `$0.00` because `OperatorDecisionRow` does not expose `cost_usd`. Surfacing it requires touching `storage.rs`, which the spec puts off-limits. Options: (a) ship v1 with `$0.00` and a follow-up note, (b) approve a one-line addition to `OperatorDecisionRow` to read the existing `cost_usd` column, (c) hide the cost row entirely in v1."

Do not proceed past this step without an answer. Default if user says "go" without picking: option (a).

- [ ] **Step 7: Commit**

```bash
git add crates/app/src/convergence.rs
git commit -m "feat(convergence): aggregator + last-line helper with tests"
```

---

## Task 3: Backend — `get_convergence_snapshot` Tauri command

**Files:**
- Modify: `crates/app/src/lib.rs`

- [ ] **Step 1: Add the command after the `aom_*` commands (~line 700)**

```rust
/// 3.8 Convergence Mode — one snapshot per UI poll (1 Hz). Read-only
/// aggregator over existing handles; no schema changes.
#[tauri::command]
async fn get_convergence_snapshot(
    state: State<'_, AppState>,
) -> Result<convergence::ConvergenceSnapshot, String> {
    let inputs: Vec<convergence::SessionInput> = {
        let sessions = state.sessions.lock().await;
        sessions
            .iter()
            .map(|(id, ms)| convergence::SessionInput {
                session_id: *id,
                op_state: ms.op_state.clone(),
            })
            .collect()
    };
    Ok(convergence::build_convergence_snapshot(
        inputs,
        &state.operator,
        &state.storage,
        &state.aom,
    )
    .await)
}
```

- [ ] **Step 2: Register in `invoke_handler![…]`** — append `get_convergence_snapshot,` to the list (next to `aom_report`).

- [ ] **Step 3: Verify**

Run: `cargo check -p covenant`
Expected: clean.

Run: `cargo test -p covenant`
Expected: all existing + new convergence tests pass.

- [ ] **Step 4: Commit**

```bash
git add crates/app/src/lib.rs
git commit -m "feat(convergence): register get_convergence_snapshot Tauri command"
```

---

## Task 4: Frontend — `api.ts` wrapper + types

**Files:**
- Modify: `ui/src/api.ts`

- [ ] **Step 1: Append to `ui/src/api.ts`**

```typescript
// 3.8 Convergence Mode -----------------------------------------------------

export type TileStatus =
  | "idle"
  | "working"
  | "awaiting-input"
  | "blocked"
  | "operator-thinking";

export interface ConvergenceTileState {
  session_id: string;
  title: string;        // backend leaves empty; overlay fills from TabManager
  color: string | null;
  status: TileStatus;
  last_decision_action: string | null;
  last_decision_rationale: string | null;
  last_command: string | null;
  last_output_line: string | null;
  cost_usd: number | null;
  budget_usd: number | null;
}

export interface ConvergenceSnapshot {
  tiles: ConvergenceTileState[];
}

export async function getConvergenceSnapshot(): Promise<ConvergenceSnapshot> {
  return invoke<ConvergenceSnapshot>("get_convergence_snapshot");
}
```

- [ ] **Step 2: Verify types**

Run: `cd ui && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add ui/src/api.ts
git commit -m "feat(convergence): api.ts snapshot wrapper"
```

---

## Task 5: Frontend — `ui/src/convergence/tile.ts`

**Files:**
- Create: `ui/src/convergence/tile.ts`

Pure render function (no state). The overlay calls `renderTile` once per tile per snapshot, replacing the grid contents wholesale. Simple and bug-free; we can virtualize later if needed.

- [ ] **Step 1: Create `ui/src/convergence/tile.ts`**

```typescript
import type { ConvergenceTileState, TileStatus } from "../api";

const STATUS_LABEL: Record<TileStatus, string> = {
  idle: "idle",
  working: "working",
  "awaiting-input": "awaiting input",
  blocked: "blocked",
  "operator-thinking": "operator thinking",
};

function truncate(s: string | null, max: number): string {
  if (!s) return "";
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function fmtUsd(v: number): string {
  return `$${v.toFixed(2)}`;
}

export function renderTile(state: ConvergenceTileState): HTMLElement {
  const tile = document.createElement("button");
  tile.type = "button";
  tile.className = "convergence-tile";
  tile.dataset.sessionId = state.session_id;
  tile.dataset.status = state.status;

  // (1) Title row + color stripe
  const head = document.createElement("div");
  head.className = "convergence-tile__head";
  const stripe = document.createElement("span");
  stripe.className = "convergence-tile__stripe";
  if (state.color) stripe.style.background = state.color;
  const title = document.createElement("span");
  title.className = "convergence-tile__title";
  title.textContent = truncate(state.title || "untitled", 40);
  head.append(stripe, title);

  // (2) Status pill
  const pill = document.createElement("span");
  pill.className = "convergence-tile__pill";
  pill.dataset.status = state.status;
  pill.textContent = STATUS_LABEL[state.status];

  // (3) Last decision (action + rationale, 2-line clamp via CSS)
  const decision = document.createElement("div");
  decision.className = "convergence-tile__decision";
  if (state.last_decision_action) {
    const action = document.createElement("span");
    action.className = "convergence-tile__action";
    action.textContent = state.last_decision_action;
    const rationale = document.createElement("span");
    rationale.className = "convergence-tile__rationale";
    rationale.textContent = state.last_decision_rationale ?? "";
    decision.append(action, rationale);
  } else {
    decision.classList.add("convergence-tile__decision--empty");
    decision.textContent = "no decisions yet";
  }

  // (4) Last command + output preview
  const activity = document.createElement("div");
  activity.className = "convergence-tile__activity";
  const cmd = document.createElement("div");
  cmd.className = "convergence-tile__cmd";
  cmd.textContent = state.last_command ? `$ ${truncate(state.last_command, 80)}` : "—";
  const out = document.createElement("div");
  out.className = "convergence-tile__out";
  out.textContent = truncate(state.last_output_line, 100);
  activity.append(cmd, out);

  tile.append(head, pill, decision, activity);

  // (5) Cost footer ONLY when enrolled in AOM
  if (state.cost_usd !== null && state.budget_usd !== null) {
    const cost = document.createElement("div");
    cost.className = "convergence-tile__cost";
    cost.textContent = `${fmtUsd(state.cost_usd)} / ${fmtUsd(state.budget_usd)} budget`;
    tile.append(cost);
  }

  return tile;
}
```

- [ ] **Step 2: Typecheck**

Run: `cd ui && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add ui/src/convergence/tile.ts
git commit -m "feat(convergence): tile renderer"
```

---

## Task 6: Frontend — `ui/src/convergence/overlay.ts`

**Files:**
- Create: `ui/src/convergence/overlay.ts`

The overlay owns: mount/unmount, the 1s `setInterval` poll loop (only while visible), Esc-to-close, click-tile-to-activate, and the empty state. The TabManager is injected so the overlay can resolve title/color and activate-on-click; we do not import TabManager directly (kept loose-coupled).

- [ ] **Step 1: Create `ui/src/convergence/overlay.ts`**

```typescript
import { getConvergenceSnapshot, type ConvergenceTileState } from "../api";
import { renderTile } from "./tile";

export interface TabMeta {
  sessionId: string;
  title: string;
  color: string | null;
}

export interface ConvergenceTabBridge {
  /** Tab order (left→right). Used as the tile sort order. */
  listTabs(): TabMeta[];
  /** Focus the tab whose session matches; returns true on success. */
  activateBySessionId(sessionId: string): boolean;
}

const POLL_MS = 1000;

export class ConvergenceOverlay {
  private root: HTMLElement | null = null;
  private grid: HTMLElement | null = null;
  private empty: HTMLElement | null = null;
  private pollHandle: number | null = null;
  private visible = false;

  constructor(private bridge: ConvergenceTabBridge) {}

  isVisible(): boolean {
    return this.visible;
  }

  toggle(): void {
    if (this.visible) this.close();
    else this.open();
  }

  open(): void {
    if (this.visible) return;
    this.mount();
    this.visible = true;
    void this.refresh();
    this.pollHandle = window.setInterval(() => void this.refresh(), POLL_MS);
  }

  close(): void {
    if (!this.visible) return;
    this.visible = false;
    if (this.pollHandle !== null) {
      window.clearInterval(this.pollHandle);
      this.pollHandle = null;
    }
    this.root?.remove();
    this.root = null;
    this.grid = null;
    this.empty = null;
  }

  private mount(): void {
    const root = document.createElement("div");
    root.className = "convergence-overlay";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-label", "Convergence Mode");

    const exit = document.createElement("button");
    exit.type = "button";
    exit.className = "convergence-overlay__exit";
    exit.textContent = "Exit";
    exit.addEventListener("click", () => this.close());

    const grid = document.createElement("div");
    grid.className = "convergence-overlay__grid";
    grid.addEventListener("click", (e) => {
      const tile = (e.target as HTMLElement).closest<HTMLElement>(".convergence-tile");
      if (!tile?.dataset.sessionId) return;
      const ok = this.bridge.activateBySessionId(tile.dataset.sessionId);
      if (ok) this.close();
    });

    const empty = document.createElement("div");
    empty.className = "convergence-overlay__empty";
    empty.textContent = "No sessions";
    empty.hidden = true;

    root.append(exit, grid, empty);
    document.body.append(root);
    this.root = root;
    this.grid = grid;
    this.empty = empty;
  }

  private async refresh(): Promise<void> {
    if (!this.visible || !this.grid || !this.empty) return;
    let snap;
    try {
      snap = await getConvergenceSnapshot();
    } catch (err) {
      console.warn("convergence snapshot failed", err);
      return;
    }
    const tabs = this.bridge.listTabs();
    const byId = new Map(tabs.map((t) => [t.sessionId, t]));

    // Order = tab order. Drop tiles whose session no longer has a tab.
    const ordered: ConvergenceTileState[] = [];
    for (const t of tabs) {
      const tile = snap.tiles.find((x) => x.session_id === t.sessionId);
      if (!tile) continue;
      ordered.push({ ...tile, title: t.title, color: t.color });
    }

    if (ordered.length === 0) {
      this.grid.replaceChildren();
      this.empty.hidden = false;
      return;
    }
    this.empty.hidden = true;
    const frag = document.createDocumentFragment();
    for (const t of ordered) frag.append(renderTile(t));
    this.grid.replaceChildren(frag);
    void byId; // reserved for future per-tab affordances
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `cd ui && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add ui/src/convergence/overlay.ts
git commit -m "feat(convergence): overlay class with 1s polling and click-to-activate"
```

---

## Task 7: Frontend — wire `⌘⇧O` and Esc in `main.ts`

**Files:**
- Modify: `ui/src/main.ts`

The `tabs/manager.ts` `TabManager` already exposes `activateBySessionId(id): boolean` (verified at `ui/src/tabs/manager.ts:742`). We need a `listTabs()` adapter; build it inline rather than touching `tabs/manager.ts` (out of bounds per spec).

- [ ] **Step 1: Inspect TabManager surface to confirm the bridge fields are reachable**

Run: `rg -n "title|color|sessionId|tabs:" ui/src/tabs/manager.ts | head -20`
Expected: confirm tabs carry `sessionId`, `title`, and a color field. If color name differs (e.g. `accent`), use that property name in the adapter below.

- [ ] **Step 2: Add the import + bridge near the other overlay/panel instantiations in `main.ts`**

```typescript
import { ConvergenceOverlay } from "./convergence/overlay";

// ... after `const tabs = new TabManager(...)` (or wherever the
// manager instance is created):
const convergence = new ConvergenceOverlay({
  listTabs: () =>
    tabs
      .listTabs()  // if no such method exists, inline the array access:
                    // (tabs as unknown as { tabs: Tab[] }).tabs.map(...)
      .filter((t) => t.sessionId)
      .map((t) => ({
        sessionId: t.sessionId,
        title: t.title ?? "untitled",
        color: t.color ?? null,
      })),
  activateBySessionId: (id) => tabs.activateBySessionId(id),
});
```

If `TabManager` does not expose a `listTabs()` getter today, add a tiny adapter file `ui/src/convergence/tabs-bridge.ts` that imports the manager and exports a function — do NOT modify `tabs/manager.ts`.

- [ ] **Step 3: Wire the keyboard shortcut**

Find the existing `if (e.metaKey && !e.shiftKey && e.key === "o")` branch (`ui/src/main.ts:374`). Add a sibling branch ABOVE the `Escape` handler:

```typescript
// ⌘⇧O → Convergence Mode overlay (spec 3.8). Toggles full-window.
if (e.metaKey && e.shiftKey && (e.key === "O" || e.key === "o")) {
  e.preventDefault();
  convergence.toggle();
  return;
}
```

In the existing `if (e.key === "Escape")` branch, add a guard so Esc closes the overlay first:

```typescript
if (e.key === "Escape") {
  if (convergence.isVisible()) {
    convergence.close();
    e.preventDefault();
    return;
  }
  // ... existing Esc handling unchanged below
}
```

- [ ] **Step 4: Typecheck**

Run: `cd ui && npx tsc --noEmit`
Expected: clean. If `tabs.listTabs()` doesn't exist, fall back to the inline array access pattern noted in Step 2.

- [ ] **Step 5: Commit**

```bash
git add ui/src/main.ts ui/src/convergence/
git commit -m "feat(convergence): wire ⌘⇧O toggle and Esc close in main.ts"
```

---

## Task 8: Styles

**Files:**
- Modify: `ui/src/styles.css` (append at end, ≤220 lines, no new color tokens)

- [ ] **Step 1: Append the styles block**

```css
/* ───────────────────────────────────────────────────────────────────
   Convergence Mode (spec 3.8)
   z-index: above tab strip + sidebar, same posture as AFK overlay.
   No new color tokens — reuses --bg-overlay/--bg-panel/--border/
   --muted/--accent.
   ─────────────────────────────────────────────────────────────────── */
.convergence-overlay {
  position: fixed;
  inset: 0;
  z-index: 1100;
  background: var(--bg-overlay);
  padding: 24px;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.convergence-overlay__exit {
  align-self: flex-end;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  color: var(--fg, inherit);
  padding: 6px 14px;
  border-radius: 6px;
  cursor: pointer;
  font: inherit;
}
.convergence-overlay__exit:hover { border-color: var(--accent); }

.convergence-overlay__grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 16px;
}

.convergence-overlay__empty {
  flex: 1;
  display: grid;
  place-items: center;
  color: var(--muted);
  font-size: 14px;
}

.convergence-tile {
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  text-align: left;
  cursor: pointer;
  font: inherit;
  color: inherit;
  min-height: 140px;
}
.convergence-tile:hover { border-color: var(--accent); }

.convergence-tile__head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.convergence-tile__stripe {
  width: 4px;
  align-self: stretch;
  border-radius: 2px;
  background: var(--muted);
}
.convergence-tile__title {
  font-weight: 600;
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
}

.convergence-tile__pill {
  align-self: flex-start;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid var(--border);
  color: var(--muted);
  text-transform: lowercase;
}
.convergence-tile__pill[data-status="working"] {
  color: var(--accent);
  border-color: var(--accent);
}
.convergence-tile__pill[data-status="awaiting-input"] {
  color: var(--accent);
  border-color: var(--accent);
  font-weight: 600;
}
.convergence-tile__pill[data-status="blocked"] {
  /* `--danger` is reused only if it already exists in the token set;
     ESCALATE before adding a new color token (spec rule). If the token
     is absent, this rule no-ops gracefully. */
  color: var(--danger, var(--accent));
  border-color: var(--danger, var(--accent));
  font-weight: 600;
}

.convergence-tile__decision {
  font-size: 12px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.convergence-tile__decision--empty { color: var(--muted); font-style: italic; }
.convergence-tile__action {
  font-weight: 600;
  margin-right: 6px;
  text-transform: uppercase;
  font-size: 11px;
}
.convergence-tile__rationale { color: var(--muted); }

.convergence-tile__activity {
  font-family: var(--mono, ui-monospace, monospace);
  font-size: 11px;
  color: var(--muted);
  display: flex;
  flex-direction: column;
  gap: 2px;
  overflow: hidden;
}
.convergence-tile__cmd,
.convergence-tile__out {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.convergence-tile__cmd { color: inherit; }

.convergence-tile__cost {
  margin-top: auto;
  font-size: 11px;
  color: var(--muted);
  border-top: 1px solid var(--border);
  padding-top: 6px;
}
```

- [ ] **Step 2: Visual smoke test**

Run: `cd ui && npm run dev` (or `cargo tauri dev` from repo root if that's the standard).
Open the app, press `⌘⇧O`. Verify:
- Overlay covers full window above tabs/sidebar.
- Tiles render in tab order with title, status pill, decision row, command/output rows.
- Click a tile → it focuses that tab and overlay closes.
- Press Esc → overlay closes.
- Press `⌘⇧O` again with no tabs open → "No sessions" centered + Exit button visible.

If the app does not start, do not skip — debug the failure (likely a typo in the wiring) before committing.

- [ ] **Step 3: Commit**

```bash
git add ui/src/styles.css
git commit -m "feat(convergence): overlay + tile styles"
```

---

## Task 9: Verification

- [ ] **Step 1: Run all checks**

Run in parallel:
- `cargo check -p covenant`
- `cargo test -p covenant`
- `cd ui && npx tsc --noEmit`

Expected: all clean. Any failure → fix root cause, do not bypass.

- [ ] **Step 2: Walk the spec acceptance criteria**

Open `docs/specs/3.8-convergence-mode.md`. For each `- [ ]` item under "Acceptance criteria", manually verify and tick it (in your head, not in the spec — leave the file untouched until user signoff).

- [ ] **Step 3: Final commit if anything was tweaked**

```bash
git status
# If clean, skip. Otherwise:
git add -p
git commit -m "chore(convergence): post-verification fixups"
```

---

## Self-review checklist (completed before saving)

- **Spec coverage:** every AC item maps to a task — overlay toggle (T7), grid layout (T8), tile rows 1-5 (T5+T8), 1.5s update (T6 polling at 1s), click-to-focus (T6+T7), Esc/Exit (T6+T7), empty state (T6+T8), vibrancy reuse (T8), no new color tokens (T8), tsc + cargo check (T9), classifier tests (T1).
- **Placeholders:** none. The one stub (per-tab cost) is called out explicitly with an ESCALATE checkpoint at Task 2 Step 6.
- **Type consistency:** `ConvergenceTileState` / `ConvergenceSnapshot` / `TileStatus` / `getConvergenceSnapshot` named identically in Rust + TS. `activateBySessionId` matches the existing TabManager method (`ui/src/tabs/manager.ts:742`).
- **Out-of-bounds:** plan never modifies operator.rs / aom.rs / storage.rs / tabs/manager.ts / aom/ / operator/ etc. The cost stub is the explicit consequence of that boundary.
