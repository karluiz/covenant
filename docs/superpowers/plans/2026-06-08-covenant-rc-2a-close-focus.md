# Covenant RC-2a · Close + Focus Tabs (armed-gated) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Let a remote web client CLOSE or FOCUS a desktop tab — but only a tab that is **armed**. The rc-agent gates on the armed flag and emits a Tauri event that the frontend's TabManager performs; unarmed/unknown targets get a `rejected` frame. The dashboard gains close/focus buttons per armed tab.

**Architecture:** Tabs are a frontend concept, so the rc-agent does not close/focus directly — it gates (armed check) then emits `rc://tab/close` / `rc://tab/focus` with the session id; frontend listeners call `TabManager.closeTab` / `activateBySessionId`. The web sends `close_tab` / `focus_tab` frames; rejections reuse the existing RC-1a rejection display.

**Tech Stack:** Rust (rc-agent), TypeScript (ui/main.ts listeners + TabManager; landing dashboard).

**Repo:** `~/Sources/karlTerminal` (app crate `covenant`; `ui/` desktop frontend; `landing/` web dashboard, pnpm). Work in one git worktree.

**Depends on:** RC-1a (armed flag, `gate`, rejected frames, web command input — all merged) + RC-1b. Defers `open_tab` to RC-2b (needs a global `allow_remote_open` permission).

---

## Context (verified hooks, file:line)

- rc-agent `crates/app/src/rc_agent.rs`: `InFrame` (serde tag `t`, snake_case) has `ListTabs`, `SendInput`, `WebPresence{web_count}`, `Unknown`. `run_once(app: &AppHandle, ...)` matches inbound text frames. `OutFrame::Rejected{session_id,reason,message}` exists. `handle_send_input` reads the armed flag by value under a scoped `sessions` lock (drops guard before await). `SessionId = karl_session::SessionId(Ulid)`; parse via `ulid::Ulid::from_str`. Emits already use `tauri::Emitter` (`app.emit("rc://web-presence", n)`).
- Armed flag: `ManagedSession.armed: Arc<AtomicBool>` (`lib.rs:108`), read `m.armed.load(Ordering::Relaxed)`.
- Frontend TabManager (`ui/src/tabs/manager.ts`): `closeTab(id: string): void` (5045), `activateBySessionId(sessionId: SessionId): boolean` (2704). A tab-for-session lookup exists — VERIFY the exact name (`tabForSession`/`tabBySession`) before use. Singleton exported as `tabsManager` from `ui/src/main.ts:66`; `manager` local in `boot()` (`main.ts:874`) where event listeners are wired (~886).
- Frontend listen pattern: `listen<T>("topic", (e) => ...)` from `@tauri-apps/api/event` (see `ui/src/remote/presence-pill.ts:50`).
- Web dashboard `landing/src/remote/protocol.ts`: `Frame` includes `rejected`; `sendInputFrame(sessionId,text)`. Island `landing/src/islands/RemoteDashboard.ts` renders per-armed-tab controls and shows `state.rejections[session_id]`.

---

## Task 1: rc-agent — CloseTab/FocusTab frames + armed gate + emit/reject

**Files:** Modify `crates/app/src/rc_agent.rs`

- [ ] **Step 1: Add failing tests** (in `tests` module)

```rust
    #[test]
    fn close_tab_frame_parses() {
        let f: InFrame = serde_json::from_str(r#"{"t":"close_tab","session_id":"s1"}"#).unwrap();
        assert!(matches!(f, InFrame::CloseTab { .. }));
    }
    #[test]
    fn focus_tab_frame_parses() {
        let f: InFrame = serde_json::from_str(r#"{"t":"focus_tab","session_id":"s1"}"#).unwrap();
        assert!(matches!(f, InFrame::FocusTab { .. }));
    }
    #[test]
    fn lifecycle_gate_decision_matches_armed() {
        assert_eq!(lifecycle_decision(None), Gate::Reject(RejectReason::NoSuchTab));
        assert_eq!(lifecycle_decision(Some(false)), Gate::Reject(RejectReason::NotArmed));
        assert_eq!(lifecycle_decision(Some(true)), Gate::Inject);
    }
```

- [ ] **Step 2: Run → fail**

Run: `cargo test -p covenant --lib rc_agent::tests`
Expected: FAIL.

- [ ] **Step 3: Add the frames + a pure lifecycle decision + a gate helper**

