# Spawned-task wiring + operator cost & error labels — design

Date: 2026-05-26
Branch: `feat/spawn-task-cost-fixes`
Worktree: `.claude/worktrees/spawn-task-cost-fixes-a/`

## Context

Four issues observed in a single Mibli session running "Implement Achievements
System" (see screenshot in the brainstorming thread):

1. The spawned executor tab kept its default name (`claude`) instead of being
   renamed to match the spec it was working on.
2. The mission badge / authoritative spec injection didn't take effect on the
   spawned tab.
3. The Activity feed showed 45 `WAIT` (v2 ignore) entries at ~$0.018 each —
   ~$0.81 of triage spend on no-op decisions over ~30 minutes.
4. Escalation cards read `api error: anthropic api 400: …` even though the
   active provider was Azure Foundry. The misleading label hides which
   provider actually failed.

The four fixes are unrelated in feature surface but related in code locality:
all of them touch the operator path, all are small, and shipping them together
keeps the audit trail tight.

## Goals

- A spawned-task tab that originates from a chat with an `@spec` chip should
  start with: (a) the matching mission attached, (b) the executor renamed to
  the spec slug.
- The triage Haiku call must not fire when the visible PTY tail hasn't
  changed since the last `WAIT` verdict on the same session.
- `AgentError::Api` Display must name the provider that actually produced the
  error.

## Non-goals

- Exponential backoff on consecutive Waits (option 3b in brainstorming) — deferred.
- Silent-park behaviour for fully idle sessions (3c) — deferred.
- Triage replacement with rule-based heuristics — deferred.
- Any changes to the spawn-task UX itself (button placement, edit dialog,
  confirmation flow).

---

## Problem 1 + 2: auto-`/rename` and auto-mission on spawned tabs

### Current state

Frontend (`ui/src/teammate/panel.ts:1340-1359`) already wires
`setMissionForSpawnedTab` for spawned tabs when the originating chat carries
a `@spec` chip:

```ts
if (specPath && this.deps.setMissionForSpawnedTab) {
  this.lastSentSpecPath = null;
  this.deps.setMissionForSpawnedTab(spawned.sessionId, specPath).catch(...);
}
```

This eventually reaches `Operator::set_mission` (`crates/app/src/operator.rs:927`),
which loads the spec, attaches it, and prepends it to the system prompt.

The auto-rename machinery also exists already:
- `AomStartupPending.rename_to: Option<String>` (operator.rs:449)
- `StartupActionKind::ClaudeRename(slug)` / `PiRename(slug)` (operator.rs:3284-3296)
- Injected as `/rename <slug>\r` or `/name <slug>\r` on the next idle.

But the spawned-task path never sets `rename_to`. So the executor stays
named `claude` (or whatever its default), even when the user spawned it
from a chat with a clear spec context.

### Diagnosis on mission gap

Mission *is* wired but in the screenshot the badge never appeared. Two
plausible causes worth verifying during implementation:

- The originating chat's `lastSentSpecPath` was already null by the time
  `confirmTask` ran (cleared by a prior turn or never set because the chip
  reached the LLM via mention-map only).
- The frontend awaits `setMissionForSpawnedTab` non-blockingly (`.catch(...)`)
  and the executor reaches idle / runs its first command before mission
  attachment completes — making it look like nothing happened even though
  the badge eventually appears.

The fix below addresses both: route rename + mission through one backend
command so both land atomically before the executor's first prompt is
injected.

### Design

Add a single Tauri command on the backend:

```rust
// crates/app/src/lib.rs (or a new spawn_commands.rs)
#[tauri::command]
async fn prime_spawned_tab(
    state: State<'_, AppState>,
    session_id: String,      // SessionId as string
    spec_path: String,       // absolute path
) -> Result<(), String>
```

Behaviour, in order:

