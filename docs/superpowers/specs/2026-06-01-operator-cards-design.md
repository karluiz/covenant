# Operator Cards — Design Spec

**Date:** 2026-06-01
**Status:** Approved for planning
**Author:** Karluiz + Claude

## Summary

When an operator informs the user of structured information (a list of commits,
changed files, tasks, options), it currently renders as an unbroken prose paragraph —
a wall of text — because the chat render path only does inline formatting. Give the
operator a **card**: a titled block with rows that it emits deliberately for structured
content. Purely a render-layer + prompt change. No storage, schema, agent-loop, or
command changes.

## Problem

`renderInlineContent` (`ui/src/teammate/panel.ts:1730`) escapes all HTML and applies only
**inline** formatting — code spans and `@spec`/`@file` mention chips. There is no
block-level rendering: numbered lists, tables, and headings collapse into one paragraph.
The 10-commit summary that motivated this (rendered as `1. … 2. … 3. …` in a single
bubble) is the canonical failure.

## Decisions

| Question | Decision |
|---|---|
| Core goal | Readability of structured replies — not a new semantic message type |
| Trigger | Operator emits explicit structured markup (it chooses card vs prose per reply) |
| Card schema | One generic card: optional title + list of rows (`label \| value`) |
| Render reuse | Each card cell runs through the existing inline renderer (chips/code preserved) |
| Backend | None — markup rides inside existing message text |

## Markup Format

The operator emits a fenced block. Natural for an LLM, won't collide with prose:

````
```card title=Last 10 commits
b481d7d | operator threads plan
76342a5 | operator threads spec
3db720e | release v0.8.42
```
````

- Fence info string carries `title=…` (optional; trailing text after `card ` is the title).
- Each non-empty line is one row. `label | value` splits on the **first** `|`; a line with
  no `|` is a single full-width cell.
- **Each cell is rendered via the existing `renderInlineContent`**, so `` `code` ``,
  `@spec:` and `@file` mention chips keep working inside cells. Cards are a container
  around the render path we already have, not a parallel one.
- Whitespace around `title=`, labels, values, and the `|` is trimmed.
- An empty card body (fence with no rows) renders title only; a malformed/unterminated
  fence falls back to rendering as plain prose (no crash).

## Renderer (TypeScript) — `ui/src/teammate/panel.ts`

- New `renderMessageBody(text: string): string` replaces the two
  `b.innerHTML = renderInlineContent(...)` call sites (panel.ts:1289 and :1304).
- It scans the message for ` ```card ` … ` ``` ` fences and splits into segments:
  - **prose segment** → existing `renderInlineContent` (unchanged behavior)
  - **card segment** → a card builder emitting a titled block with rows
- All card cells are escaped (they go through `renderInlineContent`, which escapes), so
  assigning the result via `innerHTML` stays safe.
- Plain replies (the common case) contain no `card` fence and pass through byte-identical
  to today.

### Card builder

Produces:

```html
<div class="teammate-card">
  <div class="teammate-card__title">Last 10 commits</div>   <!-- omitted if no title -->
  <div class="teammate-card__row">
    <span class="teammate-card__label">b481d7d</span>
    <span class="teammate-card__value">operator threads plan</span>
  </div>
  …
</div>
```

A single-cell row (no `|`) emits one full-width `teammate-card__cell` instead of
label+value.

## Prompt Directive (Rust) — `crates/app/src/teammate/llm.rs`

- Add a static `CARD_DIRECTIVE` const, appended in `build_system_prompt` (llm.rs:157),
  following the existing `SENTIMENT_DIRECTIVE` pattern. Static text → the system prompt
  stays stable → Anthropic prompt cache still hits.
- Content: when informing the user of a **list of structured items** (commits, changed
  files, tasks, options, key/value facts), emit a `` ```card `` block instead of a
  numbered paragraph. Include the format and one short example. Prose remains the default
  for conversational replies; the operator decides per-reply.

## Styling — `ui/src/teammate/` CSS (and/or `ui/src/styles.css`)

- `.teammate-card`: square corners, flat surface, subtle border — consistent with the
  operator drawer's square-corner / seamless aesthetic. No row gradients, no border-top
  seams.
- `.teammate-card__row`: label/value two-column; rows divided by a subtle hairline.
- Monospace-friendly for sha/path-like labels.

## Out of Scope (YAGNI)

- Typed cards (commit-list / file-changes / task-list with per-type semantics).
- Clickable shas as commit objects; diff-stat rendering.
- Collapsible, pinnable, or persistent cards.
- Nested cards, markdown tables, multi-column beyond label+value.
- Heuristic auto-promotion of prose lists to cards.

## Testing

- Renderer: a message with one `card` fence → titled card with N rows; `label | value`
  splits on first `|`; single-cell row renders full-width; code spans and `@`-chips
  survive inside cells; a message with no fence renders identically to today.
- Robustness: unterminated/malformed fence falls back to prose; empty card body renders
  title only; multiple cards in one message each render.
- Prompt: `build_system_prompt` output contains the card directive and remains stable
  across calls (cache-safe).