Extend `InFrame` (before `Unknown`):
```rust
    CloseTab { session_id: String },
    FocusTab { session_id: String },
```
Add a pure decision (reuses the existing `Gate`/`RejectReason` from RC-1a — no blocklist for lifecycle, only arming):
```rust
/// Arming-only gate for lifecycle ops (close/focus). No blocklist (no command text).
fn lifecycle_decision(armed: Option<bool>) -> Gate {
    match armed {
        None => Gate::Reject(RejectReason::NoSuchTab),
        Some(false) => Gate::Reject(RejectReason::NotArmed),
        Some(true) => Gate::Inject,
    }
}
```
Add a glue helper that reads armed and returns either the parsed id (allowed) or a Rejected frame:
```rust
async fn lifecycle_gate(app: &AppHandle, session_id: &str) -> Result<karl_session::SessionId, OutFrame> {
    use std::str::FromStr;
    let make_reject = |reason: &'static str, message: String| OutFrame::Rejected {
        session_id: session_id.to_string(), reason, message,
    };
    let id = match ulid::Ulid::from_str(session_id) {
        Ok(u) => karl_session::SessionId(u),
        Err(_) => return Err(make_reject("no_such_tab", "invalid session id".into())),
    };
    let Some(state) = app.try_state::<crate::AppState>() else {
        return Err(make_reject("no_such_tab", "no app state".into()));
    };
    let armed: Option<bool> = {
        let sessions = state.sessions.lock().await;
        sessions.get(&id).map(|m| m.armed.load(std::sync::atomic::Ordering::Relaxed))
    }; // guard dropped here
    match lifecycle_decision(armed) {
        Gate::Inject => Ok(id),
        Gate::Reject(reason) => {
            let (code, message) = reject_payload(reason, None);
            Err(make_reject(code, message))
        }
    }
}
```
In `run_once`'s text-frame match, add two arms (alongside the others):
```rust
                Ok(InFrame::CloseTab { session_id }) => {
                    match lifecycle_gate(app, &session_id).await {
                        Ok(id) => {
                            use tauri::Emitter;
                            let _ = app.emit("rc://tab/close", id.to_string());
                        }
                        Err(rej) => { sink.send(Message::Text(serde_json::to_string(&rej)?)).await?; }
                    }
                }
                Ok(InFrame::FocusTab { session_id }) => {
                    match lifecycle_gate(app, &session_id).await {
                        Ok(id) => {
                            use tauri::Emitter;
                            let _ = app.emit("rc://tab/focus", id.to_string());
                        }
                        Err(rej) => { sink.send(Message::Text(serde_json::to_string(&rej)?)).await?; }
                    }
                }
```

- [ ] **Step 4: Run tests + build**

Run: `cargo test -p covenant --lib rc_agent::tests && cargo build -p covenant`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/rc_agent.rs
git commit -m "feat(rc-2a): gated close_tab/focus_tab frames → rc://tab events"
```

---

## Task 2: Frontend listeners — perform close/focus via TabManager

**Files:** Modify `ui/src/main.ts`

- [ ] **Step 1: Verify the tab-for-session lookup name**

In `ui/src/tabs/manager.ts`, confirm the method that returns a tab (or its id) for a `SessionId` (likely `tabForSession`). Note its exact name + return shape.

- [ ] **Step 2: Add listeners in `boot()` after `manager` is created** (near the other `listen(...)` wiring, ~`main.ts:886`)

```ts
  void listen<string>("rc://tab/close", (e) => {
    const sid = e.payload as unknown as SessionId;
    const tab = manager.tabForSession(sid); // adjust to the verified method
    if (tab) manager.closeTab(tab.id);
  });
  void listen<string>("rc://tab/focus", (e) => {
    manager.activateBySessionId(e.payload as unknown as SessionId);
  });
```
Use the `SessionId` type/cast already used elsewhere in `main.ts`. Ensure `listen` is imported (it is, for other events). `closeTab` may open a MindLossModal on unsaved operator memory — that desktop-side confirmation is acceptable (the local user gates destructive closes); note it, don't bypass it.

- [ ] **Step 3: Type-check**

Run: `cd ui && npx tsc --noEmit` (or the repo-root tsconfig).
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add ui/src/main.ts
git commit -m "feat(rc-2a): frontend listeners drive TabManager close/focus from rc events"
```

---

## Task 3: Web protocol — close/focus frame builders (+ unit tests)

**Files:** Modify `landing/src/remote/protocol.test.ts`, `landing/src/remote/protocol.ts`

- [ ] **Step 1: Add failing tests**

```ts
import { closeTabFrame, focusTabFrame } from "./protocol";
describe("lifecycle frames", () => {
  it("builds close_tab", () => { expect(closeTabFrame("s1")).toBe(JSON.stringify({ t: "close_tab", session_id: "s1" })); });
  it("builds focus_tab", () => { expect(focusTabFrame("s1")).toBe(JSON.stringify({ t: "focus_tab", session_id: "s1" })); });
});
```

- [ ] **Step 2: Implement**