1. Parse `session_id`. Build `MissionRef::covenant(spec_path)`.
2. Call `state.operator.set_mission(id, mref).await`. On error, return early
   (don't queue rename for a session whose mission attach failed).
3. Compute `slug = slug_from_mission_path(&spec_path)` (already exists at
   `operator.rs:4126`).
4. Acquire `inner.lock()`, find the `Attached` entry for `id`, set
   `att.aom_startup.rename_to = Some(slug)`. If the session isn't yet
   attached (race with executor spawn), buffer the slug on a side map
   keyed by `session_id` that the attach path consults — see below.

The tick loop's existing `fire_startup_actions` (operator.rs:3241+) already
fires `/rename` once the executor reaches idle + matches a claude/pi pattern
+ isn't `--resume`. No change there.

### Race handling

Spawned-tab flow today:

1. Frontend calls `createTab` → backend creates session.
2. Frontend awaits the new `sessionId`, then queues an injection of the task
   prompt (with `injectDelayMs = 1500`).
3. In parallel, frontend fires `setMissionForSpawnedTab` (non-blocking).

The 1500ms delay before prompt injection is the window we have to land
both mission + rename. The `prime_spawned_tab` command must finish before
the prompt is injected, otherwise the rename slot won't be populated when
the executor reaches its first idle.

Frontend change: replace the fire-and-forget `setMissionForSpawnedTab`
with an `await prime_spawned_tab(sessionId, specPath)` *before*
`window.setTimeout(... injectCommand ..., 1500)`. The 1500ms delay
absorbs both the priming call and the executor's startup.

### Pi support

`Operator::set_mission` already supports pi; the rename path branches on
executor kind via `StartupActionKind` and emits `/name <slug>\r` for pi.
No additional work — the existing branch wins automatically because
`fire_startup_actions` reads `att.aom_startup.rename_to` regardless of
how it got there.

### Removed code

`setMissionForSpawnedTab` in `ui/src/main.ts:588-592` and its type at
`panel.ts:118` get deleted — replaced by `prime_spawned_tab`. The
single-purpose backend `set_mission_path_for_tab` (called by main.ts) is
*not* removed; it still has other callers (mission picker, watcher reload).

---

## Problem 3: pre-triage screen-change gate

### Current state

- `TICK_INTERVAL = 500ms` (operator.rs:135).
- Every tick that passes the AOM + decision-pattern + cooldown gates fires
  a Haiku triage call (operator.rs:2106-2131).
- Triage decides Act / Wait / Yield. On Wait → no big-model call, but the
  triage call itself cost ~$0.018.
- An `idle-wait` loop guard kicks in after `IDLE_WAIT_ESCALATE_THRESHOLD`
  consecutive Waits with no new output (operator.rs:2593-2606), but only
  to *escalate*, and the threshold check happens *after* the triage call
  already paid.

### Design

Two complementary cheap gates that run *before* the triage call. Either
firing → synthesize a Wait, no LLM call, `cost_usd = 0.0`.

**Gate 1 — busy-indicator scan.** A static set of substring / regex
patterns that indicate "the executor is actively working, do not interrupt":

- Substring patterns: `"Composing"`, `"Running"`, `"Esc to interrupt"`,
  `"thinking…"`, `"⠋"`/`"⠙"`/`"⠹"`/`"⠸"`/`"⠼"`/`"⠴"`/`"⠦"`/`"⠧"`/`"⠇"`/`"⠏"`
  (Braille spinner glyphs used by Claude Code, npm, cargo, etc).
- These live in a `BUSY_INDICATORS: &[&str]` constant. Detection is a
  single pass over the ANSI-stripped tail excerpt.

When any pattern is present in the last ~20 lines of the stripped tail,
gate fires with rationale `"busy-indicator: <matched pattern>"`.

This directly catches the Mibli screenshot case: the executor was on
"Composing… (10m 24s · ↓ 36.1k tokens)", every WAIT in that window
would have been a $0 free pass.

**Gate 2 — tail-hash equality.** Catches the steady-idle case (executor
fully quiet, e.g. shell prompt waiting). If the ANSI-stripped tail
excerpt hashes equal to the hash captured at the moment of the last Wait
verdict on this session, skip triage. Rationale: `"screen-unchanged since
last wait"`.

Gates run in order: busy-indicator first (cheaper, more frequent in
practice), then tail-hash. Either fires → triage skipped.

Data structure on `Attached`:

```rust
struct Attached {
    // ...existing fields...

    /// Hash of the ANSI-stripped tail excerpt captured the last time
    /// triage returned Wait on this session. Cleared on any non-Wait
    /// outcome. When the current tick's hash equals this, gate 2 fires.
    last_wait_tail_hash: Option<u64>,
}
```

Hash function: `std::collections::hash_map::DefaultHasher` (matches the
existing decision-pattern hash at `operator.rs:3818` — no new dep).

Hash input: the ANSI-stripped excerpt, i.e. the same bytes the triage
prompt would have included. Hashing the *stripped* form avoids cursor
re-positioning escape codes producing false negatives. The busy-indicator
gate runs on the same input.

Gate placement (operator.rs `run_tick`, just before the triage block at
~2106 — both gates inside one `if` so a Wait gets synthesized
identically):

```rust
let stripped_tail = strip_ansi_escapes::strip_str(...);
let busy_hit = BUSY_INDICATORS.iter().find(|p| stripped_tail.contains(*p));
let cur_hash = hash_tail(&stripped_tail);
let hash_repeat = matches!(att.last_wait_tail_hash, Some(h) if h == cur_hash);

if let Some(reason) = busy_hit.map(|p| format!("busy-indicator: {p}"))
    .or_else(|| hash_repeat.then(|| "screen-unchanged since last wait".into()))
{
    triage_short_circuit = Some(OperatorAction::Wait { rationale: reason });
    // Fall through past the triage block — synth response already shaped
    // by the existing triage_short_circuit handling.
}
```

Update sites for `last_wait_tail_hash`:

- After *any* Wait outcome (triage Wait/Yield, big-model Ignore, loop
  guard, or one of these new free gates): set to `Some(cur_hash)`.
- After any non-Wait outcome (Reply, Execute, Escalate from the model):
  set to `None` so the next idle session starts a fresh window.

### Activity-feed UX

The synthesized Wait still emits an `operator-decision` event so the
audit row exists, but `cost_usd = 0.0` (no LLM call happened). The
Activity panel already groups WAITs visually; zero-cost ones render
identically — they just don't sum into the cost ribbon.

### Cost expectation

In the screenshot: 45 WAITs at ~$0.018 each = ~$0.81 just on triage.
Most fall during the "Composing… 10m 24s" phase visible at the bottom
of the screenshot — those are all catchable by gate 1 (busy-indicator
scan) at $0. Pure idle WAITs (no spinner, prompt waiting) get caught by
gate 2 starting on the second consecutive Wait. Expected reduction in
triage spend on a Mibli-style session: 80-95% of WAIT-bucket cost.
Active phases (any non-Wait outcome) are unaffected.

---

## Problem 4: provider-aware `AgentError::Api`

### Current state

```rust
// crates/agent/src/lib.rs:17-25
#[derive(Debug, Error)]
pub enum AgentError {
    #[error("anthropic api key is empty")]
    MissingKey,
    #[error("http: {0}")]
    Http(#[from] reqwest::Error),
    #[error("anthropic api {status}: {body}")]   // ← hardcoded label
    Api { status: u16, body: String },
}
```

The `Api` variant is constructed by every provider impl (Anthropic, Azure
Foundry, OpenAI-compat). The label lies for all but Anthropic.

### Design

Add a `provider` field:

```rust
#[error("{provider} api {status}: {body}")]
Api {
    provider: &'static str,
    status: u16,
    body: String,
},
```

Update every constructor site to pass the provider name. The names should
match `ProviderKind::as_str()` already defined at `crates/agent/src/provider/mod.rs:73`
(`"anthropic"`, `"azure_foundry"`, `"openai_compat"`). Use the static
strings directly to avoid coupling AgentError to ProviderKind (keeps the
crate boundary tidy).

Also rename `MissingKey`'s message: `"api key is empty"` (drop "anthropic").

### Call sites to update

A grep for `AgentError::Api {` reveals the construction points across
`crates/agent/src/provider/*.rs`. Each gets a one-line addition. The
`From<reqwest::Error>` for `Http` is unaffected.

### Downstream

`operator.rs:2250` (`format!("api error: {e}")`) becomes correctly
labelled with no code change — Display does the work. The Activity card
will read e.g. `api error: azure_foundry api 400: {"error":...}`.

### Test

Add a unit test per provider that constructs `AgentError::Api` and asserts
the `to_string()` contains the expected provider prefix. Cheap, prevents
regression if a future provider impl forgets the field.

---

## Implementation order

1. **#4 first** (smallest, makes #3 debugging readable in logs).
2. **#1 + #2 together** (one backend command, one frontend call site swap).
3. **#3** (operator tick gate + new field on `Attached`).

Each step is its own commit per `feedback_commit_granularity`.

## Risks

- **#1+2 race:** if `prime_spawned_tab` is slow (mission load is async file
  I/O), it could push the prompt injection past the 1500ms window. Mitigation:
  bump `injectDelayMs` to 2000ms only when priming is in progress; keep 1500ms
  otherwise. Or: don't bump and accept that on slow disks the rename fires
  on the *second* idle (still correct, just a beat late).
