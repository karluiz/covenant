# Covenant RC-1b · Desktop: Remote-Active Pill + Kill-Switch — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** When ≥1 web client is connected to control this desktop, show a subtle corner pill ("● remote · N") and a one-click kill-switch that disarms every tab and cuts remote control. The count comes from the relay's `web_presence` frame.

**Architecture:** The rc-agent gains an inbound `web_presence` frame handler that emits a Tauri event `rc://web-presence` carrying the count. A small frontend module mounts a fixed corner pill that listens for that event, shows itself only when count > 0, and on click calls `disarmAllRemote()`.

**Tech Stack:** Rust (rc-agent, `tauri::Emitter`), TypeScript (`@tauri-apps/api/event` `listen`, existing `disarmAllRemote` in `api.ts`).

**Repo:** `~/Sources/karlTerminal`. Work in a git worktree. App crate package name `covenant`.

**Depends on:** RC-1b relay (web_presence frame, merged + deploying) + RC-1a (`rc_disarm_all` command + `disarmAllRemote` wrapper, merged).

---

## Context (verified hooks)

- rc-agent `crates/app/src/rc_agent.rs`: `InFrame` (serde tag `t`, snake_case) has `ListTabs`, `SendInput{session_id,data}`, `Unknown`. `run_once(app: &AppHandle, ...)` matches inbound text frames at lines ~159-172. `OutFrame`/`collect_tabs`/`handle_send_input` exist.
- Tauri event emit: `use tauri::Emitter; app.emit("topic", payload)`.
- Frontend entry: `ui/src/main.ts`. Event listening uses `import { listen } from "@tauri-apps/api/event"` (already used in `ui/src/main.ts` / `inline-notch.ts`).
- `disarmAllRemote(): Promise<void>` already exported from `ui/src/api.ts:180` (calls `rc_disarm_all`).
- Project conventions (MUST follow): never set `element.title` — route hover text through `attachTooltip` from `ui/src/tooltip/tooltip.ts`. UI copy is English-only.

---

## File Structure

- **Modify** `crates/app/src/rc_agent.rs` — `InFrame::WebPresence { web_count: u32 }` + emit `rc://web-presence` in `run_once`. (+ parse unit test.)
- **Create** `ui/src/remote/presence-pill.ts` — the corner pill: mount, listen, render, kill-switch click.
- **Modify** `ui/src/main.ts` — call `mountRemotePresencePill()` once at startup.

---

## Task 1: rc-agent — parse `web_presence` + emit Tauri event

**Files:** Modify `crates/app/src/rc_agent.rs`

- [ ] **Step 1: Add the parse test** (in the `tests` module)

```rust
    #[test]
    fn web_presence_frame_parses() {
        let f: InFrame = serde_json::from_str(r#"{"t":"web_presence","web_count":2}"#).unwrap();
        assert!(matches!(f, InFrame::WebPresence { web_count: 2 }));
    }
```

- [ ] **Step 2: Run → fail**

Run: `cargo test -p covenant --lib rc_agent::tests`
Expected: FAIL (variant missing).

- [ ] **Step 3: Add the variant + handle it**

Extend `InFrame`:
```rust
#[serde(tag = "t", rename_all = "snake_case")]
enum InFrame {
    ListTabs,
    SendInput { session_id: String, data: String },
    WebPresence { web_count: u32 },
    #[serde(other)]
    Unknown,
}
```
In `run_once`'s `Message::Text` match, add an arm (alongside `ListTabs`/`SendInput`):
```rust
                Ok(InFrame::WebPresence { web_count }) => {
                    use tauri::Emitter;
                    if let Err(e) = app.emit("rc://web-presence", web_count) {
                        tracing::debug!(target: "rc_agent", error=%e, "emit web-presence failed");
                    }
                }
```

- [ ] **Step 4: Run tests + build**

Run: `cargo test -p covenant --lib rc_agent::tests && cargo build -p covenant`
Expected: PASS (existing + 1 new).

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/rc_agent.rs
git commit -m "feat(rc-1b): rc-agent emits rc://web-presence on web_presence frame"
```

---

## Task 2: Frontend corner pill + kill-switch

**Files:** Create `ui/src/remote/presence-pill.ts`

- [ ] **Step 1: Implement the pill**

Create `ui/src/remote/presence-pill.ts`:

```ts
import { listen } from "@tauri-apps/api/event";
import { disarmAllRemote } from "../api";
import { attachTooltip } from "../tooltip/tooltip";

/**
 * Corner indicator shown only while ≥1 web client is remote-controlling this
 * desktop. Click the kill-switch to disarm every tab and cut remote control.
 */
