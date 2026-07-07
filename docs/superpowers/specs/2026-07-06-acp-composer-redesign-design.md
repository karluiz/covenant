# ACP chat composer redesign

**Date:** 2026-07-06 · **Approved:** unified card, composer-only centering.

## Problem

The ACP tab composer is a bare full-width `rows=2` textarea with detached
square Cancel/Send buttons. On wide windows it stretches edge-to-edge and
reads as an empty bathtub.

## Design

One rounded composer card, centered, `width: min(760px, 100%)`:

- Borderless textarea inside the card, `rows=1`, auto-grows with content
  (cap 200px), `resize: none`. Focus ring moves to the card
  (`:focus-within`).
- Internal footer row: hint `↩ send · ⇧↩ newline` left (tertiary, 10.5px),
  actions right.
- Send = 26px circular accent button with ↑ arrow SVG; disabled while the
  input is empty.
- While a turn is in flight, Send hides and a circular ■ stop button
  (`--fail` tint) takes its place — they never sit side by side.
- Slash menu, mention menu, and pasted-image strip re-anchor to the
  centered card width (`left: 50%; translateX(-50%); width: min(760px,
  calc(100% - 28px))`) instead of the full-width form.
- Transcript untouched (recent scroll/zoom-paint fixes stay clear).

## Files

- `ui/src/executors/acp/view.ts` — mount markup, autosize/disabled sync
  helper, `setInFlight` swaps send↔stop.
- `ui/src/executors/acp/acp.css` — composer section rewrite.

## Out of scope

Transcript column centering, attachment button, model picker in composer.
