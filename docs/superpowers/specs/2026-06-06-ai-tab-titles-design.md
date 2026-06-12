# AI-Generated Tab Titles — Design

**Date:** 2026-06-06
**Status:** Approved (design), pending spec review

## Problem

A new tab is named `zsh 27` — `seq` is a meaningless monotonic counter. When
the user launches an agent (`claude`, `pi`) or works on something specific, the
tab title still says `zsh 27`. The title carries no signal about what the
session is *for*.

## Goal

An auto-titled tab names itself with a **tiny, AI-generated label of the
activity** in that session — `debugging`, `release prep`, `tab titles`,
`migration` — derived from the session's PTY activity. Manual renames win and
stay sticky.

Non-goal: showing the foreground process name (`claude`/`pi`). The user
explicitly rejected this — the process is noise; the *activity* is the signal.

## Core insight — zero new LLM calls

`crates/app/src/summarizer.rs` already runs debounced ~500ms after every
`BlockFinished`, sends `prev_summary + block history` to the model, and writes
back a rolling summary. We extend **that same call** to return
`{ summary, title }` instead of plain summary text. The title rides along for
free — no new request, no new rate-limit budget, no new failure mode.

## Title contract

- **Length:** ≤ 2 words.
- **Case:** lowercase.
- **Content:** names the *activity* (`debugging auth`, `release prep`,
  `tab titles`). Not the tool, not the cwd.
- **Empty case:** if nothing meaningful has happened (only `ls`/`pwd`/`cd`),
  return an empty title — the frontend keeps the cwd-basename fallback.

## Architecture / data flow

1. **`summarizer.rs` — sentinel-line output (NOT force_tool).**
   - `collect_oneshot` only accumulates `Delta` text, not tool-input deltas, so
     a forced tool would return empty text on that path. Instead we keep the
     plain-text call and have the model prepend a sentinel first line.
   - System prompt gains: "Your FIRST line must be exactly `TITLE: <label>`
     where `<label>` is ≤2 lowercase words naming the activity (empty after the
     colon if nothing meaningful happened). Then a blank line, then the summary
     body as before." (Static addition — prompt stays cache-stable.)
   - `regenerate` parses the response: if the first line starts with `TITLE:`,
     strip it for the title and use the remainder (trimmed) as the summary;
     otherwise title is empty and the whole text is the summary (preserves
     today's behavior exactly).
   - Degradation: blank/missing title → no emit; summary path unchanged.

2. **`world.rs` — hold the title.**
   - Add `pub title: Option<String>` to `SessionWorldModel`.
   - `regenerate` writes `world.lock().await.title = Some(title)` when non-empty.

3. **`storage.rs` — persist the title.**
   - Add a `title TEXT NOT NULL DEFAULT ''` column to the `summaries` table via
     an idempotent `ALTER TABLE` migration (same pattern as the teammate
     `rolling_summary` migration at storage.rs:571).
   - `save_summary` gains a `title` parameter and upserts it alongside the
     summary. Add a `load_title`/extend the summary load used on restore.

4. **`crates/session/src/lib.rs` — new bus event.**
   - Add `SessionEvent::TitleSuggested { session: SessionId, title: String }`.
   - Add the matching UI variant `SessionUiEvent::TitleSuggested { session,
     title }` and map it in `to_ui()` (mirrors `ForegroundChanged`).
   - The summarizer publishes it. **Wiring:** `spawn_loop` must receive a
     `broadcast::Sender<SessionEvent>` (clone of the session's bus sender) in
     addition to the existing `Receiver`, so it can `send(TitleSuggested{..})`
     after a successful regen. Only send when the title **changed** from the
     last emitted value (no thrash).

5. **Frontend — `ui/src/api.ts`.**
   - Add `title_suggested` to the session-event union type:
     `{ kind: "title_suggested"; title: string }`.

6. **Frontend — `ui/src/tabs/manager.ts`.**
   - **Cold-start fix:** change `defaultTitle: \`zsh ${seq}\`` (manager.ts:3645)
     to the **cwd basename** of `initialCwd` (e.g. `covenant`), falling back to
     `shell` when cwd is empty/unknown. This alone kills `zsh 27` immediately,
     before any LLM title exists.
   - **Live handler:** in the session-event switch (alongside
     `foreground_changed`, manager.ts:2981), handle `title_suggested`:
     set `tabRef.current.defaultTitle = event.title` **only if `customName` is
     null**, then re-render the tab label. Ignore empty titles.

## Behavior contract

| Situation | Title shown |
|---|---|
| Brand-new tab, no activity yet | cwd basename (`covenant`), else `shell` |
| After meaningful activity | AI label (`debugging auth`) |
| Manual rename set | `customName`, sticky — auto-titling stops for that tab |
| No API key / no summary route | cwd basename stays (degrades like summarizer) |
| Manifest restore | `customName` → last persisted title → cwd basename |

Render path is unchanged: the tab still displays `customName ?? defaultTitle`.
We only ever write `defaultTitle`; `customName` is never touched by auto-titling.

## Edge cases

- **Thrash:** summarizer tracks the last emitted title; emits `TitleSuggested`
  only on change.
- **Empty title:** never overwrites the cold-start basename.
- **Bus lag / closed:** same handling as the existing summarizer loop; a missed
  title is recovered on the next block.
- **Multiple tabs, same activity:** acceptable — disambiguation by counter is
  not reintroduced; the cwd basename already differs by project, and the user
  can manually rename.

## Out of scope (flagged, not fixed)

- **Secret masking:** `summarizer.rs` currently sends block output to the LLM
  without masking, contrary to CLAUDE.md pitfall #7 ("Do not send secrets to the
  LLM"). This feature *inherits* that path; it does not introduce it. Defaulted
  to note-only per user. Fold in only if requested.

## Files touched

- `crates/app/src/summarizer.rs` — forced-tool structured output, title parse,
  publish `TitleSuggested`, change-detection.
- `crates/app/src/world.rs` — `title` field.
- `crates/app/src/storage.rs` — `title` column + migration, `save_summary`
  param, load on restore.
- `crates/session/src/lib.rs` — `TitleSuggested` event + `to_ui` mapping;
  `spawn_loop` sender wiring (caller passes the bus sender).
- `ui/src/api.ts` — `title_suggested` event type.
- `ui/src/tabs/manager.ts` — cwd-basename cold start + `title_suggested`
  handler.

## Testing

- **Rust:** unit test `save_summary`/load round-trips the title (extend
  `summary_upsert_replaces_prior` at storage.rs:3116). Unit test the title
  parse from a forced-tool response. Unit test `to_ui()` maps `TitleSuggested`.
- **Frontend:** extend `manifest-roundtrip` / a manager test to assert
  cold-start `defaultTitle` is the cwd basename, and that a `title_suggested`
  event updates `defaultTitle` but is ignored when `customName` is set.
- **Manual:** open a tab in a project → see basename; run a few commands →
  title upgrades to an activity label; rename manually → stops updating.
