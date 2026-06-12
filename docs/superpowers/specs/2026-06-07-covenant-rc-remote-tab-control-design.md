# Covenant RC — Remote Tab Control

**Date:** 2026-06-07
**Status:** Design approved; RC-0 to be planned next
**Surfaces:** `covenant-server` (relay), `karlTerminal` desktop (`crates/app` / `crates/score`), `covenant.uno` web (authed dashboard)

---

## Summary

Log in on a remote website with the same GitHub identity used by the desktop app, and
control the desktop's terminal tabs from there: list/open/close/focus tabs, send input
(keystrokes/prompts) to a tab, and optionally mirror a tab's live screen byte-for-byte.

The desktop dials home to `covenant-server` over a persistent WebSocket; the server is a
dumb, authenticated **relay** that routes opaque frames between endpoints sharing the same
`github_id`. **All real authorization happens on the desktop** (per-tab arming + the
existing `safety.rs` blocklist), so a compromised server cannot touch a terminal without an
armed desktop cooperating.

This is **M6** territory (gated autonomous/remote execution) and is, plainly, remote code
execution on the user's machine. Security is roughly half the work and is non-negotiable.

---

## Decisions (locked during brainstorming)

| Axis | Decision |
|---|---|
| Control scope | Full control: open/close/focus tabs, arbitrary keystrokes, run commands |
| Remote surface | Structured dashboard **+** on-demand live terminal mirror |
| Trust model | Same `github_id` only. No delegation, no teams. |
| Consent model | **Arm per-tab** on the desktop (default off); `safety.rs` blocklist always on |
| Transport | Server-relayed persistent WebSocket, keyed by `github_id` (approach A) |

Explicitly **out of scope** (YAGNI): per-keystroke ConfirmEach, third-party delegation,
team/org membership, queuing commands while desktop offline, WebRTC/P2P, local-tunnel exposure.

---

## Architecture

```
┌─────────────────┐     WSS (JWT)      ┌──────────────────────┐     WSS (JWT)     ┌─────────────────┐
│  Web client     │ ◀───────────────▶  │  covenant-server     │ ◀──────────────▶  │  Desktop app    │
│  (covenant.uno) │   control frames   │  /rc relay           │  control frames   │  (Tauri/Rust)   │
│  dashboard +    │   state/mirror     │  · auth (github_id)  │  state/mirror     │  rc-agent       │
│  xterm mirror   │                    │  · presence registry │                   │                 │
└─────────────────┘                    │  · route by github_id│                   └─────────────────┘
                                       └──────────────────────┘
```

Cross-cutting principle: **the server can never execute anything** — it only routes. A
compromised relay cannot drive a terminal without an armed desktop on the other end.

### Components

**1. `rc-relay` — new module in `covenant-server` (`src/rc.rs`)**
Stateful pipe. In-memory presence registry `Arc<DashMap<github_id, Presence>>` in `AppState`
(nothing persisted to Postgres — consistent with "no payloads on the server"). Does not
inspect frame contents except `target_device_id` (needed for routing). On restart, all
endpoints reconnect.

- `GET /rc/desktop` — WS upgrade; the desktop dials home here.
- `GET /rc/web` — WS upgrade; the dashboard connects here.
- Auth via `Authorization: Bearer <jwt>` on the handshake, verified with the existing
  `jwt::verify`. Invalid → close `4401`.
- Each socket runs read/write tasks bridged by an `mpsc` to its counterpart, resolved by
  `github_id`.

**2. `rc-agent` — new module in the desktop (`crates/app` or `crates/score`)**
The executing end. Keeps the outbound WS alive (reconnect with exponential backoff 1s→30s),
reuses the JWT from the macOS Keychain (`auth::load_jwt`). Translates inbound control frames
into existing internal commands (`spawn_session`, `inject_to_session`, `close_session`,
list). Subscribes to the session `tokio::broadcast` bus and pushes state/events upstream. For
mirror, subscribes to one tab's raw byte stream and forwards it. **Per-tab arming gate lives
here** — defense at the executing end, not the server.

**3. `web client` — new authed section on `covenant.uno`**
GitHub OAuth → JWT (same flow as desktop). Dashboard renders the tab list + executor + phase
+ recent blocks from state frames, a command box, and an `xterm.js` instance mounted
on-demand when mirroring a tab.

