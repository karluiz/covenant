# Covenant RC-1a · Desktop: Per-Tab Arming + Gated `send_input` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a remote web client send a command string to a desktop tab, but ONLY when that tab is explicitly armed on the desktop, and ONLY if the command passes the `safety.rs` blocklist. Otherwise reply with a typed `rejected` frame. Arming is per-tab (default off, not persisted), toggled from the tab's right-click menu. A `disarm all` kill-switch command is included.

**Architecture:** Add an `armed` flag to each `ManagedSession`. New Tauri commands toggle/read/clear it. The `rc-agent` gains a handler for inbound `send_input` frames: a pure `gate(...)` decides Inject vs Reject(reason); on Inject it reuses the existing safe injection path (`operator::inject_to_session`). The `tabs` frame's `armed` field (currently hardcoded `false`) is wired to the real flag. A tab-context-menu item flips arming via the new command.

**Tech Stack:** Rust (Tauri 2, tokio), existing `safety::is_dangerous` + `operator::inject_to_session`, TypeScript (tab strip menu + api.ts).

**Repo:** `~/Sources/karlTerminal`. Work in a git worktree.

**Depends on:** RC-0 Part 1 (relay, live) + Part 2 (rc-agent, merged). This plan is the desktop half of RC-1a; the web half (command input UI + rejected display) is a separate plan.

---

## Context (verified hooks, file:line)

- `ManagedSession` (`crates/app/src/lib.rs:101`): `{ session: Session, _zdotdir: TempDir, world: Arc<Mutex<SessionWorldModel>>, op_state: Arc<std::sync::Mutex<OperatorState>> }`. `AppState.sessions: tokio::sync::Mutex<HashMap<SessionId, ManagedSession>>`.
- `parse_id` (`lib.rs:322`): `fn parse_id(id: &str) -> Result<SessionId, String>` via `Ulid::from_str(id).map(SessionId)`.
- Tauri command style (`lib.rs:876`): `#[tauri::command] async fn set_operator_enabled(state: State<'_, AppState>, session_id: String, enabled: bool) -> Result<(), String>`; registered in `generate_handler![...]` (`lib.rs:3771+`).
- `safety::is_dangerous(text: &str, extra_patterns: &[Regex]) -> Option<BlockedReason>` (`crates/app/src/safety.rs:64`); `BlockedReason { category, message }`.
- `operator::inject_to_session(app: &AppHandle, session_id: SessionId, bytes: &[u8]) -> Result<(), String>` (`crates/app/src/operator.rs:3640`) — currently private; locks `sessions` and calls `managed.session.write(bytes)`.
- rc-agent (`crates/app/src/rc_agent.rs`): `InFrame` (serde tag `t`, has `ListTabs` + `Unknown`), `OutFrame::Tabs`, `collect_tabs` builds `TabInfo` with `armed: false` hardcoded, `run_once` matches inbound frames.
- Tab context menu (`ui/src/tabs/manager.ts:6164` `openTabContextMenu`): builds an `items` array of `{label, icon, onClick}` and calls `this.menu.show(x,y,items)`.
- API wrapper style (`ui/src/api.ts:165`): `export async function setOperatorEnabled(sessionId, enabled) { return invoke("set_operator_enabled", { sessionId, enabled }); }`.

---

## File Structure

- **Modify** `crates/app/src/lib.rs` — add `armed` to `ManagedSession` (construct `Arc::new(Mutex::new(false))`); add `rc_set_armed` / `rc_get_armed` / `rc_disarm_all` commands; register them.
- **Modify** `crates/app/src/operator.rs` — make `inject_to_session` `pub(crate)`.
- **Modify** `crates/app/src/rc_agent.rs` — add `SendInput` inbound frame + `Rejected` outbound frame; a pure `gate(...)` fn (unit-tested); a `handle_send_input` glue; wire `collect_tabs` to read the real `armed` flag; handle the frame in `run_once`.
- **Modify** `ui/src/api.ts` — `setRemoteArmed` / `getRemoteArmed` / `disarmAllRemote` wrappers.
- **Modify** `ui/src/tabs/manager.ts` — an "Allow remote control" toggle item in the tab context menu.

---

## Task 1: `armed` flag on `ManagedSession`

**Files:** Modify `crates/app/src/lib.rs`

- [ ] **Step 1: Add the field**

In the `ManagedSession` struct (`lib.rs:101`), add:
```rust
    /// Per-tab opt-in for remote control (RC-1). Default false, not persisted.
    armed: std::sync::Arc<std::sync::Mutex<bool>>,
```

- [ ] **Step 2: Initialize at every construction site**

