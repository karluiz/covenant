# Folded sidebar rail styles — design

**Date:** 2026-07-01
**Status:** approved (Karluiz: "implementa todas y déjalas en Appearance")

## Problem

The folded vertical tabbar (`body.tabbar-left-collapsed`) renders "variant 6"
(`ui/src/tabs/collapsed-rail.ts`): a group stripe plus anonymous 14×6 color
pills. Tabs are unidentifiable without hovering. Karluiz wants richer folded
styles, selectable in Settings → Appearance, keeping the current look as
"Legacy".

## Decision

Four folded-rail styles, one setting:

| Value | Look | Collapsed width |
|---|---|---|
| `legacy` (default) | current pills + stripe, unchanged | 30px |
| `glyph` | monogram tiles (2 letters) + color group badge, active = filled tile; VSCode-activity-bar pattern | 56px |
| `labels` | truncated tab names under tiny uppercase group headers | 96px |
| `spine` | ultra-dense segmented bar per group, group monogram on top | 30px |

HTML mockups of all four were reviewed side-by-side and approved.

## Architecture

- **Backend** (`crates/app/src/settings.rs`): `FoldedRailStyle` enum
  (`#[serde(rename_all = "lowercase")]`, `#[default] Legacy`), new
  `folded_rail_style` field on `Settings` with `#[serde(default)]` — old
  settings files deserialize to Legacy. Mirrors `TabbarPosition` exactly.
- **Apply path** (`ui/src/tabs/custom-style.ts`): `applyFoldedRailStyle(style)`
  toggles `body.tabbar-rail-<style>` (legacy = no class) and dispatches a
  `covenant:folded-rail-style` window event so the rail rebuilds.
- **Rail** (`ui/src/tabs/collapsed-rail.ts`): `render()` reads the style from
  the body class and branches into the four DOM builders. Listens for the
  apply event to re-render live. All styles reuse the existing
  `.tabbar-rail-cell-wrap` / `.tabbar-rail-cell-peek` hover-peek machinery.
  Monogram = first two alphanumeric chars of the name (fallback `·`); browser
  tabs render a globe glyph. Group names uppercase via CSS, never mutated.
- **CSS** (`ui/src/styles.css`): per-style `--tabbar-w` override under
  `body.tabbar-left.tabbar-left-collapsed`, plus one block per style keyed
  off the body class. Theme vars (`--ink-rgb`, `--fg`, `--muted`) keep light
  mode working without a parallel ruleset. The GPU fold animation
  (`rail-slide.ts`) is transform-based and width-agnostic — no changes.
- **Settings UI** (`ui/src/settings/panel.ts`): "Folded sidebar" radio group
  in Appearance after "Tabbar position"; hydrate/save/live-preview mirror the
  `tabbar_position` pattern (preview applies instantly, close restores
  `this.current`).

## Out of scope (v2)

- Per-tile running/failed status dots (needs a `getRailSnapshot()` extension).
- Any change to the expanded tabbar or the fold animation.

## Testing

Vitest: monogram helper + per-style DOM shape (tile text, row labels, segment
counts, active flag) from a fake snapshot. Rust: `cargo check` (field is
plumbing only). Manual in-app pass over the four styles in both themes.
