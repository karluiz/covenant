# Remote Dashboard Master–Detail Redesign

**Date:** 2026-06-10
**Scope:** `landing/` only — no relay or desktop changes. The RC protocol already carries everything needed.

## Problem

The `/remote` dashboard renders every tab as a full-height card in a single vertical stack, in relay order. With many open tabs, armed tabs (the only actionable ones) drown in a wall of "not armed" cards. The Mirror panel is statically mounted *after* the tab list, so starting a mirror opens it at the bottom of the page, off-screen from the card that triggered it.

## Solution

Replace the card stack with a master–detail layout: a compact tab list (master) and a detail pane holding controls and the live mirror for the selected tab.

### Shell

- Slim top bar: presence pill (`● desktop online` / `○ not connected` / `○ disconnected — retrying`), paired state, and the "+ New tab" button.
- Once a connection is established with a stored token, the token input collapses to a small "change token" affordance. Clicking it re-expands the input.
- Below the bar, the main area is a CSS grid:
  - **≥ 768px:** two columns — tab list (~280px fixed) | detail pane (1fr). Both always visible; the mirror never leaves the viewport.
  - **< 768px:** one pane at a time. The list is the default screen; tapping a row navigates to a full-screen detail pane with a `←` back button that returns to the list. No URL routing — view state is in-memory.

### Tab list (master)

- One compact row per tab:
  - Status dot: green filled = armed, grey hollow = not armed.
  - `GROUP › title` (truncated with ellipsis).
  - Right-aligned `executor · phase`.
- Sort: armed tabs first, then by group name (case-insensitive), then title; stable within ties.
- The selected row gets a highlighted background. Rows are buttons (keyboard-focusable).
- Unarmed tabs are no longer collapsed or hidden — at one line each they are cheap to scan.

### Selection

- Keyed by `session_id`, held in dashboard state alongside `DashState`.
- Survives `tabs` frame re-renders (the frame is authoritative for tab data, not selection).
- On first `tabs` frame after connect: auto-select the first armed tab; if none armed, no selection (detail pane shows an empty state: "Select a tab" / "No tabs armed — arm one on the desktop").
- If a `tabs` frame no longer contains the selected `session_id`: fall back to the first armed tab, else empty state. Any active mirror for the vanished tab is stopped/disposed.

### Detail pane

- Header: `GROUP › title`, cwd, `executor · phase`, armed badge.
- **Armed tab:**
  - Controls row: command input + Send, Focus, Close.
  - Mirror fills the remaining pane height (xterm.js + fit addon). Auto-started on selection (see lifecycle below). No Mirror button — the mirror is the pane.
  - `rejected` frames for this session render as an inline error in the pane.
- **Not armed tab:** metadata + "Arm this tab on the desktop to control it." Nothing else — `lifecycle_gate` on the desktop (rc_agent.rs) rejects `send_input`, `focus_tab`, `close_tab`, and `mirror_start` for unarmed tabs, so offering those controls would only produce rejections.

### Mirror lifecycle

- A mirror runs only while the detail pane is visible: always on desktop, only in the detail view on phones. Auto-selection on connect therefore starts a mirror immediately on desktop, but on a phone the mirror starts when the user enters the detail view.
- Selecting an armed tab (with the detail pane visible) sends `mirror_start { session_id }`.
- Switching selection sends `mirror_stop` for the previous session before `mirror_start` for the new one. Exactly one active mirror at a time.
- One xterm instance is reused across selections; `mirror_screen` resets the terminal and writes the dump, `mirror_data` writes incremental bytes (existing behavior).
- On WebSocket close, desktop-offline presence, or selected-tab disappearance: send `mirror_stop` (when the socket is still open) and clear the terminal.
- On the phone layout, navigating back to the list stops the mirror (nothing is watching it).

### Out of scope

- Pairing-token UX beyond collapsing the input.
- Multiple simultaneous mirrors.
- Read-only mirror for unarmed tabs (requires loosening the desktop `lifecycle_gate` — a security decision, not a layout one).
- URL routing / deep links to a tab.

## Architecture

| Unit | Responsibility |
|---|---|
| `landing/src/remote/protocol.ts` | Unchanged — frame types and command builders. |
| `landing/src/remote/view-model.ts` (new) | Pure functions: `sortTabs(tabs)`, `resolveSelection(prevSelected, tabs)`, mirror-transition decision (`{stop?, start?}` given prev/next selection and armed state). No DOM, fully unit-testable. |
| `landing/src/islands/RemoteDashboard.ts` | Rewritten render: top bar, list pane, detail pane, mobile view switching, mirror lifecycle side-effects driven by view-model decisions. Keeps existing focus/caret + IME-composition preservation across re-renders. |
| `landing/src/pages/remote.astro` | New skeleton: top bar + grid with `#rc-list` and `#rc-detail` containers. |

Data flow is unchanged: WebSocket frames → `DashState` update → render. New: a `UiState { selectedSid, mobileView }` updated by user events and by `resolveSelection` after each `tabs` frame; mirror commands are emitted from the selection transition, not from a button.

## Error handling

- `rejected` frames: shown inline in the detail pane for the affected session (existing `rejections` map keyed by `session_id`).
- WebSocket drop: existing exponential backoff reconnect (3s → 30s) retained; mirror terminal cleared, detail pane shows the presence state.
- `mirror_start` rejected by desktop (race: tab disarmed between frames): rejection renders inline; no retry loop.

## Testing

- **Vitest:** `view-model.test.ts` — sort order (armed-first, group, stable), selection fallback (initial, vanished tab, none armed), mirror transition decisions (switch, disappear, disconnect).
- **Playwright (`tests/remote.spec.ts`):** update for the new DOM — list rows render sorted, clicking a row populates the detail pane, armed tab shows controls + mirror container, unarmed tab shows the arm hint, mobile viewport gets list→detail→back navigation, mirror_start/stop frames are emitted on selection changes (against the existing mock relay).
- Existing `protocol.test.ts` (22 tests) must stay green.