Find where `ManagedSession { ... }` is built (search `ManagedSession {`). Add to each:
```rust
            armed: std::sync::Arc::new(std::sync::Mutex::new(false)),
```

- [ ] **Step 3: Verify it compiles**

Run: `cargo build -p covenant`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add crates/app/src/lib.rs
git commit -m "feat(rc-1a): per-session armed flag (default off)"
```

---

## Task 2: Arming commands + registration

**Files:** Modify `crates/app/src/lib.rs`

- [ ] **Step 1: Add the three commands**

Near `set_operator_enabled` (`lib.rs:876`), add:
```rust
#[tauri::command]
async fn rc_set_armed(state: State<'_, AppState>, session_id: String, armed: bool) -> Result<(), String> {
    let id = parse_id(&session_id)?;
    let sessions = state.sessions.lock().await;
    let managed = sessions.get(&id).ok_or("session not found")?;
    *managed.armed.lock().map_err(|_| "armed lock poisoned")? = armed;
    tracing::info!(session = %id, armed, "remote arming toggled");
    Ok(())
}

#[tauri::command]
async fn rc_get_armed(state: State<'_, AppState>, session_id: String) -> Result<bool, String> {
    let id = parse_id(&session_id)?;
    let sessions = state.sessions.lock().await;
    let managed = sessions.get(&id).ok_or("session not found")?;
    Ok(*managed.armed.lock().map_err(|_| "armed lock poisoned")?)
}

/// Kill-switch: disarm every tab at once.
#[tauri::command]
async fn rc_disarm_all(state: State<'_, AppState>) -> Result<(), String> {
    let sessions = state.sessions.lock().await;
    for managed in sessions.values() {
        if let Ok(mut a) = managed.armed.lock() { *a = false; }
    }
    tracing::info!("remote control: disarmed all tabs");
    Ok(())
}
```

- [ ] **Step 2: Register them**

In `generate_handler![...]` (`lib.rs:3771+`), add `rc_set_armed, rc_get_armed, rc_disarm_all,` near the other `rc_`/operator commands.

- [ ] **Step 3: Verify it compiles**

Run: `cargo build -p covenant`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add crates/app/src/lib.rs
git commit -m "feat(rc-1a): rc_set_armed/rc_get_armed/rc_disarm_all commands"
```

---

## Task 3: Expose the safe injection path

**Files:** Modify `crates/app/src/operator.rs`

- [ ] **Step 1: Make `inject_to_session` callable from rc_agent**

Change its visibility (`operator.rs:3640`) from `async fn inject_to_session` to:
```rust
pub(crate) async fn inject_to_session(
```
(Leave the body unchanged.)

- [ ] **Step 2: Verify it compiles**

Run: `cargo build -p covenant`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add crates/app/src/operator.rs
git commit -m "refactor(rc-1a): make inject_to_session pub(crate)"
```

---

## Task 4: rc-agent — frames, pure gate (unit-tested), send_input handling

**Files:** Modify `crates/app/src/rc_agent.rs`

- [ ] **Step 1: Write the failing tests for the pure gate**

Add to the `tests` module in `rc_agent.rs`:
```rust
    #[test]
    fn gate_rejects_unknown_tab() {
        assert_eq!(gate(None, None), Gate::Reject("no_such_tab"));
    }
    #[test]
    fn gate_rejects_unarmed_tab() {
        assert_eq!(gate(Some(false), None), Gate::Reject("tab_not_armed"));
    }
    #[test]
    fn gate_rejects_blocklisted_even_when_armed() {
        assert_eq!(gate(Some(true), Some(())), Gate::Reject("blocklisted"));
    }
    #[test]
    fn gate_injects_when_armed_and_clean() {
        assert_eq!(gate(Some(true), None), Gate::Inject);
    }