### Shared proto crate

`rc-proto` — a new crate holding the serde frame enum, depended on by `covenant-server` and
the desktop. The web client mirrors these types in TypeScript (hand-mirrored or generated).

---

## Connection, auth & presence

Handshake (identical for both endpoints):
1. Client opens `wss://forge.covenant.uno/rc/{desktop|web}` with `Authorization: Bearer <jwt>`.
2. Relay verifies JWT (same `jwt::verify` as `/sync/*`) → extracts `github_id`. Invalid → close `4401`.
3. Relay registers the connection in `presence[github_id].{desktops|web_clients}`.
4. Relay sends the counterpart a `presence` frame
   (e.g. to web: `{ desktop_online: true, desktops: [{ device_id, hostname, n_tabs }] }`).

**Multi-device:** one `github_id` may have several desktops. Each desktop sends a stable
`device_id` (hostname + a persisted UUID). Control frames carry `target_device_id`; the relay
routes to that socket.

**Liveness:** WS ping/pong every 20s (also keeps Azure's ~230s idle timeout from killing the
socket). On desktop drop, the relay clears its entry and notifies the web via `presence`
(dashboard shows "offline"). The `rc-agent` reconnects with backoff and re-announces its tabs.

**No desktop connected:** web stays logged in, shows "no devices online". Nothing is
queued — remote control is live, not deferred.

---

## Frame protocol (`rc-proto`)

Typed JSON frames (serde enum). Two families.

**Web → Desktop (control):**
```jsonc
{ "t": "list_tabs",   "target_device_id": "..." }
{ "t": "open_tab",    "cwd": "~/proj" }
{ "t": "close_tab",   "session_id": "..." }
{ "t": "focus_tab",   "session_id": "..." }
{ "t": "send_input",  "session_id": "...", "data": "git status\n" }
{ "t": "mirror_start","session_id": "..." }
{ "t": "mirror_stop", "session_id": "..." }
```

**Desktop → Web (state/data):**
```jsonc
{ "t": "tabs",        "tabs": [{ "session_id":"", "title":"", "cwd":"", "executor":"", "phase":"", "armed":false }] }
{ "t": "tab_event",   "session_id": "...", "event": "<SessionUiEvent>" }   // reuses existing bus→UI mapping
{ "t": "mirror_data", "session_id": "...", "bytes": "<base64>" }
{ "t": "presence",    "desktop_online": true, "desktops": [ ... ] }
{ "t": "rejected",    "ref": "...", "reason": "tab_not_armed" | "blocklisted" | "no_such_tab" | "open_not_allowed" }
```

Design notes:
- `armed` is a **per-tab** field in `tabs` → the dashboard knows what it may control and
  renders the rest read-only.
- `send_input` and `open_tab`'s command pass through `safety::is_dangerous` on the agent
  before touching the PTY; blocked → `rejected`, nothing executes.
- The relay treats everything as opaque except `target_device_id`. It does not inspect or log
  contents — consistent with "no payloads on the server".
- Mirror uses the **same** WS (`mirror_data` frames), not a separate channel. base64-over-JSON
  is the v1; if throughput bites, switch to binary WS frames without touching the architecture.
- Open question for a later phase: include initial scrollback on `mirror_start`, and a
  `resize` control frame. Deferred from RC-0.

---

## Security model (four layers, outside → PTY)

**Layer 1 — Transport/identity.** Valid JWT + same `github_id`. No socket otherwise. The relay
never routes across different `github_id`s.

