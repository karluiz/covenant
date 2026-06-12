# Achievements panel — theme homologation

**Date:** 2026-06-12
**Scope:** CSS-only restyle of the Achievements card in the Covenant Score settings page (`ui/src/score/styles.css`, `.cov-ach-*` / `.cov-rep-*` rules). No TS/DOM changes.

## Problem

The achievements card (merged in Achievements MVP A, 41f86bd) was styled with
generic `rgba(255,255,255,…)` lifts and a Tokyo Night palette (blue/purple
`#7aa2f7`/`#bb9af7` reputation bars, green/blue rarity rings). The rest of the
Covenant Score page speaks a different language — `#131a1e` cards, `#1c252b`
borders, teal `#5eead4` brand accent, 9–11px uppercase wide-tracked labels —
so the card read flat, washed out, and off-theme. It also had zero
`body.theme-light` overrides, unlike every other surface on the page.

## Design

1. **Tiles, not floating rows.** Catalog entries, recent awards, and
   in-progress items each get a `#0f1419` surface with `#1c252b` border,
   radius 8, and a `#324048` hover border (catalog only) — matching the
   stat-card / heatmap-cell elevation hierarchy.
2. **Reputation bars in brand teal.** Fill uses the heatmap ramp
   (`#1f8a7a → #5eead4`) on a bordered `#0f1419` track; values render in
   cyan `#7dd3e0`; labels follow the stat-label idiom (9px, 1.2px tracking,
   `#6c8088`).
3. **Pills match `cov-chip`.** 6px radius, `#243036` border, `#0f1419` fill,
   muted text; the earned count (`strong`) is teal.
4. **Section headers unify** to the `.cov-card h4` convention: 10px, 1.5px
   tracking, 600 weight, `#4a5b63`.
5. **Rarity hues harmonized.** Uncommon = brand teal `#5eead4`, rare = cyan
   `#7dd3e0`, epic/legendary keep violet/gold; all badges sit on dark
   `#131a1e` fills with muted (darker, same-hue) borders and a faint glow on
   rare+ — jewel tones, not stickers. Earned tiles tint their border with
   the rarity hue.
6. **Light theme overrides added** in the existing `body.theme-light`
   section: `var(--bg-panel)`/`var(--border)` surfaces, `#0a8f7d` teal-on-
   light (matching the established mapping), darker rarity tones, no glows.

## Revision 2 — token-driven (same day)

Karluiz pointed out the first pass matched the Score *page* but not the app
*theme*. The `.cov-ach-*` rules were rewired from hardcoded hex to the app
theme tokens defined in `ui/src/styles.css`:

- Surfaces/tracks: neutral `rgba(var(--ink-rgb), 0.03–0.06)` lifts (True
  Dark-safe per the neutral-lift rule), borders `var(--border)`.
- Accent: `var(--accent)` (blue `#7aa2f7` dark / `#2f6fed` light) for rep
  bars, values, pill counts — no more hardcoded teal.
- Text: `var(--text-primary)` / `var(--muted)` / `var(--fg-dim)`.
- Rarity: common = neutral ink, uncommon = `var(--ok)`, rare =
  `var(--accent)`; epic/legendary are fixed jewel tones via `--ach-epic` /
  `--ach-legendary` custom props on `.cov-ach-card`, swapped darker under
  `body.theme-light` (glows also disabled there). Borders blend rarity hues
  into `var(--border)` with `color-mix`.
- The hand-written `body.theme-light .cov-ach-*` override block from rev 1
  collapsed to two rules; dark / light / True Dark all derive from tokens.

## Out of scope

- TS changes, new sections, behavior. The rest of the Score page still uses
  its hardcoded palette; migrating it to tokens is a separate task.
