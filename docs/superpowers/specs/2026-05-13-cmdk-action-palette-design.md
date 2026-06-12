# ⌘K Action Palette

Status: Design approved 2026-05-13
Owner: karluiz

## Problem

Today the ⌘K super-agent overlay streams markdown back into a response area.
Code suggestions render inside fenced blocks with a Copy button. The flow for a
suggestion the user actually wants is:

1. Read the explanation.
2. Click Copy on the fence.
3. Focus the active terminal.
4. Paste.
5. Press Enter.

The agent has already identified the command. Four of those five steps are
manual reconciliation. We want ⌘K to behave like an action palette (Raycast /
Linear command-K) where the agent's output IS the action, not text *describing*
an action.

## Goals

- One keystroke from agent suggestion to "command sitting in the active prompt,
  ready to confirm".
- Preserve the SuggestOnly default policy from `CLAUDE.md` — ⏎ never executes,
  it only inserts. The shell's Enter is the final confirmation.
- Single best command per query (top-1), no ranked alternatives.
- Backend signals risk via the existing safety regex set in
  `crates/agent/src/safety.rs`; UI cannot decide on its own.
- No persistent transcript yet — each query is still single-shot. Follow-ups
  are convenience refills of the input, not a conversation.

## Non-goals

- Multiple ranked command alternatives.
- Navigation actions (jump to tab/file/block). Wait for M5 cross-session
  correlation.
- Auto-execute outside `SuggestOnly`. Other policies (`Allowlist`, `FullAuto`)
  remain out of scope.
- Sandboxed preview tabs.
- Persisting Q&A history across ⌘K invocations.

## Response model (structured, via tool-use)

Replace free-form markdown streaming with an Anthropic tool-use turn. The
agent must invoke a single tool `respond` whose input matches:

```rust
struct AgentResponse {
    explanation: String,            // markdown, may be empty if no prose needed
    command: Option<CommandAction>, // top-1 actionable command
    followups: Vec<String>,         // 0..=3 suggested next questions
}

struct CommandAction {
    cmd: String,              // single shell-ready line (no fences, no $ prefix)
    rationale: String,        // one short sentence, why this command
    risk: Risk,
    cwd_hint: Option<PathBuf>, // present only if command assumes a specific cwd
}

enum Risk {
    Safe,        // read-only, idempotent, no side effects (ls, git status, lsof)
    Mutates,     // changes state but reversible (kill, git checkout, mv)
    Destructive, // matches hard-blocklist or otherwise irreversible
}
```

Streaming: the `explanation` field streams token-by-token into the overlay as
soon as it starts. The `command` and `followups` fields materialize when the
tool input completes (Anthropic streams partial JSON for tool inputs — we
accumulate and only render the chip once the structured fields are valid).

`Risk` is computed backend-side from `crates/agent/src/safety.rs`. The model
proposes a risk in the tool input but the backend overrides with the regex
verdict before forwarding to the UI. Hard-blocklist matches force
`Destructive`.

## UI

One overlay, two visual zones, fixed order:

1. **Input row** (unchanged): ⌘K chip + text input + status.
2. **Explanation block**: markdown text (existing renderer, minus fenced-code
   handling since commands no longer live in fences).
3. **Command chip** (optional, only if `command.is_some()`):
   - Header row: risk badge (`safe` / `mutates` / `destructive`) + rationale.
   - Body: the command in monospace, single line, scroll-x on overflow.
   - Action hints: `⏎ insert   ⌘⏎ run   ⌘C copy   ⌘E explain`.
4. **Follow-up chips** (optional): inline buttons. Click → refill input and
   submit.

### Keybindings

With ⌘K open and a chip present:

| Key   | Behavior |
|-------|----------|
| ⏎     | Insert `cmd` into active session's PTY without trailing newline. Close overlay. Focus terminal. |
| ⌘⏎    | If `risk == Destructive`: degrade to insert + toast "review before pressing Enter". Otherwise: insert `cmd` followed by `\r`. Close overlay. |
| ⌘C    | Copy `cmd` to clipboard. Toast confirmation. Overlay stays open. |
| ⌘E    | Re-issue the question with a "explain in detail" suffix; replaces the current explanation in place. No new chip is generated. |
| Esc   | Close. |

If the input has focus and is non-empty, ⏎ submits a new question (existing
behavior) instead of triggering chip insert. The chip-action keys only apply
when the input is empty or when focus is on the chip.

### Insertion mechanism

Reuse the existing `write_to_session(session_id, bytes)` Tauri command.
Insert = write `cmd` bytes. Run = write `cmd` + `\r`. No shell escaping is
performed on our side; the backend treats the bytes as if the user typed them.

## Backend changes

- `crates/agent`: switch the `ask` flow from text-only streaming to tool-use.
  Define the `respond` tool schema. Keep prompt caching on the system prompt +
  per-session rolling summary.
- `crates/agent/src/safety.rs`: expose a `classify(cmd: &str) -> Risk`
  function reusing the existing hard-blocklist regex set.
- Tauri command `ask_agent` streams two event kinds now:
  - `explanation_delta { text }` — token deltas for the prose.
  - `response_final { AgentResponse }` — once the tool input parses and risk
    is reclassified.

Error path: if the model returns text without invoking the tool, treat the
text as `explanation` with `command = None` and `followups = []`. No regressions
for pure-explanation questions.

## Frontend changes

- `ui/src/agent/panel.ts`: drop the fenced-code parser and Copy button logic.
  Replace with the two-zone renderer above. Listen for the two event kinds.
- `ui/src/api.ts`: typed wrapper for the new event payloads.
- `ui/src/styles.css`: chip, risk badge, follow-up button styles.

## Telemetry / observability

Log via `tracing` on every chip render and every action key:

- `agent.chip.rendered { session, risk }`
- `agent.chip.action { session, action: insert|run|copy|explain, risk }`
- `agent.followup.clicked { session, index }`

Helps validate the hypothesis that insert/run dominate copy, post-ship.

## Testing

- Unit tests on `safety::classify` for the full blocklist (already partially
  covered — extend for the new `Risk` enum).
- Backend: tool-use happy path, tool-use with no command, model returns plain
  text fallback.
- Frontend: deterministic render given a fixed `AgentResponse`; keybinding
  matrix (⏎ / ⌘⏎ / ⌘C / ⌘E with Safe/Mutates/Destructive).
- Manual: every keybinding against a real PTY tab, including the destructive
  degrade-to-insert path.

## Migration

No persisted state to migrate. Ship behind no flag — replace the existing
panel renderer in one commit. The fenced-code parser becomes dead code and is
deleted in the same change.
