# Solo Autonomous Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Arm a single operator tab into full AOM autonomous posture via `Cmd+Shift+S` or an operator-chip menu item, without flipping the global AOM banner.

**Architecture:** Add one ephemeral per-tab bool `solo_aom` to the `Attached` struct. The autonomy gate in `run_tick` already computes `effective_aom` per-session and that single value drives directive injection, decisions_count, cost accounting, and auto-execute. We widen that expression so `solo_aom` is sufficient on its own. Budget shares the global `AomState` pot via a factored `ensure_autonomy_pot` helper. Three new Tauri commands + frontend triggers.

**Tech Stack:** Rust (Tokio, Tauri 2), TypeScript (xterm.js frontend). Backend tests via `cargo test -p covenant-app` (the `app` crate); existing test helpers `test_attached()` at `crates/app/src/operator.rs:4850`.

---

## File Structure

- `crates/app/src/operator.rs` — `Attached.solo_aom` field + default; new pure helper `effective_aom()`; widen gate at ~1910; candidate snapshot at ~1822; `set_solo` / `is_solo` / `any_solo_active` methods; `queue_aom_startup_actions_for(session_id)`.
- `crates/app/src/lib.rs` — `ensure_autonomy_pot` helper (extracted from `aom_start`); `operator_solo_start` / `operator_solo_stop` / `operator_solo_status` commands; register in `generate_handler!`.
- `ui/src/api.ts` — `operatorSoloStart` / `operatorSoloStop` / `operatorSoloStatus` wrappers.
- `ui/src/main.ts` — `Cmd+Shift+S` keydown handler.
- `ui/src/tabs/manager.ts` — `Pane.operatorSolo` runtime field; context-menu item; `toggleOperatorSolo`; chip accent via `drivingHere`.

---

## Task 1: Pure gate helper + widened gate

**Files:**
- Modify: `crates/app/src/operator.rs` (add `effective_aom` fn near `build_system_prompt`, ~line 3549; use it at ~1909)

- [ ] **Step 1: Write the failing test**

Add near the other `#[cfg(test)]` tests in `crates/app/src/operator.rs` (after `test_attached`, ~line 4860):

```rust
#[test]
fn effective_aom_gate_logic() {
    // global AOM on, not excluded -> active
    assert!(effective_aom(true, false, false));
    // solo on, global off, not excluded -> active
    assert!(effective_aom(false, true, false));
    // exclusion wins over both
    assert!(!effective_aom(true, true, true));
    // nothing on -> inactive
    assert!(!effective_aom(false, false, false));
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p covenant-app effective_aom_gate_logic`
Expected: FAIL — `cannot find function effective_aom in this scope`

- [ ] **Step 3: Write the helper**

Add above `build_system_prompt` (~line 3549) in `crates/app/src/operator.rs`:

```rust
/// Per-session autonomy gate. A tab is in autonomous posture when the
/// global AOM banner is on OR the tab is individually armed (solo),
/// AND the tab has not opted out via `aom_excluded`. Exclusion always
/// wins. This single value drives directive injection, decisions_count,
/// cost accounting, and `live` (auto-execute) downstream.
fn effective_aom(aom_active: bool, solo_aom: bool, aom_excluded: bool) -> bool {
    (aom_active || solo_aom) && !aom_excluded
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p covenant-app effective_aom_gate_logic`
Expected: PASS

- [ ] **Step 5: Wire the helper into `run_tick`**

In `crates/app/src/operator.rs`, replace the gate at ~line 1909:

```rust
        let effective_aom = aom_active && !aom_excluded;
        let live = per_tab_live || effective_aom;
```

with (note: `solo_aom` is read from the candidate tuple added in Task 2 — until then, pass `false` so this compiles standalone):

```rust
        let effective_aom = effective_aom(aom_active, solo_aom, aom_excluded);
        let live = per_tab_live || effective_aom;
```

> NOTE: This line references `solo_aom`, which is introduced into scope in Task 2's candidate snapshot. Do Task 2 before compiling the full crate; this task's unit test compiles the helper independently.

- [ ] **Step 6: Commit**

```bash
git add crates/app/src/operator.rs
git commit -m "feat(operator): add effective_aom gate helper with solo support"
```

---

## Task 2: `solo_aom` field + candidate snapshot + accessors

