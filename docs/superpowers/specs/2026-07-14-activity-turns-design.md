# Activity panel — turn-level rows (design)

**Date:** 2026-07-14
**Problem:** The Activity sidebar (`ui/src/inline-notch.ts`) renders raw `notch:state` phase events. The backend heartbeats "thinking" every ~3s per session, and coalescing only merges *adjacent* identical rows, so interleaved sessions/phases produce a metronome of pointless "Claude · thinking" rows.

## Decision

Aggregate on the frontend at the **turn** level. No backend changes — the `notch:state` payload already carries everything needed (`running <cmd>`, `writing <file>`, `reading <file>`, `waiting · reason`, `done summary`, `tokens_delta`).

## Turn model

- A turn **opens** when a session's phase leaves `idle`/`done`.
- A turn **closes** on `done` (freeze, show summary + duration) or `idle` (freeze as "ended").
- Per turn: agent, tab label, session id, start/end timestamps, cumulative tokens, `events[]`.

## Meaningful events (lines inside the fold)

- `running <cmd>`, `writing <file>`, `waiting · <reason>`, `done`.
- `reading` never creates event lines — it feeds a per-turn counter ("read N files", distinct files).
- Consecutive repeats of the same event dedupe into one line with `×n`.
- `thinking` is **never** an event; it only advances the turn's elapsed time and token counter.

## UI

Reuses shared `.rail-row` chrome + Beacon's `.rail-fold` expandable pattern.

**Collapsed row (default):**
- Line 1: `<Agent> · <live tail>` + clock time. Live tail = latest meaningful event while running, or `done · 2m 14s` when frozen. Spine = live/ok/run/fail/idle as today.
- Line 2 (meta): `COVENANT › karlTerminal · 3 cmds · 2 files · 8.2k tok`

**Expanded (click):** chronological list of meaningful events, each with timestamp.

## Caps & chrome

- Keep agent picker, clear, collapse button, scroll-anchor logic untouched.
- Cap 30 turns (replaces `MAX_ROWS = 40` rows).
- Cap 50 events per turn; oldest dropped with an "earlier events dropped" marker.

## Testing

Phase-stream → turn aggregation extracted as a pure module with a vitest file beside it. Feed a recorded "thinking metronome" stream (interleaved sessions, heartbeats, reads) and assert: one turn per session, correct event lines, no thinking events, token totals, dedup counts.
