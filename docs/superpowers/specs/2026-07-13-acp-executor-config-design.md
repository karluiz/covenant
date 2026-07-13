# ACP Executor Configuration in Harnesses — Design

**Date:** 2026-07-13
**Status:** Approved (brainstorm with Karluiz)

## Problem

ACP executors (`claude`, `copilot`, `opencode`, `pi`) launch with hard-coded
profiles in `AcpSpawnOpts::for_executor` — zero user configuration. Running
claude without bypass permissions means constant permission prompts (today
worked around by hand-editing the isolated `claude-acp/settings.json`).
There is no place to set trust level, default model, thinking effort, or
extra env/args before an ACP session launches.

## Goal

A **unified preset + native overrides** model, surfaced as an "ACP agents"
subsection of Settings → Harnesses:

- One **trust level** per executor (Ask / Balanced / YOLO) that Covenant
  translates to each adapter's best native mechanism, with the client-side
  `PermissionResolver` as a universal safety net.
- Native knobs per executor: default model, thinking budget (claude only),
  extra env vars, extra CLI args.
- A **per-tab trust chip** in the live ACP session header to change trust
  mid-session.

## Architecture (Approach A — chosen)

Config lives in Covenant's `config.json` (`settings.rs`), read by
`spawn_acp_session` at spawn time and translated in Rust. Headless /
operator-driven ACP spawns respect it automatically. (Rejected: FE-only
config passed via `SpawnAcpOpts` — splits config across two worlds and is
invisible to non-UI spawn paths.)