**Files:**
- Modify: `crates/app/src/operator.rs` (`Attached` struct ~467; default in `attach` ~767; `test_attached` ~4851; candidate tuple ~1758/1822/1877; new methods near `set_live` ~899)

- [ ] **Step 1: Write the failing test**

Add to the test module (~line 4860):

```rust
#[tokio::test]
async fn solo_toggle_and_any_solo() {
    let op = test_operator(); // existing helper that builds an Operator; if absent, see note
    let sid = SessionId(ulid::Ulid::new());
    attach_test_session(&op, sid).await; // existing helper; if absent, use op.attach(...)
    assert!(!op.is_solo(sid).await);
    assert!(!op.any_solo_active().await);
    op.set_solo(sid, true).await;
    assert!(op.is_solo(sid).await);
    assert!(op.any_solo_active().await);
    op.set_solo(sid, false).await;
    assert!(!op.any_solo_active().await);
}
```

> If `test_operator()` / `attach_test_session()` helpers don't exist, construct the `Operator` the same way the nearest existing `#[tokio::test]` in this file does (search for `Operator::` in the test module) and call `op.attach(sid, state, world, false, false).await` using the `state`/`world` Arcs built by `test_attached()`-style setup.

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p covenant-app solo_toggle_and_any_solo`
Expected: FAIL — `no method named is_solo` / field `solo_aom` not found

- [ ] **Step 3: Add the field**

In `Attached` (~line 480, next to `aom_excluded`) add:

```rust
    /// Ephemeral per-tab "solo autonomous" flag. When true, this tab
    /// gets full AOM posture (directive, proactive startup, auto-exec)
    /// without the global AOM banner being on — see `effective_aom`.
    /// NOT persisted to the tab manifest: a reload/restart clears it so
    /// an autonomous operator never silently resumes acting unattended.
    solo_aom: bool,
```

- [ ] **Step 4: Default the field in both constructors**

In `attach` (~line 767, in the `Attached { ... }` literal) add `solo_aom: false,` next to `aom_excluded`.
In `test_attached` (~line 4851 `Attached { ... }`) add `solo_aom: false,` next to `aom_excluded`.

- [ ] **Step 5: Thread `solo_aom` through the candidate snapshot**

The candidate tuple type is declared at ~line 1758 and pushed at ~line 1822, then destructured at ~line 1877. Add `bool` for solo right after the existing `aom_excluded: bool` position:

In the tuple type declaration (~1758), add another `bool,` after the second `bool,` (the one documented as `aom_excluded`).
In the push (~1822), add `att.solo_aom,` right after `att.aom_excluded,`.
In the destructure (~1877), add `solo_aom,` right after `aom_excluded,`.

This brings `solo_aom` into scope for the gate call wired in Task 1 Step 5.

- [ ] **Step 6: Add accessor methods**

After `set_live` (~line 902) in `impl Operator`, add:

```rust
    /// Flip the ephemeral per-tab solo-autonomous flag. Solo requires
    /// `enabled` to do anything — `run_tick` still no-ops on a
    /// not-yet-enabled session.
    pub async fn set_solo(&self, session_id: SessionId, solo: bool) {
        if let Some(att) = self.inner.lock().await.sessions.get_mut(&session_id) {
            att.solo_aom = solo;
        }
    }

    pub async fn is_solo(&self, session_id: SessionId) -> bool {
        self.inner
            .lock()
            .await
            .sessions
            .get(&session_id)
            .map(|a| a.solo_aom)
            .unwrap_or(false)
    }

    /// True if ANY attached session is currently solo-armed. Used by
    /// `ensure_autonomy_pot` to decide whether the budget pot is
    /// already live before opening a fresh one.
    pub async fn any_solo_active(&self) -> bool {
        self.inner
            .lock()
            .await
            .sessions
            .values()
            .any(|a| a.solo_aom)
    }
