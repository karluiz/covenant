# Notch — Whirr-style executor status overlay

**Date:** 2026-05-17
**Status:** Design approved, ready to plan
**Owner:** karluiz

## Summary

A floating, always-on-top OS-level overlay (Tauri secondary window) that displays one pill per active executor agent in Covenant. Each pill shows the agent's current phase (Thinking / Running / Writing / Reading / Waiting / Done) plus an optional target (file path or command). The pill stack lives outside the Covenant main window so the user can see what their agents are doing while working in any other app.

Inspired by Whirr. State comes from parsing the executor PTY stream — no executor-side instrumentation required.

## Motivation

Covenant runs multiple executor agents in parallel (Claude Code, Codex, Copilot) across tabs. When the user is in another app (browser, editor, Slack), they currently have no visibility into:

- Which agents are still working vs. finished
- Whether an agent is blocked waiting for confirmation
- What an agent is doing right now (running shell? editing a file? thinking?)

Whirr-style pills solve this with minimal real-estate cost and a delightful aesthetic.

## Non-goals

- Drag-to-reposition (fixed bottom-right of primary display)
- Sound / haptic notifications
- Historical log of past pills (Covenant already has block history)
- Theming / color customization (inherits from Covenant theme)
- Multi-monitor smart placement (primary display only)
- Replacing the existing status-bar operator chip or score chip

## Architecture

```
┌───────────────────────────────────────────────────────────────┐
│  Covenant main window                                          │
│                                                                 │
│  PTY bytes ──▶ Block parser ──▶ ExecutorPhaseDetector (new)   │
│                                          │                      │
│                                          ▼                      │
│                            SessionEvent::ExecutorStateChanged  │
│                            { session, phase, target?, ts }     │
│                                          │                      │
│  ─────────────────────────────────────────┼───────────────────  │
│                                          │ Tauri event channel  │
│                                          │ "notch://state"      │
└──────────────────────────────────────────┼───────────────────-─┘
                                           ▼
                               ┌──────────────────────────┐
                               │ Notch window             │
                               │ (Tauri secondary window) │
                               │ transparent · frameless  │
                               │ always-on-top · no-tray  │
                               │ inf-right, click-through │
                               │ except over pill area    │
                               └──────────────────────────┘
```

### Backend: `ExecutorPhaseDetector`

Lives in `crates/blocks` (or a new `crates/notch` if it grows). Per-session state machine that consumes the same PTY byte stream the block parser already processes. Emits a new `SessionEvent` variant whenever the phase or target changes.

```rust
pub enum ExecutorPhase {
    Idle,                       // no current turn
    Thinking,                   // turn started, no tool use yet
    Running { cmd: String },    // executing shell command
    Writing { file: PathBuf },  // editing/creating a file
    Reading { file: PathBuf },  // reading/viewing a file
    Waiting { reason: String }, // needs user confirmation
    Done { summary: Option<String> },
}

pub struct ExecutorStateChange {
    pub session: SessionId,
    pub phase: ExecutorPhase,
    pub at: Instant,
}

// Added to existing SessionEvent enum:
SessionEvent::ExecutorStateChanged(ExecutorStateChange)
```

**Detection rules (v1, per-adapter with generic fallback):**

| Phase | Heuristic |
|---|---|
| `Thinking` | New executor turn started; no shell command or file edit detected within ~250ms. Banners like "Thinking…" or animated spinners count. |
| `Running { cmd }` | OSC 133 C marker for a command launched inside the executor's turn; or shell-line pattern `$ <cmd>` emitted by the agent. |
| `Writing { file }` | Adapter-specific patterns: Claude `"⏺ Update(.+)"`, Codex `"Editing (.+)"`, Copilot tool-use JSON `{"name":"write_file","input":{"path":...}}`. |
| `Reading { file }` | Similar — `"Reading X"`, `"⏺ Read(.+)"`, tool-use `read_file`. |
| `Waiting { reason }` | Known confirmation prompts: `Continue? [y/N]`, `Approve this edit?`, Claude Code's permission dialog markers. |
| `Done` | Outer-turn OSC 133 D, or idle for >2s after a non-Waiting phase. |

Detector is fed `(session_id, &[u8])` chunks. Internal per-session state holds the current phase and the last anchor timestamp. Tests use recorded PTY fixtures (`tests/fixtures/notch/*.bin`).

When detection is ambiguous, the detector keeps the prior phase — better to be stale by a second than to flap.

### Notch window

Secondary Tauri window declared in `tauri.conf.json`:

```json
{
  "label": "notch",
  "url": "notch/index.html",
  "decorations": false,
  "transparent": true,
  "alwaysOnTop": true,
  "skipTaskbar": true,
  "shadow": false,
  "resizable": false,
  "focus": false,
  "width": 320,
  "height": 400,
  "x": "<computed: screen.width - 340>",
  "y": "<computed: screen.height - 420>"
}
```

