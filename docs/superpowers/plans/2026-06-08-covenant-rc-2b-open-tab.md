# Covenant RC-2b · Open Tab (global allow_remote_open) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Let a remote web client open a NEW desktop tab — but only when the user has explicitly enabled "allow remote tab creation" (a global toggle, default OFF, living in the remote-active pill). This is RCE-adjacent (a new shell), so the gate is a deliberate global opt-in, separate from per-tab arming.

**Architecture:** A global `allow_remote_open: AtomicBool` (default false) on `AppState`, toggled by Tauri commands and surfaced as a checkbox in the corner pill. The rc-agent handles an `open_tab` frame: if the flag is on, emit `rc://tab/open` (with optional cwd) → frontend `TabManager.createTab`; else reply `rejected{open_not_allowed}`. The dashboard gets a "New tab" button and shows an open-rejection message.

**Tech Stack:** Rust (AppState flag, rc-agent), TypeScript (pill toggle, main.ts listener, landing dashboard).

**Repo:** `~/Sources/karlTerminal` (app crate `covenant`; `ui/`; `landing/` pnpm). One git worktree.

**Depends on:** RC-2a (lifecycle frames, `OutFrame::Rejected`, dashboard rejection display) + RC-1b (pill). Completes the tab-lifecycle milestone.

---

## Context (verified hooks)

- `AppState` (`crates/app/src/lib.rs:107`) holds per-session `sessions` + globals like `aom: AomHandle`. Add a global flag here. `ManagedSession.armed: Arc<AtomicBool>` shows the atomic pattern.
- Tauri command style (`lib.rs:876`): `#[tauri::command] async fn ...(state: State<'_, AppState>, ...) -> Result<...,String>`; registered in `generate_handler![...]` (`lib.rs:3771+`). RC-1a added `rc_set_armed`/`rc_get_armed`/`rc_disarm_all`.
- rc-agent `crates/app/src/rc_agent.rs`: `InFrame` (serde tag `t`) has `ListTabs`/`SendInput`/`WebPresence`/`CloseTab`/`FocusTab`/`Unknown`. `run_once(app: &AppHandle, ...)`. `OutFrame::Rejected{session_id, reason:&'static str, message:String}`. Emits via `tauri::Emitter`.
- Pill `ui/src/remote/presence-pill.ts`: builds a fixed pill with a `label` + a "Disable all" `kill` button; listens `rc://web-presence`. Has access to `disarmAllRemote` from `../api`.
- api.ts wrappers (`ui/src/api.ts`): `setRemoteArmed`/`getRemoteArmed`/`disarmAllRemote` (RC-1a). Add `setRemoteAllowOpen`/`getRemoteAllowOpen`.
- Frontend listeners + `TabManager` `createTab(opts?: {cwd?: string|null, ...}): Promise<Tab|null>` (manager.ts:2747) wired in `ui/src/main.ts` `boot()`.
- Web `landing/src/remote/protocol.ts` (`sendInputFrame`/`closeTabFrame`/`focusTabFrame`, `reduce` stores `rejections[session_id]`). Island `RemoteDashboard.ts` renders `#rc-tabs`; page `landing/src/pages/remote.astro` has `#rc-token`/`#rc-connect`/`#rc-status`/`#rc-tabs`.

---

## Task 1: Global `allow_remote_open` flag + commands

**Files:** Modify `crates/app/src/lib.rs`

- [ ] **Step 1: Add the field to `AppState`**

```rust
    /// Global opt-in for remote tab creation (RC-2b). Default false, not persisted.
    allow_remote_open: std::sync::Arc<std::sync::atomic::AtomicBool>,
```
Initialize where `AppState { ... }` is constructed:
```rust
            allow_remote_open: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
```

- [ ] **Step 2: Add commands + register**

```rust
#[tauri::command]
async fn rc_set_allow_open(state: State<'_, AppState>, allow: bool) -> Result<(), String> {
    state.allow_remote_open.store(allow, std::sync::atomic::Ordering::Relaxed);
    tracing::info!(allow, "remote tab creation toggled");
    Ok(())
}
#[tauri::command]
async fn rc_get_allow_open(state: State<'_, AppState>) -> Result<bool, String> {
    Ok(state.allow_remote_open.load(std::sync::atomic::Ordering::Relaxed))
}
```
Register `rc_set_allow_open, rc_get_allow_open,` in `generate_handler![...]`.

- [ ] **Step 3: Build**