```

- [ ] **Step 7: Run the test + full crate build**

Run: `cargo test -p covenant-app solo_toggle_and_any_solo`
Expected: PASS
Run: `cargo build -p covenant-app`
Expected: builds clean (Task 1's gate line now resolves `solo_aom`).

- [ ] **Step 8: Commit**

```bash
git add crates/app/src/operator.rs
git commit -m "feat(operator): add ephemeral solo_aom per-tab flag + accessors"
```

---

## Task 3: Scoped startup actions

**Files:**
- Modify: `crates/app/src/operator.rs` (`queue_aom_startup_actions` ~1316)

- [ ] **Step 1: Extract a per-session variant**

`queue_aom_startup_actions` (~line 1316) snapshots ALL enabled sessions, computes a rename slug per session, and writes `att.aom_startup.rename_to`. Refactor so the all-sessions method delegates to a single-session one. Add this method right after `queue_aom_startup_actions`:

```rust
    /// Queue one-shot AOM startup actions for a SINGLE session (solo
    /// mode). Same per-session body as `queue_aom_startup_actions` but
    /// scoped — only this tab gets the proactive rename, not every
    /// Operator-enabled tab.
    pub async fn queue_aom_startup_actions_for(&self, session_id: SessionId) {
        // Phase 1: snapshot (mission_path, world Arc) for this session
        // under the inner lock; bail if not attached/enabled.
        let snap = {
            let inner = self.inner.lock().await;
            inner.sessions.get(&session_id).filter(|a| a.enabled).map(|att| {
                (att.mission.as_ref().map(|m| m.path.clone()), att.world.clone())
            })
        };
        let Some((mission_path, world_arc)) = snap else { return };

        let titles = self.tab_titles.lock().await.clone();
        // Phase 2: compute slug (reads cwd from world async mutex).
        let slug = if let Some(p) = mission_path.as_ref() {
            let s = slug_from_mission_path(p);
            if s.is_empty() {
                let cwd = world_arc.lock().await.cwd.clone();
                slug_fallback_covenant(titles.get(&session_id).map(String::as_str), &cwd, session_id)
            } else {
                s
            }
        } else {
            let cwd = world_arc.lock().await.cwd.clone();
            slug_fallback_covenant(titles.get(&session_id).map(String::as_str), &cwd, session_id)
        };

        // Phase 3: write back under the inner lock.
        if !slug.is_empty() {
            let mut inner = self.inner.lock().await;
            if let Some(att) = inner.sessions.get_mut(&session_id) {
                if att.enabled {
                    att.aom_startup.rename_to = Some(slug);
                }
            }
        }
    }
```

> This duplicates the slug logic rather than fully restructuring the all-sessions method, to avoid touching the working AOM path. DRY note: if a later cleanup wants to share, `queue_aom_startup_actions` can loop calling this per id — but do NOT change the existing method's behavior in this task.

- [ ] **Step 2: Build to verify it compiles**

Run: `cargo build -p covenant-app`
Expected: builds clean.

- [ ] **Step 3: Commit**

```bash
git add crates/app/src/operator.rs
git commit -m "feat(operator): scoped queue_aom_startup_actions_for(session)"
```

---

## Task 4: `ensure_autonomy_pot` helper (extract from `aom_start`)

**Files:**
- Modify: `crates/app/src/lib.rs` (`aom_start` ~1359)

- [ ] **Step 1: Add the helper**

Add a free `async fn` above `aom_start` (~line 1355) in `crates/app/src/lib.rs`:

```rust
/// Idempotently open the shared autonomy budget pot. Called by both
/// `aom_start` (global) and `operator_solo_start` (single tab). When no
/// autonomy is currently active, initializes `budget_usd` from settings,
/// resets cost/decisions, stamps `started_at`, and opens an
/// `aom_session` storage row. When a pot is already live (global AOM on
/// OR another solo tab armed), it's a no-op so the cap/counter carry.
///
/// `already_active` MUST be evaluated by the caller BEFORE arming its own
/// flag, so the "first to arm" caller opens the pot.
async fn ensure_autonomy_pot(state: &State<'_, AppState>, already_active: bool) {
    if already_active {
        return;
    }
    let budget = state.settings.lock().await.aom.default_budget_usd;
    let started_at = now_unix_ms();
    let row_id = match state.storage.aom_session_start(started_at, budget).await {
        Ok(id) => Some(id),
        Err(e) => {
            tracing::warn!(error = %e, "aom_session_start: persistence failed");
            None
        }
    };
    let mut s = state.aom.write().await;
    s.started_at_unix_ms = started_at;
    s.decisions_count = 0;
    s.budget_usd = budget;
    s.accumulated_cost_usd = 0.0;
    s.cost_cap_hit_at_unix_ms = None;
    s.current_session_row_id = row_id;
    tracing::info!(budget_usd = budget, row_id = ?row_id, "autonomy pot opened");
}
```

- [ ] **Step 2: Refactor `aom_start` to use it**

Replace the budget-init block in `aom_start` (~lines 1377-1398, from `let started_at = now_unix_ms();` through the `tracing::info!(...; "AOM started")` line, BUT keep `s.enabled = true`) with:

```rust
    // Global AOM is the pot owner when it's the first autonomy to arm.
    let already_active = {
        let s = state.aom.read().await;
        s.enabled
    } || state.operator.any_solo_active().await;
    ensure_autonomy_pot(&state, already_active).await;
    {
        let mut s = state.aom.write().await;
        s.enabled = true;
    }
    let status = { AomStatus::from(&*state.aom.read().await) };
    tracing::info!("AOM started");
    Ok(status)