### Data model (`crates/app/src/settings.rs`)

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum AcpTrust { Ask, #[default] Balanced, Yolo }

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AcpExecutorConfig {
    #[serde(default)] pub trust: AcpTrust,
    #[serde(default)] pub model: Option<String>,
    /// Thinking budget in tokens (claude only; → MAX_THINKING_TOKENS).
    #[serde(default)] pub thinking_tokens: Option<u32>,
    #[serde(default)] pub env: Vec<(String, String)>,
    #[serde(default)] pub args: Vec<String>,
}
```

Stored under a new `acp_executors: HashMap<String, AcpExecutorConfig>` key.
A missing entry = all defaults (Balanced, no overrides) — existing
config.json files stay valid.

### Trust levels

| Level | Client resolver | Native mechanism |
|---|---|---|
| **Ask** | defer ALL permission requests to the user | claude → `permissions.defaultMode: "default"` |
| **Balanced** (default; today's behavior) | edits/reads/safe commands auto-allow, rest deferred | claude → `"default"` |
| **YOLO** | auto-allow everything that still arrives (always `allow_once`-kind options, never persistent "always" grants) | claude → `"bypassPermissions"`; copilot → `--allow-all-tools`; opencode → `OPENCODE_PERMISSION` allow-all env |

Native-first: in YOLO the adapter shouldn't generate permission requests at
all (no round-trips); the resolver covers anything that leaks through.
`pi` has no documented native knob → client resolver only.

### Native mapping per executor

| Knob | claude | copilot | opencode | pi |
|---|---|---|---|---|
| trust | `permissions.defaultMode` patched into the isolated settings.json each spawn | `--allow-all-tools` appended when YOLO | `OPENCODE_PERMISSION` env when YOLO | client resolver only |
| model | `model` key in isolated settings.json | `session/set_model` post-`session/new` (best-effort, non-fatal) | `session/set_model` post-`session/new` | — |
| thinking | `MAX_THINKING_TOKENS` env | — (control hidden) | — | — |
| env / args | universal — merged into `AcpSpawnOpts.env`, args appended after the adapter's own args | ídem | ídem | ídem |

**claude settings.json patching:** `prepare_claude_acp_config` currently
writes `{}` only if absent. It becomes: read existing JSON, set/remove
`permissions.defaultMode` and `model` from config, write back —
**preserving all other keys** the user added by hand. This replaces the
current manual-edit workaround; the file becomes derived state for those
two keys only.

**Impl-time verification required (do not trust this spec blindly):**
exact copilot flag name (`--allow-all-tools`) and the exact
`OPENCODE_PERMISSION` JSON schema (expected shape:
`{"edit":"allow","bash":"allow","webfetch":"allow"}`). Verify against the
installed CLI versions before wiring; if a mechanism doesn't exist, that
executor falls back to client-resolver-only YOLO.

### Trust-aware resolver + live toggle

- `hybrid_resolver` gains a `Arc<RwLock<AcpTrust>>` captured in the
  closure. Per-session; initial value from config.
- New tauri command `acp_set_trust { session_id, trust }` (mirror of
  `acp_set_model`): updates the RwLock; for claude additionally sends
  `session/set_mode` (`Yolo → "bypassPermissions"`, else `"default"`).
- `SpawnAcpResult` gains `trust: AcpTrust` so the tab renders the initial
  chip without a second round-trip.
- Resolver rules per level are pure functions in `policy.rs`
  (`resolve_for_trust(trust, req)`), unit-testable without a session.
- Deny-biased floor stays: no branch ever falls through to
  `options.first()`; YOLO never selects an option whose kind contains
  `"always"` (no persistent grants from a per-session mode).

## UI

### Harnesses section (`ui/src/settings/spawns.ts` or sibling module)

New subsection **"ACP agents"** below the existing spawn specs: one card
per executor (`claude`, `copilot`, `opencode`, `pi`), reusing `brandBadge`.
Per card:

- Trust segmented control (3 options). YOLO styled as warning (amber/danger
  token), tooltip spelling out "equivalent to --dangerously-skip-permissions".
- Model text input (hidden for `pi`).
- Thinking tokens numeric input (claude card only).
- Env var key=value rows (add/remove).
- Extra args text input.

Persistence through the existing settings get/set plumbing (same commands
the Settings panel already uses for config.json). Styling per DESIGN.md:
sharp corners, `.rail-*` tokens, `attachTooltip` (never `title`), inline
SVG only, English copy.

### Per-tab trust chip (`ui/src/executors/acp/view.ts`)

Chip in the ACP tab header next to the model selector showing current
trust. Click → menu with the 3 levels → `acpSetTrust` wrapper in `api.ts`.
YOLO state renders in permanent warning styling — a bypassed session must
always be visibly bypassed. New sessions inherit the executor's configured
default; the chip only changes the live session, never the stored config.

## Security implications

- YOLO is exactly `--dangerously-skip-permissions`: opt-in per executor,
  default Balanced, permanently visible on the tab when active.
- No persistent "always" grants are ever auto-selected, at any level.
- The `safety.rs` hard blocklist is the super-agent's policy framework and
  is intentionally NOT wired into interactive ACP sessions — out of scope.
- Env values may contain secrets; they live in `config.json` which is
  already chmod 0600.

## Testing

- `crates/agent/src/acp/policy.rs`: table tests for `resolve_for_trust` —
  Ask defers everything; Balanced preserves today's cases; YOLO allows all
  kinds but never picks `*always*` options; empty-option floor holds.
- `crates/agent/src/acp/session.rs` (`for_executor_profiles` style): trust
  YOLO produces `--allow-all-tools` for copilot and `OPENCODE_PERMISSION`
  for opencode; user env/args land in the spawn opts.
- `prepare_claude_acp_config`: patches `permissions.defaultMode`/`model`
  while preserving unrelated keys in an existing settings.json.
- FE: card render + persistence round-trip test beside the module
  (repo-root vitest), following the existing spawns settings tests.

## Out of scope (v1)

- Per-spawn-spec or per-project overrides (global per-executor only).
- Granular opencode permission matrix / copilot `--allow-tool` patterns —
  the trust preset is the only permission abstraction exposed.
- Native knobs for `pi` (none documented).
- `gemini` / `codex` — not ACP executors in Covenant.
- Allowlist/regex trust tier (the super-agent `ExecPolicy` world) — revisit
  if Balanced proves too chatty.