**Layer 2 — Per-tab arming (desktop, final authority).** New per-session state `armed: bool`,
default **false**, toggled from the desktop UI (per-tab control, e.g. tab strip or an "Allow
remote control" menu). The `rc-agent` rejects **locally** any `send_input`/`focus`/`close`/
`mirror_start` aimed at an unarmed tab → `rejected{tab_not_armed}`. `open_tab` (creating a new
tab) requires a separate global permission `allow_remote_open`, since there is no prior tab to
arm.

**Layer 3 — Blocklist always on.** Every `send_input` and the `open_tab` command pass through
`safety::is_dangerous` (the same `rm -rf`, `sudo`, `curl|sh`, writes to `~/.ssh`, etc.)
**regardless of arming**. Arming a tab does not disable the blocklist. Blocked →
`rejected{blocklisted}`, nothing touches the PTY.

**Layer 4 — Visibility & cutoff.** While ≥1 remote session is connected for the `github_id`,
the desktop shows a **persistent banner** ("Remote control active · 1 web session · NY") and a
global **kill-switch** that: disarms all tabs, closes the WS, and blocks reconnection until
re-enabled. Every remote action is logged via the existing `save_operator_decision` (audit:
which tab, what input, executed/blocked).

Cutoff does not rely on JWT expiry: disarming a tab severs its live control immediately;
the kill-switch severs everything, agent-side.

Optional hardening considered, deferred unless requested: first-connection PIN/confirmation
for a new web client; auto-disarm timeout on inactivity.

---

## Data flow (send a prompt, see the result)

1. Web: you arm tab `X` from the desktop (physical). Desktop emits `tabs` with `armed:true` →
   dashboard enables it.
2. Web sends `send_input{session:X, data:"run the tests\n"}` → relay → rc-agent.
3. rc-agent: is X armed? yes → `safety::is_dangerous` → ok → `inject_to_session(X, ...)` (the
   single existing injection point).
4. PTY produces output → `tokio::broadcast` → rc-agent (already subscribed) → pushes
   `tab_event` (phase Running→Done) upstream. If mirror is active on X, raw bytes also flow as
   `mirror_data`.
5. Dashboard updates state; the xterm (if mounted) paints output live.

---

## Infra

**Azure App Service.** WebSockets are **not** on by default:
`az webapp config set --name covenant-uno -g covenant-rg --web-sockets-enabled true`.
The container must respect the ~230s idle timeout → hence the 20s ping/pong. Without
`--web-sockets-enabled` the upgrade fails (404/502). Document in `infra/provision-pulzen.sh`.

---

## Testing

- **`rc-proto`**: serde round-trip of every frame (unit).
- **relay**: routing tests with two in-process sockets of same/different `github_id` (same →
  forwards; different → isolated); presence join/leave; invalid auth → close.
- **rc-agent**: gating — unarmed tab rejects; blocklist rejects; armed tab + clean command →
  calls the inject (mock session manager). Reconnect/backoff.
- **e2e** (manual, as elsewhere in the project): a script that logs in, lists tabs, arms,
  sends input, verifies echo — marked UNVERIFIED until run with a live app + key.

---

## Phasing (NOT a single PR)

Crosses 3 surfaces and is M6. Built in vertical slices, each functional and mergeable.

| Phase | Delivers | Risk |
|---|---|---|
| **RC-0** | `rc-proto` + relay with presence + auth; `rc-agent` connects and answers `list_tabs`/`tabs`. Minimal web that logs in and lists tabs. **Read-only.** | Low — no control |
| **RC-1** | Per-tab arming (desktop UI + state + banner + kill-switch) + gated `send_input`. | Medium — gated RCE |
| **RC-2** | `open_tab` / `close_tab` / `focus_tab`. | Medium |
| **RC-3** | On-demand mirror (`mirror_start/stop` + `mirror_data` + web xterm). | Low (additive) |

Each phase gets its own spec → plan → implementation cycle. **Next: plan RC-0.**

---

## Codebase hooks (from the control-surface map)

- **Auth/JWT:** `crates/score/src/auth.rs` (Keychain `covenant.uno`/`covenant-jwt`,
  `load_jwt`, `exchange_with_backend`). Reuse the bearer token for the WS handshake.
- **Single injection point:** `inject_to_session` (`crates/app/src/operator.rs`) after
  `safety::is_dangerous` (`crates/app/src/safety.rs`).
- **Session lifecycle commands:** `spawn_session`, `write_to_session`, `close_session`,
  `kill_session_foreground` (`crates/app/src/lib.rs`).
- **Event bus:** `Session::subscribe()` / `event_sender()` (`crates/session/src/lib.rs`),
  `SessionEvent` → `SessionUiEvent` via `to_ui()`. Reuse for `tab_event`.
- **Server auth + state:** `covenant-server` `jwt::verify`, `AppState`, existing `/sync/*`
  bearer pattern.