```

Remove the now-duplicated `let budget = ...` at the top of `aom_start` (line 1362) and the old `let mut s = state.aom.write().await; s.enabled = true; ...` block. Keep `enable_all_for_aom()` and `queue_aom_startup_actions()` calls intact above.

- [ ] **Step 3: Build + run existing AOM tests**

Run: `cargo build -p covenant-app && cargo test -p covenant-app aom`
Expected: builds clean; existing AOM-named tests pass.

- [ ] **Step 4: Commit**

```bash
git add crates/app/src/lib.rs
git commit -m "refactor(aom): extract ensure_autonomy_pot shared by global + solo"
```

---

## Task 5: Solo commands + registration

**Files:**
- Modify: `crates/app/src/lib.rs` (new commands near `aom_stop` ~1755; register in `generate_handler!` ~3552)

- [ ] **Step 1: Add the three commands**

Add after `aom_stop` (~line 1755) in `crates/app/src/lib.rs`:

```rust
/// Arm a single tab into full AOM posture without the global banner.
/// Ephemeral: not persisted; cleared on reload. Opens the shared
/// budget pot if this is the first autonomy to arm.
#[tauri::command]
async fn operator_solo_start(
    state: State<'_, AppState>,
    session_id: SessionId,
) -> Result<bool, String> {
    // Capture pot liveness BEFORE arming so the first solo opens the pot.
    let already_active =
        { state.aom.read().await.enabled } || state.operator.any_solo_active().await;

    // Solo implies Operator engaged on the tab. Mirror the AOM
    // auto-enable so an unenabled tab still goes live, and tag it so
    // solo_stop can revert exactly what it turned on.
    if !state.operator.is_enabled(session_id).await {
        state.operator.set_enabled(session_id, true).await;
    }
    state.operator.set_solo(session_id, true).await;
    ensure_autonomy_pot(&state, already_active).await;
    state
        .operator
        .queue_aom_startup_actions_for(session_id)
        .await;
    tracing::info!(session = %session_id, "solo autonomous armed");
    Ok(true)
}

/// Disarm solo on a single tab. Leaves the shared pot alone if global
/// AOM or any other solo tab is still active.
#[tauri::command]
async fn operator_solo_stop(
    state: State<'_, AppState>,
    session_id: SessionId,
) -> Result<bool, String> {
    state.operator.set_solo(session_id, false).await;
    tracing::info!(session = %session_id, "solo autonomous disarmed");
    Ok(false)
}