Run: `cargo build -p covenant`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add crates/app/src/lib.rs
git commit -m "feat(rc-2b): global allow_remote_open flag + commands (default off)"
```

---

## Task 2: rc-agent — open_tab frame, global gate, emit/reject

**Files:** Modify `crates/app/src/rc_agent.rs`

- [ ] **Step 1: Add a parse test**

```rust
    #[test]
    fn open_tab_frame_parses() {
        let f: InFrame = serde_json::from_str(r#"{"t":"open_tab","cwd":"~/p"}"#).unwrap();
        assert!(matches!(f, InFrame::OpenTab { .. }));
        let f2: InFrame = serde_json::from_str(r#"{"t":"open_tab"}"#).unwrap();
        assert!(matches!(f2, InFrame::OpenTab { cwd: None }));
    }
```

- [ ] **Step 2: Add the variant + handler**

Extend `InFrame` (before `Unknown`):
```rust
    OpenTab { #[serde(default)] cwd: Option<String> },
```
Add the handler (global gate, not per-session):
```rust
async fn handle_open_tab(app: &AppHandle, cwd: Option<String>) -> Option<OutFrame> {
    let state = app.try_state::<crate::AppState>()?;
    if !state.allow_remote_open.load(std::sync::atomic::Ordering::Relaxed) {
        return Some(OutFrame::Rejected {
            session_id: String::new(),
            reason: "open_not_allowed",
            message: "remote tab creation is disabled on the desktop".into(),
        });
    }
    use tauri::Emitter;
    let _ = app.emit("rc://tab/open", cwd);
    tracing::info!(target: "rc_agent", "remote open_tab");
    None
}
```
In `run_once`'s text match, add:
```rust
                Ok(InFrame::OpenTab { cwd }) => {
                    if let Some(rej) = handle_open_tab(app, cwd).await {
                        sink.send(Message::Text(serde_json::to_string(&rej)?)).await?;
                    }
                }
```

- [ ] **Step 3: Test + build**

Run: `cargo test -p covenant --lib rc_agent::tests && cargo build -p covenant`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add crates/app/src/rc_agent.rs
git commit -m "feat(rc-2b): gated open_tab frame → rc://tab/open or open_not_allowed reject"
```

---

## Task 3: Frontend — open listener + pill toggle

**Files:** Modify `ui/src/api.ts`, `ui/src/main.ts`, `ui/src/remote/presence-pill.ts`

- [ ] **Step 1: api.ts wrappers**

```ts
export async function setRemoteAllowOpen(allow: boolean): Promise<void> { return invoke<void>("rc_set_allow_open", { allow }); }
export async function getRemoteAllowOpen(): Promise<boolean> { return invoke<boolean>("rc_get_allow_open"); }
```

- [ ] **Step 2: main.ts — open listener** (in `boot()` near the other rc listeners)

```ts
  void listen<string | null>("rc://tab/open", (e) => {
    void manager.createTab({ cwd: e.payload ?? null });
  });
```

- [ ] **Step 3: pill — "allow new tabs" checkbox**

In `ui/src/remote/presence-pill.ts`, import `setRemoteAllowOpen, getRemoteAllowOpen` from `../api`. Add a small labeled checkbox to the pill (before the `kill` button). On mount, set its checked state from `getRemoteAllowOpen()`. On change, call `setRemoteAllowOpen(checkbox.checked)`. Use `attachTooltip` (not `title`) for any hover text; English copy. Example:
```ts
  const openWrap = doc.createElement("label");
  openWrap.style.cssText = "display:flex;align-items:center;gap:4px;cursor:pointer;color:#ffd0d0";
  const openCb = doc.createElement("input");
  openCb.type = "checkbox";
  openCb.style.cssText = "cursor:pointer";
  attachTooltip(openWrap, "Allow remote clients to open new tabs");
  const openTxt = doc.createElement("span");
  openTxt.textContent = "new tabs";
  openWrap.append(openCb, openTxt);
  openCb.addEventListener("change", () => { void setRemoteAllowOpen(openCb.checked); });
  void getRemoteAllowOpen().then((v) => { openCb.checked = v; }).catch(() => {});
  // insert openWrap before the kill button:
  pill.append(dot, label, openWrap, kill);
```
(Replace the existing single `pill.append(dot, label, kill)` with the version including `openWrap`.)

- [ ] **Step 4: Type-check**

Run: `cd ui && npx tsc --noEmit` (or repo-root tsconfig; symlink node_modules into the worktree if needed, then remove).
Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add ui/src/api.ts ui/src/main.ts ui/src/remote/presence-pill.ts
git commit -m "feat(rc-2b): rc://tab/open listener + 'allow new tabs' pill toggle"
```

---

## Task 4: Web — New Tab button + open rejection display

**Files:** Modify `landing/src/remote/protocol.ts`(+test), `landing/src/pages/remote.astro`, `landing/src/islands/RemoteDashboard.ts`, `landing/tests/remote.spec.ts`

- [ ] **Step 1: protocol builder + test**

Test:
```ts
import { openTabFrame } from "./protocol";
describe("open_tab frame", () => {
  it("builds open_tab with no cwd", () => { expect(openTabFrame()).toBe(JSON.stringify({ t: "open_tab" })); });
  it("builds open_tab with cwd", () => { expect(openTabFrame("~/p")).toBe(JSON.stringify({ t: "open_tab", cwd: "~/p" })); });
});
```
Implement:
```ts
export function openTabFrame(cwd?: string): string {
  return cwd ? JSON.stringify({ t: "open_tab", cwd }) : JSON.stringify({ t: "open_tab" });
}
```
Run `cd landing && pnpm test:unit`. (Open rejections arrive as a `rejected` frame with `session_id:""`; the existing `reduce` already stores `rejections[""]=message` — no protocol change needed for that.)

- [ ] **Step 2: New Tab button on the page**

In `landing/src/pages/remote.astro`, add a button near the status line (above `#rc-tabs`):
```html
<button id="rc-new-tab" class="mb-3 rounded border border-emerald-700 bg-emerald-900/30 px-3 py-1 text-xs text-emerald-300 hover:bg-emerald-900/50">+ New tab</button>
<p id="rc-open-error" class="mb-3 text-xs text-red-400"></p>
```

- [ ] **Step 3: island — wire New Tab + render open errors**

In `RemoteDashboard.ts` (`mountRemoteDashboard`), import `openTabFrame`. Resolve `#rc-new-tab` and `#rc-open-error`. On click → if `ws.readyState===OPEN`, `ws.send(openTabFrame())`. In `render()`, set `#rc-open-error` textContent to `state.rejections[""] ?? ""` (the global open rejection). Clear it (optimistically) when a New Tab click is sent.

- [ ] **Step 4: Playwright test**

Append: click `#rc-new-tab` → asserts `{"t":"open_tab"}` in `window.__sent`; inject a `rejected` frame with `session_id:""`, `reason:"open_not_allowed"` → assert `#rc-open-error` shows the message.

- [ ] **Step 5: Run**

Run: `cd landing && pnpm test:unit && pnpm build && pnpm test -- remote.spec.ts`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add landing/src/remote/protocol.ts landing/src/remote/protocol.test.ts landing/src/pages/remote.astro landing/src/islands/RemoteDashboard.ts landing/tests/remote.spec.ts
git commit -m "feat(remote): New Tab button + open_not_allowed rejection display"
```

---

## Task 5: Manual end-to-end

**Files:** none.

- [ ] Desktop running, a web client connected (pill visible). With "new tabs" UNCHECKED, click `+ New tab` on the dashboard → expect `#rc-open-error` "remote tab creation is disabled…" and NO new tab.
- [ ] Check the pill's "new tabs" → click `+ New tab` again → a new tab opens on the desktop.
- [ ] Uncheck → open is rejected again.
- [ ] Record honestly (UNVERIFIED if not run).

---

## Self-Review

**Spec coverage (RC-2b):**
- ✅ `open_tab` gated on a GLOBAL `allow_remote_open` (default off), not per-tab arming — Tasks 1/2.
- ✅ Toggle lives in the pill — Task 3.
- ✅ Allowed → `TabManager.createTab(cwd?)`; denied → `rejected{open_not_allowed}` shown in the dashboard — Tasks 2/3/4.
- ✅ New Tab button on the dashboard — Task 4.

**Placeholder scan:** none. Task 5 is manual with concrete steps. Typecheck-via-symlink is an explicit env note.

**Type consistency:** `allow_remote_open: Arc<AtomicBool>`; `rc_set_allow_open`/`rc_get_allow_open` ↔ `setRemoteAllowOpen`/`getRemoteAllowOpen`; `InFrame::OpenTab{cwd:Option<String>}` ↔ web `openTabFrame(cwd?)` (`{"t":"open_tab"}` / `{"t":"open_tab","cwd":...}`); event `rc://tab/open` (emit Option<String> ↔ listen `string|null`); reject `reason:"open_not_allowed"` with `session_id:""` ↔ `reduce` `rejections[""]` ↔ `#rc-open-error`.

---

## Follow-on

- RC-3: live mirror (xterm in the dashboard reflecting a tab's screen).
- Follow-ons: pairing-token affordance; `backend_url()` fix.