- **#3 busy-indicator false positive:** a real prompt for the user that
  happens to contain a substring like "Running" or "Composing" would be
  silently ignored. Mitigation: keep `BUSY_INDICATORS` conservative,
  prefer phrases that only appear in known executor status lines (e.g.
  `"Esc to interrupt"` is specific to Claude Code). Loop guards
  (`idle-wait`, `repeat-reply`) still fire if the session truly stalls,
  so a truly stuck busy-indicator state still surfaces an escalation.
- **#3 hash-gate false positive:** if the executor genuinely needs input
  but the screen never changes (e.g. a sticky prompt that was already
  on-screen when Mibli last Waited), we'd keep Waiting forever. The
  existing `idle-wait` loop guard catches this after
  `IDLE_WAIT_ESCALATE_THRESHOLD` consecutive Waits and escalates — same
  safety net as today, just hit slightly later (a few free ticks earlier).
- **#3 busy-indicator pattern drift:** if a future executor uses a
  different spinner glyph or status word, the gate silently stops
  matching for it. Mitigation: log `busy-indicator` hits at `debug` level
  so we can spot the pattern coverage in tracing; add new patterns by
  PR as executors evolve.
- **#4 ripple:** if any external consumer parses the error string (unlikely
  for an internal crate, but worth a grep before merging), the format change
  breaks them. Acceptable; we control all callers.

