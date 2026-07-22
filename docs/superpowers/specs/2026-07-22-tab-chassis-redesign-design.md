# Tab Chassis Redesign — Design

**Date:** 2026-07-22
**Status:** Approved (brainstorm w/ visual companion, mockups in `.superpowers/brainstorm/61220-1784694142/content/`)

## Problem

Dev feedback on the current tab/group styles (all 5: Classic, Forge, Glass, CRT, Custom) is uniformly negative: toy-like, noisy, inconsistent between styles and layouts, generic. Root cause analysis: the noise lives in the **base sheet** (`ui/src/styles.css`), not the theme files — group-tinted labels, pill count badges, detached spines, 40px+ rows are base chrome that every theme inherits. Theme files then fight the base with specificity wars (see `glass.css:93-96`).

This also violates DESIGN.md principles #1 ("chrome recedes") and #2 ("semantic color only"): 14 groups painting label + spine + badge in their identity color at rest is decoration, not meaning.

## Decisions (user-approved)

1. **All 5 styles stay** — each gets redesigned, none deleted.
2. **Color follows focus** — groups at rest are monochrome; group color appears only on the active/focused group, hover, and a 6px dot.
3. **Chassis-first architecture** — rebuild the base tab chrome once; each theme becomes a single signature move layered on top.
4. **Active edge in horizontal = bottom underline** (Zed language: the tab connects to the terminal below it), not the current top stripe.

## The Chassis (base `styles.css`)

One grammar, both layouts.

### Group chip — rest state (monochrome)

- Chevron `rgb(var(--ink-rgb) / 0.28)`, rotates 90° when expanded.
- **Dot 6px** in `--group-color` — the ONLY color at rest.
- Label: `--fs-title` treatment (10.5–11.5px, uppercase via CSS, `--ls-title`), color `--tab-fg-rest`. Weight 500.
- Count: bare mono `--fs-micro`, `--text-tertiary`. **No pill, no border, no background.**
- Row height 28px. Hover: `rgb(var(--ink-rgb) / 0.04)`.
- Group with 0 tabs: label + count drop to a dimmer tier, dot at 0.35 opacity.

### Group chip — focused state

The group containing the active tab lifts its label to `--text-primary`. Nothing else changes. This is the only rest-state differentiation between groups.

### Tabs

- Vertical: 26px rows, mono 12px, indented under the group chip. Horizontal: `--tab-h` (30px), mono.
- Rest: `--tab-fg-rest`, transparent. Hover: ink 0.04 fill, text lifts one tier.
- **Active: `rgb(var(--ink-rgb) / 0.06)` fill + 2px `--group-color` edge** — left edge in vertical, bottom edge (underline) in horizontal. No capsule, no shadow, no gradient in the base.
- Close ×/status affordances right-aligned, hover-revealed (existing behavior preserved).

### Horizontal group grammar

Groups render as segments: `dot + label (+ count)` head, tabs after it, 1px hairline separator (`rgb(var(--ink-rgb) / 0.07)`, inset vertically) between groups. No troughs, no tinted shells.

### AOM (agent-on-mission) treatment

Chassis-owned, identical across all 5 themes: the tab's status dot pulses in `--accent` with a breathing 1px ring. Replaces the per-theme conic-gradient blur auras. Respects `prefers-reduced-motion` (static ring).

### Theming invariants

- Every fill/hairline composes from `--ink-rgb` (slash syntax — DESIGN.md rule 13) → light theme and True Dark work without per-theme overrides.
- Group-color usage always via `color-mix` with `var(--group-color, var(--accent))` fallback.
- No new fonts, no emoji, tooltips via `attachTooltip` (unchanged).

## The 5 Signatures

Each theme file shrinks to ONE move on the active tab + minimal supporting rules. All group/badge/chip overrides are **deleted** — the chassis owns those.

| Theme | Signature | Notes |
|---|---|---|
| **Classic** (default) | None — the chassis pure | The face of the product. Spine/underline in group color, flat ink fill. |
| **Forge** | Hot seam: the active edge becomes a heated-metal gradient (`#ffd9a0 → #ff8f5e → group color`) with a minimal glow (`box-shadow` halo) and a heat-tint fading across the fill | Vertical: left seam; horizontal: bottom seam with upward glow. |
| **Glass** | The sliding indicator (existing `tabs/glass-indicator.ts` JS, re-skinned): hairline capsule — `ink 0.06` fill, `inset 0 0 0 1px ink/0.09` border, tiny top bevel. **No bright gradient, no drop shadow.** Motion (0.42s spring) is the signature | Indicator inset 1–2px within the row. |
| **CRT** | Blinking block caret before the active label + scanline texture (`repeating-linear-gradient`) on the active row only; whole tabbar switches to the mono stack | Caret in group color. `prefers-reduced-motion`: caret solid. |
| **Custom** | The knobs, remapped to chassis primitives: **indicator** (spine · capsule · underline · none), **fill** (none · ink · tint), **height** (24 · 26 · 30), **gap** (0 · 2 · 4), **radius** (0 · 4 · full) | Defaults reproduce Classic. Existing persistence keys migrate where they map; unmappable old values fall back to defaults. |

## Out of scope

- Tab drag & drop mechanics, tab lifecycle, group management logic — untouched.
- Operator chip (`operator_chip.css`) — untouched (verify it still sits correctly on 26px rows).
- New settings/knobs beyond remapping Custom's existing ones.

## Files touched

- `ui/src/styles.css` — tab/group chip base section rewrite (chassis).
- `ui/src/styles/tab-themes/{forge,glass,crt,custom}.css` — shrink to signatures.
- `ui/src/tabs/glass-indicator.ts` — skin only (CSS lives in glass.css; JS positioning unchanged).
- `ui/src/settings/panel.ts` — tab-style picker descriptions updated to the new looks.
- `docs/DESIGN.md` — tab section updated (underline direction, chassis grammar, AOM treatment).

## Verification

- `npm test` from repo root (Vitest) + `cargo test --workspace` untouched-but-green.
- Visual verify via respawn: both layouts (top/left) × 5 styles × 3 themes (dark, light, true-dark), with: 14 groups incl. a 0-count group, active tab mid-list, AOM-active tab, collapsed groups.
- Light theme: confirm no hardcoded white alphas leak (all ink-composed).
- True Dark: confirm no accent-tinted elevation (rule 4).

## Risks

- `styles.css` base rewrite touches selectors other panels may lean on (`.group-chip` is tab-bar-scoped, but verify no reuse).
- Custom knob migration: users with saved Custom configs get nearest-equivalent mapping, not pixel-identical looks. Acceptable — the old looks are the problem being fixed.
