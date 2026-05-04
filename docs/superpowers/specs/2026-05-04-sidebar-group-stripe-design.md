# Sidebar Group + Tab Redesign — Lateral Color Stripe

**Date:** 2026-05-04
**Status:** Approved (design); pending implementation plan
**Scope:** UI sidebar (left tab bar) — visual treatment of tab groups and member tabs only. No behavioral changes.

## Problem

Current sidebar (see baseline screenshot in conversation) uses two visual treatments simultaneously: a top accent stripe on the group's first tab and a left-edge color line on member pills via `.tab-grouped::after`. Result:

- Group header pill and member tab pill carry near-equal visual weight.
- Color identity of a group is communicated by a thin/subtle line that gets lost.
- Layout reads as a flat list of similarly-shaped pills rather than a hierarchy.

## Goal

Establish a clear "container" identity per group via a single, bold lateral color stripe that hugs the entire group (header + members) when expanded, and shrinks to header-height when collapsed. Members become flat rows inside the container.

## Design

### Structure

```
┌─┬──────────────────────────────┐
│ │ ▾ COVENANT              [1]  │   ← header row inside body
│ │ ────────────────────────────  │
│ │  🟣 superpowers          5    │   ← member row
│ │  🟣 other-tab            2    │
└─┴──────────────────────────────┘
 ↑ stripe (3px, group color, radius 2px, stretches full height)
```

Each group is a flex row: `[stripe] [body]`. Body holds header + member list stacked.

### Stripe

- Width: **3px**, border-radius **2px**, margin-right **8px**.
- Color: full saturation of the group color (no fading, no gradient).
- Height: `align-self: stretch` when expanded → matches body height automatically. When collapsed, body collapses to header height (~28px) and stripe follows.
- One stripe per group. Replaces:
  - The "top accent stripe" currently in `ui/src/styles.css:908` (`.tab-grouped::after` block above member rows).
  - The left-edge color on `.tab-grouped::after` (line 1069).

### Group header

- UPPERCASE label with wide letter-spacing (preserve current typography).
- Chevron (▾ / ▸) at left, count pill at right (preserve current).
- Padding: `4px 8px`. No background, no border.
- The header lives **inside** the body column, to the right of the stripe.

### Member rows

- Avatar (18px circle) + badge with numeric count — **unchanged from current**.
- Row background: `rgba(255,255,255,0.02)`, border-radius 5px, padding `5px 8px`.
- Vertical gap between rows: 2px.
- Active member: background `rgba(255,255,255,0.06)`. No additional left border (the stripe already conveys group identity).
- Hover (non-active): background `rgba(255,255,255,0.04)`.
- No left/right color stripe on individual member pills.

### Spacing

- Vertical gap between groups: **6px** (tighter than current).
- Body left padding: 0 (stripe + 8px margin already provides indent).

### Collapsed state

- Body collapses to header-only height; stripe matches naturally via `align-self: stretch`.
- No special CSS branch needed — flex handles it.

## Affected Files

- `ui/src/styles.css` — remove `.tab-grouped::after` color rules and the top accent stripe block (around lines 908, 1069, 1089–1097); add `.tab-group-shell` flex container + `.tab-group-stripe` rules.
- `ui/src/tabs/manager.ts` — wrap each rendered group's header + member pills in a `.tab-group-shell` element with `data-group-color` attribute; remove now-redundant `tab-grouped-first` first-pill bookkeeping (lines 1988–2000, 2204, 2350–2354) where it only existed to drive the old top stripe.
- `body.tabbar-left` overrides at `ui/src/styles.css:6411–6435` — most of those rules become dead code once the per-pill `::after` is gone; clean up.

## Out of Scope

- Operator avatar styling (kept as today).
- Group color picker / palette changes.
- Drag-and-drop affordances.
- Tabs in horizontal (top) tab bar — this design targets `tabbar-left`. Horizontal layout will be revisited separately if needed.

## Acceptance

- Visually matches mockup direction "D" presented in brainstorming session.
- All five baseline groups (Covenant, Raven, Karluiz, Nxt, Control) render with full-saturation stripes; expanded groups show stripe stretched over header + members.
- No regression in: collapsing/expanding, drag-to-reorder, active-tab indication, mission color/avatar rendering on member tabs.