```

- [ ] **Step 2: Implement `Gate` + `gate` (above the tests)**

```rust
#[derive(Debug, PartialEq)]
enum Gate {
    Inject,
    Reject(&'static str),
}

/// Pure arming/safety decision. `armed`: None=no such tab, Some(false)=unarmed,
/// Some(true)=armed. `danger`: Some(_) means the blocklist flagged the input.
fn gate(armed: Option<bool>, danger: Option<()>) -> Gate {
    match armed {
        None => Gate::Reject("no_such_tab"),
        Some(false) => Gate::Reject("tab_not_armed"),
        Some(true) => match danger {
            Some(()) => Gate::Reject("blocklisted"),
            None => Gate::Inject,
        },
    }
}
```

- [ ] **Step 3: Run the gate tests**

Run: `cargo test -p covenant --lib rc_agent::tests`
Expected: PASS (existing 7 + 4 new).

- [ ] **Step 4: Add the `SendInput` inbound + `Rejected` outbound frames**

Extend `InFrame`:
```rust
#[derive(Debug, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
enum InFrame {
    ListTabs,
    SendInput { session_id: String, data: String },
    #[serde(other)]
    Unknown,
}
```
Extend `OutFrame`:
```rust
#[derive(Debug, Serialize)]
#[serde(tag = "t", rename_all = "snake_case")]
enum OutFrame {
    Tabs { device_id: String, tabs: Vec<TabInfo> },
    Rejected { session_id: String, reason: &'static str, message: String },
}
```

- [ ] **Step 5: Implement `handle_send_input` (glue)**

Add (uses `Ulid::from_str`, `crate::AppState`, `crate::safety`, `crate::operator::inject_to_session`):
```rust
use std::str::FromStr;

/// Apply the gate to a remote send_input; inject on success.
/// Returns Some(OutFrame::Rejected) when rejected, None when injected.
async fn handle_send_input(app: &AppHandle, session_id: &str, data: &str) -> Option<OutFrame> {
    let reject = |reason: &'static str, message: String| Some(OutFrame::Rejected {
        session_id: session_id.to_string(), reason, message,
    });

    let id = match ulid::Ulid::from_str(session_id) {
        Ok(u) => karl_session::SessionId(u),
        Err(_) => return reject("no_such_tab", "invalid session id".into()),
    };

    let state = app.try_state::<AppState>()?;

    // Read armed under a scoped lock; DROP before injecting (inject re-locks).
    let armed: Option<bool> = {
        let sessions = state.sessions.lock().await;
        sessions.get(&id).map(|m| *m.armed.lock().map(|g| *g).unwrap_or(&false))
    };

    let danger = crate::safety::is_dangerous(data, &[]);
    match gate(armed, danger.as_ref().map(|_| ())) {
        Gate::Reject("blocklisted") => {
            let msg = danger.map(|d| d.message).unwrap_or_else(|| "blocked".into());
            reject("blocklisted", msg)
        }
        Gate::Reject(reason) => reject(reason, reason.replace('_', " ")),
        Gate::Inject => {
            if let Err(e) = crate::operator::inject_to_session(app, id, data.as_bytes()).await {
                tracing::warn!(target: "rc_agent", error=%e, "inject failed");
                return reject("no_such_tab", e);
            }
            tracing::info!(target: "rc_agent", session=%id, "remote input injected");
            None
        }
    }
}
```
> Verify the real types as you implement: `SessionId` is `karl_session::SessionId(Ulid)` (mirror exactly how `parse_id` constructs it in `lib.rs:322`; import the same path). The `*m.armed.lock()...` line must read the bool by value while the sessions guard is held, then the guard is dropped at the block's end. Adjust the borrow so no lock is held across the later `.await` on `inject_to_session`.

- [ ] **Step 6: Handle the frame in `run_once`**

In `run_once`'s `Message::Text` match, add a `SendInput` arm alongside `ListTabs`:
```rust
                Ok(InFrame::SendInput { session_id, data }) => {
                    if let Some(rej) = handle_send_input(app, &session_id, &data).await {
                        sink.send(Message::Text(serde_json::to_string(&rej)?)).await?;
                    }
                }
```

- [ ] **Step 7: Wire the real `armed` flag into `collect_tabs`**

In `collect_tabs`, the snapshot currently captures `(id, world handle)`. Also capture the armed flag and use it for `TabInfo.armed`:
- When snapshotting under the sessions lock, also read `*managed.armed.lock().unwrap_or(false)` (by value) into the snapshot tuple.
- Set `armed: <that value>` instead of `false`.

- [ ] **Step 8: Run tests + build**

Run: `cargo test -p covenant --lib rc_agent::tests && cargo build -p covenant`
Expected: PASS (11 tests).

- [ ] **Step 9: Commit**

```bash
git add crates/app/src/rc_agent.rs
git commit -m "feat(rc-1a): gated remote send_input + real armed flag in tabs frame"
```

---

## Task 5: Frontend API wrappers

**Files:** Modify `ui/src/api.ts`

- [ ] **Step 1: Add wrappers**

Near `setOperatorEnabled` (`api.ts:165`):
```ts
export async function setRemoteArmed(sessionId: SessionId, armed: boolean): Promise<void> {
  return invoke<void>("rc_set_armed", { sessionId, armed });
}
export async function getRemoteArmed(sessionId: SessionId): Promise<boolean> {
  return invoke<boolean>("rc_get_armed", { sessionId });
}
export async function disarmAllRemote(): Promise<void> {
  return invoke<void>("rc_disarm_all");
}
```

- [ ] **Step 2: Type-check**

Run: `cd ui && npx tsc --noEmit` (or the project's typecheck script)
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add ui/src/api.ts
git commit -m "feat(rc-1a): api wrappers for remote arming"
```