## Files touched (preview)

- `crates/agent/src/lib.rs` — `AgentError::Api` adds `provider`.
- `crates/agent/src/provider/anthropic.rs`, `azure_foundry.rs`,
  `openai_compat.rs` — pass provider name when constructing the error.
- `crates/app/src/lib.rs` (or new `spawn_commands.rs`) — `prime_spawned_tab`
  Tauri command + registration.
- `crates/app/src/operator.rs` — `Attached.last_wait_tail_hash`,
  `BUSY_INDICATORS` constant + `hash_tail` helper, pre-triage gates in
  `run_tick`, update sites on Wait/non-Wait outcomes.
- `ui/src/teammate/panel.ts` — replace `setMissionForSpawnedTab` with
  `prime_spawned_tab` invoke; await before the inject `setTimeout`.
- `ui/src/main.ts` — remove `setMissionForSpawnedTab` dep wire-up.
- `ui/src/api.ts` — typed wrapper for `prime_spawned_tab`.
- Tests: unit tests for AgentError Display per provider; integration test
  for `prime_spawned_tab` that mounts a fake session and asserts mission +
  `rename_to` both got set; pre-triage gate tests covering (1) a known
  busy-indicator substring short-circuits without LLM call, (2) identical
  hash short-circuits after a prior Wait, (3) non-Wait outcome clears the
  hash so the next tick proceeds normally.
