# Canon cockpit: homologated empty states + Loop light-mode fix

**Date:** 2026-07-14 · **Status:** approved

## Problem

1. Every empty cockpit section fell back to a bare `note()` paragraph with three
   inconsistent phrasings (no org / no repo / empty list). No hierarchy, no action.
2. The Loop section looked broken in light mode:
   - `--warn` / `--good` only exist scoped to spec-chat — Canon's lift meters and
     badges resolved to hardcoded dark-palette fallbacks (`#e0af68`, `#3fb950`,
     `#e5534b`) in both themes (DESIGN.md rule 9 violation).
   - `.canon-loop-verdict` had no CSS at all.
   - `.canon-preview` fell back to `rgb(0 0 0 / 0.28)` (`--pn-code-bg` is scoped
     to project-notes) — a dark slab on light.

## Design

**Empty states** — one helper `emptyState({icon, title, hint, action?})` in
`cockpit/view.ts`, reusing the rail's existing `.rail-empty` chrome (already
tokenized, light-safe) with a `.canon-cockpit-empty` rescale for the wide
content column. Two shared variants: `emptyNoOrg(hint)` (boxes icon + "Open Org"
CTA) and `emptyNoRepo(hint)` (folderPlus icon). Per-section icons/copy for empty
lists; CTAs where a creation affordance exists (Create organization, New
operator, Browse registry, New context). `note()` remains for Loading…, errors,
and search-empty results. Loop gets a full empty state when the group has
neither repo nor org.

**Loop light mode** — map to semantic tokens: `lift-neg` meters → `--running`,
lift badges → `--ok` / `--fail` with `color-mix` borders; style
`.canon-loop-verdict` (14px semibold, `--text-primary`); light override for
`.canon-preview` mirroring project-notes' light code background.

## Files

- `ui/src/canon/cockpit/view.ts` — helper + all empty-case call sites
- `ui/src/canon/cockpit/cockpit.css` — `.canon-cockpit-empty` rescale
- `ui/src/canon/styles.css` — Loop token fixes, verdict style, preview light fix
- `ui/src/canon/cockpit/view.test.ts` — empty-state coverage