export function mountRemotePresencePill(doc: Document = document): void {
  const pill = doc.createElement("div");
  pill.id = "rc-presence-pill";
  pill.setAttribute("role", "status");
  pill.style.cssText = [
    "position:fixed", "top:10px", "right:12px", "z-index:99999",
    "display:none", "align-items:center", "gap:8px",
    "padding:4px 8px 4px 10px", "border-radius:999px",
    "background:rgba(20,8,8,0.92)", "border:1px solid rgba(255,80,80,0.5)",
    "box-shadow:0 2px 10px rgba(0,0,0,0.4)",
    "font:600 11px ui-monospace,Menlo,monospace", "color:#ffb3b3",
    "-webkit-app-region:no-drag", "user-select:none",
  ].join(";");

  const dot = doc.createElement("span");
  dot.style.cssText = "width:7px;height:7px;border-radius:50%;background:#ff5050;box-shadow:0 0 6px #ff5050;animation:rc-pulse 1.6s ease-in-out infinite";

  const label = doc.createElement("span");

  const kill = doc.createElement("button");
  kill.textContent = "Disable all";
  kill.style.cssText = "border:1px solid rgba(255,80,80,0.5);background:rgba(255,80,80,0.12);color:#ffd0d0;border-radius:999px;padding:2px 8px;font:inherit;cursor:pointer";
  attachTooltip(kill, "Disarm every tab and cut remote control");
  kill.addEventListener("click", () => { void disarmAllRemote(); });

  pill.append(dot, label, kill);
  doc.body.appendChild(pill);

  // keyframes for the dot pulse (inject once)
  if (!doc.getElementById("rc-pulse-kf")) {
    const style = doc.createElement("style");
    style.id = "rc-pulse-kf";
    style.textContent = "@keyframes rc-pulse{0%,100%{opacity:1}50%{opacity:.3}}";
    doc.head.appendChild(style);
  }

  let count = 0;
  const render = () => {
    pill.style.display = count > 0 ? "flex" : "none";
    label.textContent = `remote · ${count}`;
  };
  render();

  void listen<number>("rc://web-presence", (e) => {
    count = typeof e.payload === "number" ? e.payload : 0;
    render();
  });
}
```

> Verify `attachTooltip`'s exact signature against `ui/src/tooltip/tooltip.ts` (it's `attachTooltip(el, text)` per project convention); adjust the call if the signature differs. Do NOT use `element.title`.

- [ ] **Step 2: Type-check**

Run: `cd ui && npx tsc --noEmit` (or the project's typecheck path — the root `tsconfig.json` may be the right target; mirror how other `ui/src` modules are checked).
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add ui/src/remote/presence-pill.ts
git commit -m "feat(rc-1b): remote-active corner pill + kill-switch"
```

---

## Task 3: Mount the pill at startup

**Files:** Modify `ui/src/main.ts`

- [ ] **Step 1: Import + call**

In `ui/src/main.ts`, add the import near the other module imports:
```ts
import { mountRemotePresencePill } from "./remote/presence-pill";
```
And call it once during startup (near where other top-level UI is initialized — after the DOM/body is ready):
```ts
mountRemotePresencePill();
```
> Place it where other one-time UI mounts happen in `main.ts`. If `main.ts` waits for `DOMContentLoaded` or a bootstrap function, call it there so `document.body` exists.

- [ ] **Step 2: Type-check + the app builds**

Run: `cd ui && npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add ui/src/main.ts
git commit -m "feat(rc-1b): mount remote-active pill at startup"
```

---

## Task 4: Manual verification

**Files:** none.

- [ ] Run the app (signed in / injected Keychain JWT so the rc-agent connects).
- [ ] From a web client (same gid) open a `/rc/web` connection. Expect the corner pill to appear: "● remote · 1". Open a second web client → "remote · 2". Close them → pill hides at 0.
- [ ] Arm a tab, then click the pill's "Disable all" → the tab disarms (verify via the tab menu showing "Allow remote control" again, and a subsequent remote `send_input` is rejected `tab_not_armed`).
- [ ] Record honestly (UNVERIFIED if not run — Tauri-run friction).

---

## Self-Review

**Spec coverage (RC-1b desktop):**
- ✅ Pill shows only when web_count > 0, with live count — Tasks 1/2.
- ✅ Corner placement (per the chosen design), subtle, pulsing red dot — Task 2.
- ✅ Kill-switch button → `disarmAllRemote()` (the RC-1a command) — Task 2.
- ✅ Count sourced from the relay `web_presence` frame via a Tauri event — Task 1.
- ✅ No native tooltip (uses `attachTooltip`); English copy — Task 2.

**Placeholder scan:** none. Task 4 is manual with concrete steps. The `attachTooltip` signature and `main.ts` mount location carry explicit "verify against real code" notes.

**Type consistency:** `InFrame::WebPresence { web_count: u32 }` ↔ relay frame `{"t":"web_presence","web_count":N}`; event topic `rc://web-presence` (emit ↔ listen); `mountRemotePresencePill`; `disarmAllRemote`. Consistent.

---

## Follow-on (remaining RC-1b / RC follow-ons)

- Desktop "reveal/copy pairing token" affordance (so users get a token without minting).
- `backend_url()` default fix (covenant.uno → forge.covenant.uno).
- Full-channel manual e2e once the app can be driven.