---

## Task 6: Tab context-menu "Allow remote control" toggle

**Files:** Modify `ui/src/tabs/manager.ts`

- [ ] **Step 1: Add the menu item**

In `openTabContextMenu` (`manager.ts:6164`), the method is `async` (it already does `await` per the contextmenu handler). Before building `items`, read current state:
```ts
    let armed = false;
    try { armed = await getRemoteArmed(tab.id as unknown as SessionId); } catch { /* session may be gone */ }
```
Add an item to the `items` array (near the operator section, ~line 6260):
```ts
    items.push({
      label: armed ? "Disable remote control" : "Allow remote control",
      icon: armed ? Icons.antenna?.() : Icons.antennaOff?.(),
      onClick: async () => {
        try { await setRemoteArmed(tab.id as unknown as SessionId, !armed); }
        catch (e) { console.error("toggle remote arming failed", e); }
      },
    });
```
Import `getRemoteArmed`/`setRemoteArmed` from `../api` and use whatever `SessionId` type alias the file uses for a session id (match existing calls; if the menu already calls Tauri commands with `tab.id`, mirror that exact cast). If `Icons.antenna` doesn't exist, use an existing neutral icon (e.g. `Icons.shield?.()` / `Icons.lock?.()`) — do not invent a missing icon.

- [ ] **Step 2: Type-check + build the UI**

Run: `cd ui && npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add ui/src/tabs/manager.ts
git commit -m "feat(rc-1a): tab context-menu toggle for remote control arming"
```

---

## Task 7: Manual verification (with the live relay)

**Files:** none.

- [ ] **Step 1:** Run the app signed in (or with an injected Keychain JWT). Arm a tab via its right-click menu.
- [ ] **Step 2:** From a web client (same `github_id`), send `{"t":"send_input","session_id":"<armed tab id>","data":"echo hello\n"}`. Expected: `echo hello` runs in that tab.
- [ ] **Step 3:** Send to an UNarmed tab → expect a `{"t":"rejected","reason":"tab_not_armed",...}` frame and nothing injected.
- [ ] **Step 4:** Send `rm -rf /` to an armed tab → expect `{"t":"rejected","reason":"blocklisted",...}` and nothing injected.
- [ ] **Step 5:** `list_tabs` now shows `armed:true` for the armed tab.
- [ ] Record results honestly (UNVERIFIED if not run — same Tauri-run friction as Part 2).

---

## Self-Review

**Spec coverage (RC-1 core = arming + gated send_input, desktop half):**
- ✅ Per-tab `armed` (default off, not persisted) — Task 1.
- ✅ Toggle from tab context menu — Task 6.
- ✅ `send_input` gated by arming AND `safety.rs` blocklist; typed `rejected` otherwise — Task 4 (`gate` unit-tested).
- ✅ Reuse the single safe injection path (`inject_to_session`) — Task 3/4.
- ✅ `armed` reflected in the `tabs` frame — Task 4 step 7.
- ✅ Kill-switch `disarm_all` — Task 2 (UI button lands with the RC-1b banner).
- ⏸ Banner "remote control active" + relay web→desktop presence — **RC-1b** (separate plan).
- ⏸ Web command-input UI + rejected display — separate web plan.

**Placeholder scan:** No TODOs. Task 7 is manual with concrete steps. The `armed`-read borrow in Task 4 step 5 and the icon/SessionId-cast in Task 6 carry explicit "verify against real code" notes (planner is one step removed), not placeholders.

**Type consistency:** `armed: Arc<Mutex<bool>>`, `rc_set_armed`/`rc_get_armed`/`rc_disarm_all`, `Gate::{Inject,Reject}`, `gate`, `handle_send_input`, `InFrame::SendInput{session_id,data}`, `OutFrame::Rejected{session_id,reason,message}`, `setRemoteArmed`/`getRemoteArmed`/`disarmAllRemote` are consistent across tasks. Frame `reason` strings (`no_such_tab`/`tab_not_armed`/`blocklisted`) match between `gate` and the web plan's expectations.

---

## Follow-on (other RC-1a / RC-1b slices)

- **RC-1a web**: protocol `send_input` out + `rejected` in; per-armed-tab command input box; rejection toast. (Separate plan, `landing/`.)
- **RC-1b**: desktop banner when ≥1 web client connected + a visible kill-switch button; relay change to push web-presence → desktop.