```ts
export function closeTabFrame(sessionId: string): string { return JSON.stringify({ t: "close_tab", session_id: sessionId }); }
export function focusTabFrame(sessionId: string): string { return JSON.stringify({ t: "focus_tab", session_id: sessionId }); }
```

- [ ] **Step 3: Run → pass**

Run: `cd landing && pnpm test:unit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add landing/src/remote/protocol.ts landing/src/remote/protocol.test.ts
git commit -m "feat(remote): close_tab/focus_tab frame builders"
```

---

## Task 4: Web island — Focus + Close buttons per armed tab (+ Playwright)

**Files:** Modify `landing/src/islands/RemoteDashboard.ts`, `landing/tests/remote.spec.ts`

- [ ] **Step 1: Add buttons to the armed-tab control row**

Import `closeTabFrame, focusTabFrame` from `../remote/protocol`. In `render()`, for armed tabs, add two buttons next to Send, each with `data-sid`:
```ts
        ... existing Send button ...
        <button data-sid="${escapeAttr(t.session_id)}" class="rc-focus rounded border border-zinc-700 bg-zinc-800/40 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-700/50">Focus</button>
        <button data-sid="${escapeAttr(t.session_id)}" class="rc-close rounded border border-red-800 bg-red-900/20 px-2 py-1 text-xs text-red-300 hover:bg-red-900/40">Close</button>
```
Extend the delegated `click` handler on `tabsEl` (the one that already handles `.rc-send`) to also handle `.rc-focus` and `.rc-close`:
```ts
    const focusBtn = (e.target as HTMLElement).closest("button.rc-focus") as HTMLElement | null;
    if (focusBtn && ws && ws.readyState === WebSocket.OPEN) { ws.send(focusTabFrame(focusBtn.getAttribute("data-sid") || "")); return; }
    const closeBtn = (e.target as HTMLElement).closest("button.rc-close") as HTMLElement | null;
    if (closeBtn && ws && ws.readyState === WebSocket.OPEN) { ws.send(closeTabFrame(closeBtn.getAttribute("data-sid") || "")); return; }
```
(Place these checks before/after the existing `.rc-send` check; keep one delegated listener.)

- [ ] **Step 2: Playwright test**

Append a test: armed tab `s1` shows `button.rc-focus`/`button.rc-close`; unarmed `s2` shows neither; clicking Focus sends `{"t":"focus_tab","session_id":"s1"}`, clicking Close sends `{"t":"close_tab","session_id":"s1"}` (assert via the captured `window.__sent`). Mirror the existing FakeWS pattern.

- [ ] **Step 3: Run**

Run: `cd landing && pnpm test:unit && pnpm build && pnpm test -- remote.spec.ts`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add landing/src/islands/RemoteDashboard.ts landing/tests/remote.spec.ts
git commit -m "feat(remote): Focus/Close buttons per armed tab"
```

---

## Task 5: Manual end-to-end

**Files:** none.

- [ ] Desktop signed in, arm a tab. On `/remote`, click that tab's **Focus** → desktop switches to it. Click **Close** → tab closes (a MindLossModal may prompt on the desktop if there's unsaved operator memory).
- [ ] Try Close/Focus on an UNarmed tab (no buttons rendered; if forced, expect `rejected` `tab_not_armed`).
- [ ] Record honestly (UNVERIFIED if not run).

---

## Self-Review

**Spec coverage (RC-2a):**
- ✅ close_tab + focus_tab, gated on the target being armed — Task 1 (`lifecycle_decision` unit-tested).
- ✅ Backend gates then routes to frontend (tabs are a frontend concept) — Tasks 1/2.
- ✅ Rejections reuse the RC-1a display — Tasks 1/4.
- ✅ Dashboard Focus/Close buttons only on armed tabs — Task 4.
- ⏸ open_tab + `allow_remote_open` — **RC-2b** (deferred per decision).

**Placeholder scan:** none. Task 2 step 1 (verify `tabForSession` name) and Task 5 are explicit verification/manual steps, not placeholders.

**Type consistency:** `InFrame::{CloseTab,FocusTab}{session_id}` ↔ web `closeTabFrame`/`focusTabFrame` ↔ events `rc://tab/close`/`rc://tab/focus`; reuses `Gate`/`RejectReason`/`reject_payload` from RC-1a; reject `reason` strings (`no_such_tab`/`tab_not_armed`) match the web's rejection display. Classes `rc-focus`/`rc-close` match between island + Playwright.

---

## Follow-on

- **RC-2b**: `open_tab` with a global `allow_remote_open` toggle (default off) + UI to enable it, routing to `TabManager.createTab`.
- RC-3: live mirror (xterm in the dashboard).
- Follow-ons: pairing-token affordance; `backend_url()` fix.