/// Current solo state for a tab — drives the chip menu label + accent.
#[tauri::command]
async fn operator_solo_status(
    state: State<'_, AppState>,
    session_id: SessionId,
) -> Result<bool, String> {
    Ok(state.operator.is_solo(session_id).await)
}
```

> `SessionId` deserializes from the frontend string the same way existing per-session operator commands (e.g. `operator_mark_plan_task` at ~line 1190) accept it — match that command's `session_id` parameter type/attribute exactly.

- [ ] **Step 2: Register the commands**

In the `generate_handler![` list (~line 3552, near `aom_start, aom_stop`), add:

```rust
            operator_solo_start,
            operator_solo_stop,
            operator_solo_status,
```

- [ ] **Step 3: Build**

Run: `cargo build -p covenant-app`
Expected: builds clean.

- [ ] **Step 4: Commit**

```bash
git add crates/app/src/lib.rs
git commit -m "feat(operator): solo_start/solo_stop/solo_status commands"
```

---

## Task 6: Frontend API wrappers

**Files:**
- Modify: `ui/src/api.ts` (near `aomStart` ~line 751)

- [ ] **Step 1: Add wrappers**

After `aomStop` (~line 757) in `ui/src/api.ts`:

```typescript
/// Arm solo autonomous mode on one session (full AOM posture, no global
/// banner). Ephemeral — cleared on reload. Returns the new solo state.
export async function operatorSoloStart(
  sessionId: SessionId,
): Promise<boolean> {
  return invoke<boolean>("operator_solo_start", { sessionId });
}

export async function operatorSoloStop(
  sessionId: SessionId,
): Promise<boolean> {
  return invoke<boolean>("operator_solo_stop", { sessionId });
}

export async function operatorSoloStatus(
  sessionId: SessionId,
): Promise<boolean> {
  return invoke<boolean>("operator_solo_status", { sessionId });
}
```

> Match the camelCase arg convention of the surrounding wrappers (Tauri maps `sessionId` → `session_id`). Confirm by checking how `isOperatorLive`/`setOperatorLive` pass their session arg in this file and mirror it exactly.

- [ ] **Step 2: Typecheck**

Run: `cd ui && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add ui/src/api.ts
git commit -m "feat(api): operatorSoloStart/Stop/Status wrappers"
```

---

## Task 7: Keybinding `Cmd+Shift+S`

**Files:**
- Modify: `ui/src/main.ts` (next to the `Cmd+Shift+A` block ~line 1705)

- [ ] **Step 1: Add the handler**

Immediately AFTER the closing `}` of the `Cmd+Shift+A` block (the one ending with `return;` at ~line 1757), and before the `Cmd+Shift+E` block, add:

```typescript
    // ⌘⇧S — toggle SOLO autonomous mode on the active tab. Unlike
    // ⌘⇧A (global AOM), this arms only the focused operator into full
    // AOM posture; the global banner stays off. Ephemeral: a reload
    // clears it. No-op if the active tab has no session.
    if (e.metaKey && e.shiftKey && (e.key === "S" || e.key === "s")) {
      e.preventDefault();
      const active = manager.activeTabSnapshot();
      if (active?.id) {
        void manager.toggleOperatorSolo(active.id);
      }
      return;
    }
```

> `manager.activeTabSnapshot()` is already used by the `Cmd+Shift+A` block above — reuse it. If the snapshot shape doesn't expose `id`, use the same accessor the `Cmd+Shift+E` block uses to get the active tab id.

- [ ] **Step 2: Typecheck**

Run: `cd ui && npx tsc --noEmit`
Expected: fails only with `Property 'toggleOperatorSolo' does not exist` (added in Task 8). If any OTHER error, fix it.

- [ ] **Step 3: Commit (defer build-green to Task 8)**

```bash
git add ui/src/main.ts
git commit -m "feat(ui): Cmd+Shift+S solo autonomous keybinding"
```

---

## Task 8: Chip menu item + accent + `toggleOperatorSolo`

**Files:**
- Modify: `ui/src/tabs/manager.ts` (`Pane` type; context menu ~6185; `toggleOperatorLive` neighbor ~4085; `drivingHere` ~5846; api import ~60)

- [ ] **Step 1: Import the API**

In the api import block (where `setOperatorLive` is imported, ~line 60) add `operatorSoloStart`, `operatorSoloStop`, `operatorSoloStatus`.

- [ ] **Step 2: Add the runtime Pane field**

Find the `Pane` interface (where `operatorLive: boolean` is declared) and add a sibling:

```typescript
  /// Ephemeral solo-autonomous flag (full AOM on this tab only). Runtime
  /// only — never written to the tab manifest, so it clears on reload.
  operatorSolo?: boolean;
```

Initialize `operatorSolo: false` at each `operatorLive: false` construction site (search for `operatorLive: false` — currently ~lines 1125, 3947, 4036; add `operatorSolo: false` next to each).

- [ ] **Step 3: Add `toggleOperatorSolo`**

Add a method right after `toggleOperatorLive` (~line 4100) in `manager.ts`:

```typescript
  async toggleOperatorSolo(tabId: string): Promise<void> {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab) return;
    const pane = activePane(tab);
    const sessionId = pane.sessionId;
    if (!sessionId) return;
    const next = !pane.operatorSolo;
    try {
      if (next) {
        await operatorSoloStart(sessionId as SessionId);
        // Solo implies Operator engaged; reflect it locally so the chip
        // and per-tab state match the backend's auto-enable.
        pane.operatorEnabled = true;
      } else {
        await operatorSoloStop(sessionId as SessionId);
      }
      pane.operatorSolo = next;
      this.renderTabbar();
      if (tab.id === this.activeId) this.emitActiveOperator();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("operator_solo toggle failed", err);
    }
  }
