# Spec Author v2 — upgraded bespoke agent

**Date**: 2026-07-06
**Status**: approved (design)
**Decision**: keep the bespoke Rust agent (option B — must remain self-owned, no
executor dependency), upgrade tools + protocol + question UX + add image attachments.
Accepted trade-off: bounded harness debt — the agent stays read-only, ≤ ~30 turns,
never writes files, never executes commands. Scope creep beyond that is the failure mode.

## Problem

The Spec Creator feels dumb compared to real agent harnesses (Claude Code +
superpowers brainstorming, GitHub spec kit):

1. **Toy tools** — literal-substring grep (50-hit cap), 32KiB `read_file`, `list_dir`.
   No regex, no glob, no git history. Exploration depth is tool-capped, not model-capped.
2. **Interrogation, not collaboration** — the prompt "extracts" a spec by asking the
   user to enumerate requirements instead of proposing concrete options with a
   recommendation.
3. **Prompt-only discipline** — "one question per turn" drifts (observed: two questions
   bundled in one turn). No phases, no self-review before emit.
4. **Text-only** — users naturally want to paste wireframes/screenshots; there is no
   image path at all.

## Design

### 1. Real tools (`crates/agent/src/spec_author/tools.rs`)

All tools remain read-only and jailed via `safe_join`; secret masking unchanged.

- **`grep { pattern, dir?, glob? }`** — regex via the `regex` crate over the existing
  bounded walker (no external `rg` binary dependency). Optional `glob` filename filter
  (e.g. `*.rs`). Hit cap 50 → 200.
- **`glob { pattern }`** — find files by name pattern over the walker, no content read.
- **`git_log { path?, n? }`** (n ≤ 20) and **`git_show { rev, path? }`** — shell out to
  `git` using `Command` with fixed args (never a shell string; no injection surface),
  `cwd` = repo root, output capped at 32KiB. Rev/path inputs validated (rev must match
  `[A-Za-z0-9_./~^-]+`, path goes through `safe_join`).
- `read_file` / `list_dir` unchanged.

### 2. Structured `ask_user` — one-question rule moves from prompt to code

New tool: `ask_user { question, options: [{ label, detail? }] }` (2–4 options).

Backend (`stream.rs`): when the model calls `ask_user`, `step_streaming` ends the
turn — emits new event `Question { question, options }` followed by
`TurnDone { awaiting_user: true }`. Enforcement:

- Other tool calls in the same turn execute first; `ask_user` is processed last.
- A second `ask_user` in the same turn is dropped, with feedback text telling the model
  only the first was shown.

The user's answer flows back as a normal user message (the chosen option label, or
free text). Draft transcript records the question card so resume rebuilds it.

Frontend (`ui/src/spec-chat/`): `events.ts` gains the `question` event kind;
`activity-stream.ts` renders a question card with clickable option chips (+ the free
composer stays available). Chip click sends that answer. Resume reconstructs the card
from the transcript like tool chips.

### 3. Prompt v2 — propose, don't interrogate (`prompt.md` rewrite)

Explicit phases:

1. **EXPLORE** — tools until the terrain is understood (adaptive thinking already on).
2. **APPROACHES** — mandatory: present 2–3 concrete approaches with trade-offs and a
   recommendation, via `ask_user`. Open enumeration questions ("what features do you
   want?") are forbidden — always propose a concrete default read from the codebase
   and ask to confirm/adjust.
3. **CLARIFY** — only human-judgment questions, via `ask_user`, one per turn (now
   code-enforced).
4. **DRAFT** — live `<!--section:KEY-->` markers, unchanged.
5. **SELF-REVIEW** — one extra turn before emit: check for placeholders,
   contradictions, ambiguity; re-verify with tools that every path in File boundaries
   exists.
6. **EMIT** — `<spec>` contract unchanged.

### 4. Image attachments (photos, wireframes, screenshots)

- **Composer**: paste (⌘V), drag-drop (Tauri `onDragDropEvent`, logical px), and file
  picker → thumbnail chips. Frontend downscales via canvas to ≤1568px longest edge;
  cap ~5 images per message; png/jpg/webp.
- **Wire format**: `DraftMessage` gains `images: Vec<ImageRef>` (path + media type).
  Bytes stored once at `~/.covenant/spec-drafts/<draft-id>/img-N.png`; draft JSON
  stores paths, not base64. Dispatchers load bytes when building the request:
  Anthropic base64 `image` block, OpenAI `image_url` data URI. Vision-less model →
  substitute text note "[imagen adjunta — modelo sin visión]".
- **Publish**: images are copied into the repo at `docs/specs/assets/<draft-id>/` and
  the emitted spec references them in a "Referencias visuales" section, so the AOM
  executor can open them. The prompt tells the agent the canonical asset paths at
  attach time so references are correct at draft time. Unpublished drafts never touch
  the repo.

### 5. Thinking

Anthropic dispatcher already runs adaptive thinking at `xhigh` effort — no change.
OpenAI/Azure dispatcher stays as-is (current deployments lack an equivalent knob).

## Unchanged

Six-section template (AOM contract), `<spec>` emit + validation, draft persistence
model, secret masking, immersive UI shell, publish → `openWizardWithBody` flow.

## Testing

- `tools.rs`: regex + glob grep, glob tool, git arg validation/jail, output caps.
- `stream.rs`: single-`ask_user`-per-turn enforcement; `Question` event emission;
  ordering (tools before question).
- `spec_author.rs`: `DraftMessage` image serialization round-trip; vision fallback.
- Vitest (`ui/src/spec-chat`): `question` event in `stream-state`, chip render +
  click-sends, resume rebuild of question cards, composer attachment chips.

## Complexity

Medium. Backend: `tools.rs`, `stream.rs`, `spec_author.rs`, `prompt.md`, publish
command in `crates/app`. Frontend: `events.ts`, `stream-state.ts`,
`activity-stream.ts`, `transcript.ts`, composer in `immersive.ts` + CSS. No AOM
contract changes, no migrations.

## Out of scope

- ACP-backed spec authoring (rejected: must stay self-owned).
- Write/execute tools for the spec author (hard rule: read-only forever).
- Reasoning knob for the OpenAI dispatcher.
- Embedding images inline in the spec markdown (base64) — referenced files only.
