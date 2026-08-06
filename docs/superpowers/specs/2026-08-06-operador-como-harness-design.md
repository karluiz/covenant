# The operator IS the harness — inverting tier 2 and tier 3

2026-08-06 · Ontology change · supersedes the native operator mind

## What changes

Today an operator is a **spectator with veto power**: it watches an executor's
PTY (`pty_perception.rs`), decides with a mind of its own
(`teammate/llm.rs` + `teammate/tools.rs` + providers to Foundry/Anthropic/OpenAI),
and answers the executor's prompts. It lives in a side panel. The harness does
the work; the operator approves it.

This spec inverts that. The operator stops watching and **becomes** the session.
The harness stops being tier 3 and becomes **the operator's thinking organ**.

The three tiers do not collapse — the executor becomes *internal* to the
operator. You no longer pick a harness when you spawn; the soul brings one.

```
        YOU (Karluiz) — the principal
        │  delegates a domain
        ▼
   ┌─────────────────────────────────────────────┐
   │  OPERATOR                                   │
   │  SOUL    (Covenant-owned, persistent, yours)│
   │   +                                         │
   │  HARNESS (borrowed mind, disposable)        │
   └─────────────────────────────────────────────┘
        │  operates on
        ▼
    PTY / repo / MCP / world
```

**Recursion rule:** subagents the harness spawns on its own are **not
operators** — no soul, no delegated authority. Only Covenant creates operators.
Without this rule the chain of delegation dilutes and "operator" degrades into
"preset".

## Decisions taken (all confirmed by the principal, 2026-08-06)

| # | Decision | Consequence |
|---|---|---|
| 1 | **Harness-only mind.** No dual-mode, no per-operator interpreter choice. | The native agentic loop is deleted (~5–6k lines). |
| 2 | **Always-on = dumb detector + resident operator.** | The detector never reasons; every judgment is a harness turn. |
| 3 | **One tab, two faces.** A tab is one operator with a conversation face and a terminal face. | Reuses the existing tab; no new tab type. |
| 4 | **`deny: Bash` + `run_in_pty` is the default.** | The operator is forced to work in *our* PTY, in the open. |
| 5 | **The guardian is an ordinary operator**, not a subsystem. | The always-on adds no new ontology — only a detector and a poke. |

## What Covenant becomes

It stops being an agent framework. Three organs remain — the ones nothing else
has:

1. **Soul compiler** — `soul.md` → executable harness configuration
2. **World model** — event bus, PTY perception, `world_snapshot`, served over the
   existing MCP server
3. **Conductor** — spawn, worktrees, supervision, convergence, cost, ledger

## Soul compilation

The soul's four layers compile to harness configuration. Nothing is written
into the user's repository — compiled artifacts live under
`~/Library/Application Support/com.karluiz.covenant/souls/<operator>/` and reach
the session through argv, env, and the existing MCP injection path.

| Soul layer | Compiles to | Mechanism |
|---|---|---|
| **Mandate** | system prompt | `--append-system-prompt` |
| **Disposition** | permission mode + escalation threshold | `--permission-mode` + compiled settings |
| **Reflexes: ALWAYS-YES** | `permissions.allow` | compiled `settings.json` via `--settings` |
| **Reflexes: NEVER** | `permissions.deny` | same |
| **Reflexes: ESCALATE** | `PreToolUse` hook → `covenant hook escalate` | same |
| **Voice** | system prompt | `--append-system-prompt` |
| **Memory / ledger** | MCP tools | existing `mcpServers` injection (`mcp_server.rs`) |

The payoff: an `ALWAYS-YES` goes from *"a mind of yours reads the PTY prompt,
interprets it, and answers"* to *"the harness never asks"*. Same semantics,
orders of magnitude cheaper, and **auditable** — the decision lives in a file,
not in a token.

`ESCALATE` runs through a `PreToolUse` hook that shells out to the `covenant`
binary (already installed to `/usr/local/bin` from Settings). The hook asks the
principal and returns the harness's allow/deny JSON.

**Verify at implementation time (phase 1):** the exact flag surface
(`--append-system-prompt`, `--settings`, `--permission-mode`) and how it composes
with the ACP spawn path in `acp_commands.rs`. If ACP cannot carry argv, the
fallback is per-operator env + a compiled settings file resolved from the
session cwd — but the requirement stands: **nothing lands in the user's repo.**

## The operator tab: one being, two faces

A tab is one operator holding **two sessions**, not two kinds of tab:

- **Conversation face** — ACP session against the harness. The mind. Front by default.
- **Terminal face** — an ordinary `Session` PTY owned by the operator. Raw, and you can take the keyboard.

In ACP mode the harness runs bash *internally* — you would see nothing. So the
compiled soul sets `deny: ["Bash"]` and `allow: ["mcp__covenant__run_in_pty"]`,
forcing the operator to work in the visible PTY. This is the product's core
thesis ("we own the PTY") applied to the agent itself.

Default: visible PTY. A soul that needs the harness's native bash (for speed or
output parsing) says so in its mandate; its terminal face then stays a terminal
of yours inside the operator's tab.

### `run_in_pty` — a deliberate ceiling crossing

`mcp_server.rs:707-711` documents a standing ceiling: *the server's surface
never executes commands.* Today the MCP exposes `session_output` and
`session_list` — read-only over PTYs. `run_in_pty` breaks that ceiling on
purpose, so it carries its own gate:

| Rule | Detail |
|---|---|
| Scope | Writes only to the PTY of the caller's **own** operator tab, resolved from `$COVENANT_SESSION_ID` — never an arbitrary session id from the argument |
| Foreign sessions | Writing to a session the caller does not own is a **separate** tool (`intervene_in_session`) with its own reflex; the guardian is the only soul expected to hold it |
| Classification | New `WRITE_TOOLS` entry; `every_tool_is_classified` keeps this honest |
| Secrets | Output returned through the existing `mask_secrets` path, same as `session_output` |
| Audit | Every call lands in the ledger |

The blast radius of `run_in_pty` is a shell. The reflexes are what make that
safe, which is precisely why they must compile to `permissions.deny` rather than
to a prompt asking the model to behave.

## Spawn: the menu collapses

```
  Start new agent   ──►   Invoke operator  ›  guardian
  Start ACP         ──┘                      archivist
  (removed)                                  scout
                                             surgeon
                                             diplomat
                                             ──────────
                                             Raw terminal
```

`Start ACP` meant "pick a harness" — that is now an attribute of the soul, not a
choice at spawn time.

Flow: pick a soul → compile it → worktree (`.covenant/worktrees/<slug>`, already
exists) → write compiled settings + mcp config → open the ACP session → open the
sibling PTY → tab ready, conversation face front.

`SpawnSpec.command/args/acp` stops being a user choice for operator spawns and
derives from the soul. Raw spawns survive for "I just want a zsh".

## Always-on: dumb detector + resident

```
event bus (all sessions)
      │  cheap rules, 0 LLM
      ▼
   SIGNAL  ──poke──►  guardian's ACP session
                            │ pulls the world over MCP
                            ▼
                      notify / escalate / intervene
```

The detector **never reasons**. v1 rule set is fixed, no settings:

| Rule | Trigger |
|---|---|
| Repeated failure | same command exits non-zero ≥2 times in one session |
| Cross-session correlation | file edited in session A appears in a failing test path in session B |
| Stalled prompt | a session is waiting on a prompt with no input for > 60s |
| Known error signature | a pattern from the soul's compiled signature list hits the output |

A signal is delivered as a `session/prompt` turn on the guardian's session. The
guardian is an ordinary operator whose mandate is vigilance — it lives on prompt
caching and compacts itself, because the harness already does that.

This also covers **foreign sessions**: a bare `claude` you opened by hand has no
soul, but the guardian does, and can answer it through
`intervene_in_session`. `pty_perception.rs` feeds the detector; the guardian
supplies the judgment.

## Ledger

The existing reflex ledger changes source: it feeds from hooks instead of from
the LLM. It gains granularity, because every reflex `allow`, every escalation,
and every guardian intervention now passes through an observable hook.

## What gets deleted

| Fate | Files |
|---|---|
| **Deleted** | `teammate/llm.rs` (1658), `teammate/tools.rs` (1349), `teammate/anthropic_http.rs`, `teammate/openai_http.rs`, `agent/provider/azure_foundry.rs`, `agent/provider/openai_sse.rs`, `provider_resolve.rs`, `providers_cmd.rs`, `ui/src/settings/model_routes.ts`, the provider-picking half of `ui/src/operator/creator.ts` |
| **Thinned** | `operator.rs` (7407) — identity, ledger, sync, cost, supervision survive |
| **Reassigned** | `pty_perception.rs` — no longer feeds a native mind; feeds the detector and foreign sessions |

Roughly 5–6k lines out. **Only after phases 2–4 are in real use.**

## Phases

Each phase delivers value without the ones after it.

| # | Phase | Delivers alone | Minimum check |
|---|---|---|---|
| 1 | **Soul compiler** | Compiles the 5 existing souls; you review the output. Touches nothing live. | golden-file: `soul.md` → expected `settings.json` + argv |
| 2 | **Operator tab** | You converse with a real operator. The native path stays alive in parallel. | spawn `guardian`, it runs a command, output shows on the terminal face |
| 3 | **Menu collapse** | "Invoke operator" replaces both items | spawn-from-menu produces a compiled operator tab |
| 4 | **Detector + guardian** | The new always-on | detector is pure logic over events — testable with no LLM |
| 5 | **Deletion** | ~5–6k lines out | `cargo check` + suite green |

## Risks

| Risk | Mitigation |
|---|---|
| **Hard dependency on the harness.** No `claude`, or an ACP protocol change, and Covenant has no mind. | ACP is multi-harness. The soul names a preferred harness and a fallback list (`codex`, `gemini`). Same path, different binary — not a return to dual-mode. |
| **`run_in_pty` widens the MCP's blast radius** from read-only to shell execution. | Ownership scoping by `$COVENANT_SESSION_ID`, a separate tool for foreign sessions, compiled `deny` reflexes, ledger on every call. |
| **The harness loses its optimized bash** under `deny: Bash`. | Per-soul opt-out stated in the mandate. Default stays visible, because visibility is the product. |
| **Guardian cost drift** — a chatty detector means a harness turn per signal. | Thresholds live in the detector, in Rust, with no LLM. Signals are rate-limited per session before the poke. |

## Out of scope

- Reverse compilation (harness settings → `soul.md`)
- Per-operator model selection UI — the harness owns model choice now
- Multi-principal / shared operators
- Any settings surface for the detector rules in v1
