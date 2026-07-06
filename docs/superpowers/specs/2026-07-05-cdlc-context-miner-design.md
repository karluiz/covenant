# CDLC Context Miner — a dedicated Context Creator

**Date:** 2026-07-05
**Status:** Implemented (v1, feat/cdlc-context-miner)
**Work front:** CDLC Generate (replaces the interim "Spec Creator with `cdlcContext: true`" flow)

---

## Problem

A spec and a CDLC context are different artifacts with different lifecycles:

- A **spec** describes *what to build once* — goal, requirements, plan.
  Consumed by an executor to implement a feature, then it's history.
- A **context** is *durable operational knowledge* for a repo/group —
  conventions, patterns, gotchas, domain/regulatory rules. It is loaded into
  executors as ambient context (via CDLC projection), versioned, published to
  the registry, and installed by other teams.

Today "New context" in the CDLC panel opens the Spec Creator with
`cdlcContext: true`, which only changes the publish destination to
`.covenant/cdlc/context/` (`crates/app/src/drafts.rs::publish_subdir`). The
authoring experience is spec-shaped: it interviews the *user* about a goal.
A context should instead be **mined from the repo** — the knowledge is
already in the code; the user curates rather than dictates.

## Decisions (from brainstorm, 2026-07-05)

1. **Spine = repo mining.** The agent scans the codebase and extracts
   observed conventions/patterns/gotchas/domain rules. Expert-interview
   elicitation and eval-first authoring are later phases, not v1.
2. **Output = packaged skill.** The Creator writes
   `.covenant/cdlc/skills/<name>/` (`SKILL.md` + `skill.toml`) — the real
   distribution unit (publishable to the registry, installable, projectable)
   — not a loose `context/*.md` doc.
3. **UX = immersive + card curation.** Full-screen shell (Spec Creator
   tier). The agent streams findings live as cards; the user accepts /
   edits / discards; accepted findings compile into the skill.
4. **Engine = own streaming agent** (Premium Spec Creator research-agent
   pattern): Anthropic streaming loop in `crates/agent` with read-only repo
   tools and a structured `emit_finding` tool. Full control of the finding
   schema, live streaming, prompt caching, 4-primitive telemetry. Not
   `claude -p` (no live findings) and not `dispatch_acp` (unstructured
   report).

## Architecture

### 1. Backend — `crates/agent/src/context_miner.rs`

Streaming agent loop modeled on `spec_author.rs`:

- **Tools (read-only, repo-jailed):** `read_file`, `grep`, `list_dir` —
  reuse the spec_author helpers/jail. No write tools, no shell.
- **`emit_finding` tool** — the structured output channel. Schema:

  ```json
  {
    "category": "convention | pattern | gotcha | domain_rule | glossary",
    "title": "string (≤ 80 chars)",
    "body_md": "markdown — the rule/knowledge, written as instruction",
    "evidence": ["path/to/file.rs:123", "..."],
    "confidence": "high | medium | low"
  }
  ```

  Each call is forwarded immediately to the frontend as a Tauri event on
  `cdlc://miner/{run_id}` (finding frames + activity frames: which
  file/grep the agent is on). Findings stream *during* the run, not at the
  end.
- **Inputs shaping the prompt:** skill name, focus (free text: "testing
  conventions", "regulatory KYC domain", …), depth (quick scan / thorough).
- **Rate/size guards:** max findings per run (default 40), max tool calls,
  token budget — same guardrail style as `agent::dispatch`.
- Every LLM call carries 4-primitive telemetry like the rest of Covenant.

### 2. Compile & write — `karl_cdlc` + command

`cdlc_compile_skill` Tauri command takes the accepted (possibly edited)
findings + skill name and:

1. Renders `SKILL.md`: frontmatter (name, description, version) + one
   section per category, each finding as a subsection with its evidence
   rendered as `path:line` references.
2. Renders `skill.toml`: name, version `1.0.0`, owner, content sha —
   reusing `karl_cdlc::manifest` types.
3. Writes `.covenant/cdlc/skills/<name>/` in the group's repo root.

From there the existing plumbing applies unchanged: projection to executor
instruction files, registry publish, installs, adoption telemetry.

### 3. Frontend — `ui/src/cdlc/miner/`

Immersive full-screen shell (ESC closes, Spec Creator entrance tier).
Three zones:

- **Left — activity stream:** live feed of what the agent is doing
  (reading X, grepping Y), the Premium Spec Creator research-stream
  pattern.
- **Center — finding cards:** cards drop in live, grouped by category.
  Each card: title, body (inline-editable), evidence links (click → open
  file at line), confidence badge, Accept / Discard (keyboard `A` / `D`).
- **Right — live SKILL.md preview:** compiled from accepted findings as
  you curate.

Footer: skill name input + **Write to repo** (enabled when ≥1 finding
accepted and the run is finished or stopped). A Stop control ends the
mining run early, keeping findings already emitted.

State is a pure reducer (`AcpStreamState` pattern): stream frames in,
`{activity[], findings[], accepted{}, edited{}}` out — unit-testable
without DOM.

### 4. Entry point

The CDLC panel's "New context" button opens the Miner (replacing the
`spec-chat:open {cdlcContext:true}` dispatch). The `cdlcContext` publish
path in `drafts.rs` stays for back-compat but nothing routes to it from the
panel anymore.

## Out of scope (v1) — phased hooks

- **Expert interview** as a second finding source (same card pipeline,
  different generator) — the Mibanco/Pacífico regulatory elicitation case.
- **Eval generation per finding** + pass-rate publish gate via the built
  CDLC Eval Runner (context-TDD: red without the skill, green with it).
- **Incremental re-mining** ("what changed since v1.0.0") for the
  Observe/Adapt loop.
- Registry publish stays the panel's existing flow (the Miner writes the
  local package only).

## Testing

- **Reducer:** vitest over the pure stream-state reducer (frames → cards,
  accept/edit/discard, compile preview input).
- **Backend:** cargo tests for `emit_finding` schema validation and
  `SKILL.md`/`skill.toml` rendering (golden output for a fixed findings
  set) in `karl_cdlc`.
- **Smoke (ignored):** real miner run against this repo asserting ≥1
  finding with valid evidence paths.

## Error handling

- Miner run dies → activity stream shows the error; findings already
  emitted remain curatable; Write to repo stays available.
- `emit_finding` frames failing schema validation are dropped and logged,
  never crash the run.
- Compile refuses empty accepted-set; name collisions with an existing
  skill dir prompt overwrite-or-rename in the UI before writing.