Window is created on app startup (lazy: only when first executor turn begins, to keep first-paint fast). Background is fully transparent; click-through is achieved by `set_ignore_cursor_events(true)` everywhere except over the pill DOM (toggled on `mouseenter`/`mouseleave` of the stack container via a tiny Tauri command).

### Frontend: notch/

```
ui/notch/
├── index.html
├── main.ts             # bootstraps store + render
├── store.ts            # StackStore
├── render.ts           # DOM diff (no framework)
├── pill.ts             # pill template + state-specific loaders
└── styles.css          # glass + per-state animations
```

`StackStore`:

```ts
type PillState = {
  sessionId: string;
  tabLabel: string;          // "claude · tab 1"
  tabColor: string;          // CSS color from Covenant theme
  phase: ExecutorPhase;
  target?: string;
  phaseStartedAt: number;    // ms
  expanded: boolean;         // computed + user-overridable for 8s
  expandStickyUntil?: number;
};

class StackStore {
  pills = new Map<string, PillState>();
  apply(event: ExecutorStateChange): void;
  visiblePills(): PillState[];      // sorted, max 5, +N overflow chip
  shouldBeCompact(p: PillState): boolean;
}
```

**Render rules:**

- Order: most-recent `phaseStartedAt` at bottom; stack grows upward.
- Max 5 visible pills; overflow → `+N more` chip on top.
- Auto-compact when `pills.length >= 4` OR `now - phaseStartedAt > 5000ms`.
- `Waiting` is **always** expanded and never counts toward the 4-pill threshold for collapsing others.
- `Done` pill stays for 2500ms (animated check), then fade-out 350ms.
- Click on compact pill: sets `expandSticky` for 8s.
- Click on `Done` pill: immediate dismiss.

**Animations (CSS, no JS):** Thinking = pulsing orb · Running = spinning ring · Writing = bouncing bars · Reading = scanline · Waiting = breathing amber ring · Done = drawn check. (Final visuals locked from `stack-styles.html` + `hybrid.html` mockups in `.superpowers/brainstorm/`.)

## Data flow / events

1. PTY chunk arrives at `crates/pty` reader task.
2. Existing block parser + new `ExecutorPhaseDetector` both consume the chunk.
3. Detector emits `SessionEvent::ExecutorStateChanged` onto the existing `tokio::broadcast` bus.
4. A new Tauri-side subscriber `notch_bridge` forwards every `ExecutorStateChanged` to the notch window as a Tauri event `notch://state`.
5. Notch window's `StackStore.apply()` updates state and triggers `render()`.
6. Render diffs the DOM (manual; <100 lines).

When notch window is not yet created, events are buffered (ring buffer of last 16) and replayed on window-ready.

## Tauri commands

```rust
#[tauri::command]
fn notch_set_passthrough(window: Window, passthrough: bool) -> Result<()>;
// Called by frontend on mouseenter/leave to toggle click-through.

#[tauri::command]
fn notch_dismiss_pill(session: SessionId) -> Result<()>;
// User clicked a Done pill; forget it server-side too.
```

No new commands for state — that's a one-way event channel.

## Error handling

- Detector parsing errors → log `tracing::warn` with session_id, keep prior phase.
- Notch window crash → main window keeps running; auto-recreate on next state event (with 1s debounce to avoid loops).
- Multi-monitor: if primary display changes resolution mid-session, reposition on `tauri::WindowEvent::Moved`/`Resized` of the main window.

## Testing

- **Unit (Rust):** Detector fixtures per adapter — `tests/fixtures/notch/claude-write.bin`, `codex-run.bin`, etc. Each asserts the sequence of emitted `ExecutorPhase` transitions.
- **Unit (TS):** `StackStore` tests for compact/expanded thresholds, Waiting precedence, Done timeout, overflow chip.
- **Visual:** Storybook-style page in `ui/notch/dev.html` that drives the store with scripted state transitions.
- **Manual:** Run Covenant, start agents in 1/3/5+ tabs, verify pills appear, collapse, dismiss correctly.

## Risks

- **Detection accuracy:** PTY parsing is heuristic. Mitigation: per-adapter rules, generic fallback, "when in doubt keep prior phase." Iterate with real fixtures.
- **Window flicker on macOS spaces:** always-on-top windows can blink when switching spaces. Mitigation: `NSWindowCollectionBehaviorCanJoinAllSpaces` (Tauri exposes this).
- **Click-through correctness:** if mouse-enter/leave bookkeeping fails, the notch can either swallow clicks meant for other apps or fail to receive its own. Mitigation: well-tested toggle + an emergency "disable notch" hotkey (⌘⇧N) that hides the window.

## Open questions

- (None at design-approval time. Lifecycle of `+N more` chip click — show full list? — deferred to plan/implementation.)
