# Convergence Master-Detail — Design

**Date:** 2026-07-27
**Status:** Approved (Karluiz, 2026-07-27)
**Scope:** UI redesign of the Convergence overlay (⌘⇧M) + one backend field.

## Problem

The current overlay is a card grid that wastes the screen: a few small
rounded cards in the top-left, ~85% empty space. Card headers cram
executor + tab link + pill + operator + Stop into one wrapping row; the
headline is the executor name ("claude" × N — zero information) while the
tab title, the actual identity, is a secondary link. Status is stated three
times (dot, pill, full colored border). Rounded corners and full colored
outlines are off the house language (sharp corners, left spine,
monochrome-rest). `cwd`, mission, cost, subagents and elapsed exist in
`AgentCard` but are rarely visible.

## Direction

Master-detail. Dense rows on the left, a live detail pane on the right.
The empty space becomes the detail. Scales to 20+ agents.

```
┌─ CONVERGENCE ──────────────────────── esc ─┐
│ 3 agents · 1 needs you · 1 working   $0.42 │
│ [all] [needs you] [working] [idle]         │
├──────────────────┬─────────────────────────┤
│▌● PERCEPTION UPD │ AGENT TESTS     waiting │
│▌  claude · 4m32s │ claude · Zeta · ~/kT    │
│▌  thinking…      │ ─────────────────────── │
│┃● AGENT TESTS  ◀ │ $ cargo test --workspace│
│┃  claude·Zeta 2m │ running 34/210…         │
│┃  cargo test…    │ ● subagent: fix-flaky 1m│
│▌○ UI BUG    done │ ─────────────────────── │
│▌  claude · 12m   │ [Reply to operator…   ] │
│                  │ [one-shot ▾]     [Send] │
└──────────────────┴─────────────────────────┘
```

## Layout

Header strip unchanged in content (summary + filter chips). Below it, a
two-column split:

- **Left rail** (~340px, scrollable): one row per agent session. The
  separate attention queue section is removed — blocked sessions are rows
  like every other, sorted first (existing `sortAgents` order), with a
  danger spine. On open, the first blocked session auto-selects; else the
  first row.
- **Right detail pane** (flex): the selected agent, refreshed by the
  existing 1s poll.

## Row anatomy

```
▌● AGENT TESTS            2m
▌  claude · Zeta
▌  cargo test --workspace
```

- **Spine (2px left border) is the only status color**: working green,
  awaiting-input amber, blocked danger, operator-thinking accent, idle no
  color + opacity .6. Dot repeats the color at 7px; nothing else colored.
- **Headline = tab title**, uppercase via CSS (`text-transform`), never
  string mutation. Elapsed right-aligned.
- Sub-line: executor · operator name. Third line: activity
  (`phase_label` ?? `last_command` ?? `last_output_line`) in mono, muted,
  single line ellipsized.
- Selection: `↑`/`↓` moves (existing handler), `Enter` focuses the tab and
  closes the overlay (existing), click selects, double-click focuses tab.
  Selected row: neutral lifted background + heavier spine — no accent
  outline.
- Filters filter the rail; "needs you" shows only blocked rows (they are
  no longer excluded from the list since the queue is gone).

## Detail pane

Top to bottom:

1. **Head:** tab title + status pill + actions: `Open tab ↵` and, when an
   operator is attached, `Stop` (same single-click no-confirm semantics).
2. **Meta line:** executor · operator avatar+name · mission chip · cwd
   (home-abbreviated) · cost bar (existing `costBar`).
3. **Live tail:** mono block, ~15 lines, from the new always-populated
   `AgentCard.excerpt`. ANSI-stripped, secret-masked upstream (same path
   as today's blocked excerpt).
4. **Subagents:** existing `renderSubAgents` rows.
5. **Blocked interaction:** question + ACP permission options / operator
   reply composer with scope select / PTY reply — reusing the rendering
   in `attention.ts` inside the pane. The composer no longer exists in two
   places.

Empty states: no agents → existing full-overlay empty state. Snapshot
error → existing retry state. No selection is impossible while rows exist.

## Visual language

Sharp corners (`border-radius: 0` everywhere except 50% dots), neutral
surfaces, monochrome-rest (color only in spine/dot/pill), `attachTooltip`
only (no native `title`), no emoji — inline SVG `Icons.*`. Light theme:
per DESIGN.md; watch the `body.theme-light input` specificity trap for the
composer textarea.

## Backend change

`crates/app/src/convergence.rs`: `AgentCard.excerpt: Option<String>` —
populated for **all** statuses, not only `Blocked`. The per-session
`tail_bytes` snapshot (8KB) is already taken; drop the
`matches!(status, TileStatus::Blocked)` gate on
`last_non_empty_lines(&tail_bytes, 15, 200)`. Regression test: a working
session's card carries an excerpt.

`ui/src/api.ts`: add `excerpt: string | null` to `AgentCard`.

## Files touched

- `crates/app/src/convergence.rs` (+ its tests)
- `ui/src/api.ts`
- `ui/src/convergence/overlay.ts` — split layout, selection feeds pane
- `ui/src/convergence/tile.ts` — row renderer + detail renderer (replaces
  card renderer); `renderReply` stays
- `ui/src/convergence/attention.ts` — rendering reused inside the pane;
  standalone queue section removed
- `ui/src/convergence/model.ts` — `attentionIndex` exclusion no longer
  used by the grid (blocked rows stay in the list)
- `ui/src/styles.css` — `mc-*` block rewritten
- Tests adjusted: `overlay.test.ts`, `tile.test.ts`, `model.test.ts`,
  `attention.test.ts`

## Out of scope

- Real terminal streaming / embedded xterm in the pane (15-line excerpt at
  1s poll covers it; embedding is its own milestone).
- Any change to snapshot polling, sorting semantics, or reply scopes.
- Multi-select or bulk actions.