```

- [ ] **Step 4: Add the context-menu item**

In the menu builder, the `else` branch at ~line 6184 (`// Normal day-mode: the per-tab Live toggle decides typing.`) currently pushes only the Live toggle. Add a second item right after the Live toggle `items.push({...})` in that same `else` block:

```typescript
        items.push({
          label: ctxPane.operatorSolo
            ? "Operator: stop autonomous (this tab)"
            : "Operator: go autonomous (this tab) — solo AOM",
          icon: Icons.headphones(),
          danger: !ctxPane.operatorSolo,
          onClick: () => this.toggleOperatorSolo(tab.id),
        });
```

> Keep it in the `else` (AOM-off) branch only: while global AOM is on, the tab is already driven, so solo is redundant and the existing AOM informational items cover it.

- [ ] **Step 5: Light up the chip accent**

At ~line 5846, the pill accent is:

```typescript
      const drivingHere = (aomOn && !excluded) || pillPane.operatorLive;
```

Widen it so a solo tab also reads as "driving":

```typescript
      const drivingHere =
        (aomOn && !excluded) || pillPane.operatorLive || pillPane.operatorSolo === true;
```

- [ ] **Step 6: Typecheck + build the whole UI**

Run: `cd ui && npx tsc --noEmit`
Expected: no errors (Task 7's `toggleOperatorSolo` reference now resolves).

- [ ] **Step 7: Commit**

```bash
git add ui/src/tabs/manager.ts
git commit -m "feat(ui): solo AOM chip menu item, accent, toggleOperatorSolo"
```

---

## Task 9: End-to-end manual verification

**Files:** none (manual)

- [ ] **Step 1: Build the app**

Run: `cargo build -p covenant-app && cd ui && npx tsc --noEmit`
Expected: both clean.

- [ ] **Step 2: Manual checklist (run `npm run tauri:dev`, or use the `respawn` skill)**

- Open a tab with an operator pinned. Press `Cmd+Shift+S` → the operator chip lights as "driving"; global AOM banner stays OFF.
- A second tab with an operator stays in normal (non-autonomous) posture — solo is single-tab only.
- Right-click the pane → context menu shows "Operator: stop autonomous (this tab)"; clicking it disarms; chip accent clears.
- Re-arm solo, then reload the app (Cmd+R / restart) → tab comes back NON-autonomous (ephemeral confirmed).
- With solo armed, let the operator make a decision → cost accrues to the shared AOM pot (check logs: `autonomy pot opened` on first arm; `decisions_count` increments).
- Arm solo, then press `Cmd+Shift+A` (global AOM) → no double-open of the pot (log shows pot already live, not re-opened); stopping global AOM leaves the solo tab's pot accounting intact until solo is also stopped.

- [ ] **Step 3: Final commit (if any verification-driven fixes were needed)**

```bash
git add -A
git commit -m "fix(solo): verification follow-ups"
```

---

## Self-Review Notes

- **Spec coverage:** §1 gate → Task 1+2; §2 budget pot → Task 4; §3 scoped startup → Task 3; §4 commands → Task 5; §5 triggers → Task 6 (keybinding) + Task 8 (chip menu); §6 visual accent → Task 8; ephemeral lifetime → Task 2 (non-persisted field) + verified in Task 9.
- **Correction vs spec:** spec said `build_system_prompt` is "currently passed `aom_active`"; the code already passes `effective_aom` (operator.rs:2141), so no change needed there — widening the `effective_aom` expression alone delivers the directive.
- **Type consistency:** `solo_aom` (Rust) ↔ `operatorSolo` (TS Pane) ↔ `operator_solo_*` commands ↔ `operatorSolo*` wrappers — names verified consistent across tasks.
- **Ordering note:** Task 1 Step 5 references `solo_aom` introduced in Task 2; Task 1's unit test compiles the helper independently, but the full crate build only goes green after Task 2 Step 7. Tasks 7→8 have the same intentional cross-reference (keybinding before the method it calls). Both are flagged inline.
