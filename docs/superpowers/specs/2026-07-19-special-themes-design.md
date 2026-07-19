# Special Themes — design

**Date:** 2026-07-19
**Branch:** `feat/special-themes`
**Status:** design approved, not implemented
**Design note (visual):** https://claude.ai/code/artifact/c064ac3e-9bbb-409e-87a9-f7b46f4bda65

---

## Problem

Covenant ships four theme modes (`system` / `dark` / `true_dark` / `light`), all of them
hardcoded CSS class overrides. There is no theme registry, and there is no wallpaper
support of any kind — every "wallpaper" reference in the codebase means the user's macOS
desktop showing through the transparent window via `NSVisualEffectView`.

We want Discord-style **Special Themes**: wallpaper-backed visual identities applied to the
whole window. Five ship at launch, from art already sitting untracked in `themes/`. The
sixth and every one after it must cost one registry entry and one image.

## Scope

**In:** whole-window wallpaper (art behind every surface, not just the terminal), a palette
derived from each artwork, matching xterm colors, a per-theme calibrated scrim with a user
slider, a tile gallery in Settings → Appearance, persistence in `config.json`.

**Out (deliberately, see §9):** user-supplied wallpapers, animated art, per-tab themes,
blur on the art, full 16-color ANSI ramps.

---

## 1. What a Special Theme is

Four things applied together and never separately:

| Part | What it does |
|---|---|
| **Art** | A bundled `.webp`, painted once on `body`, behind everything |
| **Scrim** | A veil (color + alpha) between art and UI, calibrated per theme for legibility |
| **Palette** | `--bg-*`, `--accent`, `--border` derived from the artwork's own colors |
| **Terminal colors** | The xterm `ITheme` — foreground, cursor, selection |

Shipping only the art reads as a sticker on a dark app. Shipping the palette with it makes
the app look designed *for* the art. That difference is the entire feature.

## 2. What the source art dictated

All five files are **flat-vector minimalist art**: one solid ground colour across 58–88% of
the frame, one subject, no gradients or texture to speak of. Three consequences that a
generic wallpaper system would have gotten wrong:

### 2.1 The ground colour becomes the theme's base colour

Because the ground is flat, sampling it yields an exact hex the panel chrome derives from.
When the sidebar is a darkened version of the same violet the wallpaper is painted in, the
seam between art and chrome disappears. Not achievable with photographic sources.

### 2.2 The subject sits right; the left is empty

Every composition pushes its character into the right third. Terminal text hugs the left and
runs ragged-right, so the art's negative space and the terminal's dense space are already on
opposite sides. Anchor `background-position: right bottom` and the character occupies the
gutter to the right of the output, never behind it. **This is why the scrim can stay low.**

### 2.3 Measured luminance splits the set

| Theme | Ground | Coverage | Rel. luminance | Treatment |
|---|---|---|---|---|
| Jujutsu Kaisen | `#312452` | 80.0% | 0.025 | dark, light scrim |
| Kimetsu no Yaiba | `#223941` | 58.2% | 0.036 | dark, light scrim |
| Haikyuu!! | `#27344F` | 93.9% | 0.035 | dark, lightest scrim |
| One Piece | `#D0545C` | 88.4% | 0.205 | dark, heavy scrim |
| Bunny Senpai | `#A1A0A5` | 84.9% | 0.354 | **light theme** |

Coverage is the share of pixels in the ground's colour bins after a 6-colour median-cut
quantisation. Haikyuu's gradient spreads across five near-identical navy bins, hence its
high total.

Bunny Senpai is a mid-grey ground with a dark subject. Blackening it to terminal-dark takes
~0.78 alpha, at which point the art is gone. It ships as a **light** theme — white veil,
dark ink — which is what the art was already doing.

**Consequence:** the scrim is not "a darkening amount", it is a **veil colour plus an
alpha**. One field more, and light-ground art is a first-class citizen rather than a bug.

---

## 3. The five themes

`composited` is the ground after the veil is applied — this is the colour the panel tokens
derive from. `contrast` is the terminal foreground (`ink`) against it.

| id | Name | base | ground | veil | scrim | composited | accent | ink | contrast |
|---|---|---|---|---|---|---|---|---|---|
| `jjk` | Jujutsu Kaisen | dark | `#312452` | `#000` | 0.34 | `#201836` | `#A78BFA` | `#DCD9E8` | 12.2:1 |
| `kimetsu` | Kimetsu no Yaiba | dark | `#223941` | `#000` | 0.36 | `#16242A` | `#45D6A6` | `#CFDCDA` | 11.3:1 |
| `haikyuu` | Haikyuu!! | dark | `#27344F` | `#000` | 0.30 | `#1B2437` | `#F0803A` | `#D3D8E2` | 10.8:1 |
| `onepiece` | One Piece | dark | `#D0545C` | `#000` | 0.68 | `#431B1D` | `#E8B84A` | `#EFD9D6` | 11.0:1 |
| `bunny` | Bunny Senpai | light | `#A1A0A5` | `#FFF` | 0.55 | `#D5D4D7` | `#B85C79` | `#191A1D` | 11.8:1 |

Notes per theme:

- **jjk** — deepest ground, already terminal-dark. The scrim sinks the figure rather than
  darkening the frame.
- **kimetsu** — the only source with a second strong colour. The haori's mint green becomes
  `--accent`; the ember red becomes `--danger`. Semantic colours fall straight out of the art.
- **haikyuu** — lowest scrim. Its navy ground is a soft vertical gradient (the only one) that
  runs darker at the top, exactly where the tabbar sits.
- **onepiece** — the hard case. 0.205 luminance needs roughly double the scrim; the red goes
  to oxblood, a better terminal colour than the source. The straw hat's gold is the accent.
- **bunny** — ships light. Near-monochrome source makes the muted rose the only colour on screen.

The five composited contrasts land in a **10.8–12.2:1 band** despite grounds ranging over an
order of magnitude in luminance. That tight clustering is the check that the per-theme scrim
values are calibrated rather than guessed — and the margin over WCAG AA (4.5:1) is what lets
the user push the slider toward more art without breaking legibility.

---

## 4. Data model

New file `ui/src/theme/special.ts` — the registry Covenant currently lacks. The four
existing modes are untouched.

```ts
export type SpecialThemeId = "jjk" | "kimetsu" | "onepiece" | "haikyuu" | "bunny";

export type SpecialTheme = {
  id: SpecialThemeId;
  name: string;                 // shown on the tile
  art: string;                  // Vite-resolved .webp URL
  base: "dark" | "light";       // which token set it extends
  ground: string;               // sampled flat hex — panels derive from this
  veil: string;                 // scrim colour
  scrim: number;                // calibrated default
  accent: string;
  danger?: string;              // when the art supplies one (kimetsu)
  term: Partial<ITheme>;        // xterm foreground / cursor / selection
};

export const SPECIAL_THEMES: Record<SpecialThemeId, SpecialTheme>;
export function isSpecialThemeId(v: string): v is SpecialThemeId;
```

`isSpecialThemeId` is the validation boundary: `config.json` is user-editable, so a bad
`special_theme` string must fall back to `dark` rather than render a broken theme.

### Scrim clamping

The user slider adjusts the shipped default by **±0.20**, clamped to `[0, 0.92]`. Bounded
rather than free so a user cannot slide into an illegible terminal or a fully-erased
wallpaper. The stored value is the absolute scrim, not the delta.

---

## 5. Application

Applying a Special Theme:

1. Sets `body.theme-special` and `data-special="<id>"` on `<body>`.
2. Also sets `body.theme-dark` or `body.theme-light` per the theme's `base`, so every
   existing base-token rule still applies.
3. Writes the theme's tokens as inline custom properties on `:root`
   (`--special-art`, `--special-veil`, `--special-scrim`, `--accent`, `--bg`, `--border`, …).
4. Calls `tabs.applyTerminalTheme()`.
5. Calls `setWindowTheme(base)` — Rust only needs to know which vibrancy material to request.

Everything downstream recolours with no per-component work, because DESIGN.md already
forbids hardcoded colours and every panel composes from `--ink-rgb` and the `--bg-*` tokens.

### Compositing order

| z | Layer | Change |
|---|---|---|
| 0 | `NSVisualEffectView` | untouched; window stays transparent |
| 1 | `body::before` — the art | **new.** `fixed`, `cover`, anchored `right bottom` |
| 2 | `body::after` — the scrim | **new.** `background: var(--special-veil); opacity: var(--special-scrim)` |
| 3 | `#layout` | unchanged; already transparent — this is the seam |
| 4 | Panels / sidebar / tabbar | composite at `--surface-alpha`, as they do over the desktop today |
| 5 | xterm canvas | unchanged; `allowTransparency: true` already set |

`background-attachment: fixed` rather than scrolling, so the composition never drifts as
panels move.

### Surface alpha takeover

**A Special Theme must force `--surface-alpha` below 1.** With the *Solid* window background
selected, every panel is opaque and the art is invisible outside the terminal viewport.
Selecting a Special Theme therefore overrides the background mode, the same way `true_dark`
already forces alpha to 1 today. The user's previous background choice is preserved in
config and restored when they leave the Special Theme.

Shipped value: `--surface-alpha: 0.72` (the existing `vibrant` value).

---

## 6. Persistence

`crates/app/src/settings.rs`:

- `ThemeMode` gains a `Special` variant (serde `"special"`).
- `WindowConfig` gains `special_theme: Option<String>` and `special_scrim: Option<f32>`.

`crates/app/src/theme.rs` is unchanged — it already collapses to Dark/Light, and Special
follows its `base`.

Invalid or unknown `special_theme` with `theme: "special"` → frontend falls back to `dark`.

---

## 7. Settings UI

Settings → Appearance. The four existing theme radios stay exactly where they are. Below
them, a new **SPECIAL THEMES** group:

- A tile gallery — one tile per theme, each showing a real thumbnail of its own art at its
  own scrim, with the theme name. Text labels alone would be blind selection.
- Selecting a tile deselects the theme radios and vice versa; they are one exclusive choice
  expressed in two controls.
- A scrim slider appears below the gallery only when a tile is active, labelled with the
  veil colour and the live value.

Wires into the existing `previewAppearance()` → `onPreview` path, so live preview without
saving works for free. Tiles are added to the settings search index.

Per DESIGN.md: sharp corners (`border-radius: 0`), `attachTooltip` not `element.title`,
inline SVG not emoji, English copy.

---

## 8. Assets

Five `.webp` copied from `themes/` into `ui/assets/themes/`. The `.jpg`/`.png`/`.gif`
originals are discarded — `themes/` is currently untracked scratch.

Kimetsu and One Piece are 3840×2160 for no reason. **Re-encode all five to 1920×1080**,
which brings the set from 277 KB to under 150 KB with no visible loss at any window size we
render at.

| File | Current | After |
|---|---|---|
| `jjk.webp` | 14 KB (1600×900) | 14 KB |
| `haikyuu.webp` | 21 KB | 21 KB |
| `bunny.webp` | 53 KB | 53 KB |
| `onepiece.webp` | 56 KB (3840×2160) | ~22 KB |
| `kimetsu.webp` | 133 KB (3840×2160) | ~38 KB |

---

## 9. Out of scope

Each is a clean addition later; none block shipping five themes.

- **User-supplied wallpapers.** Needs `assetProtocol` enabled and scoped in Tauri, a file
  picker, and scrim auto-calibration for art we have never measured. Add when asked twice.
- **Animated art.** `bunny-sempai-bg.gif` (257 KB) is dropped for its static `.webp`. A
  looping GIF repainting behind a compositing terminal is a battery decision.
- **Per-tab or per-workspace themes.** One theme, whole window. Discord does not do it either.
- **Blur on the art.** Flat-vector sources have no texture to soften; `backdrop-filter` here
  costs GPU and changes nothing visible.
- **Full 16-colour ANSI ramps.** Launch overrides foreground, cursor and selection only; the
  dark ANSI defaults already read correctly against all five composited grounds. Ramps are
  additive per theme afterwards.

---

## 10. Risks

**Vibrancy bleed (DESIGN.md line 51).** Anything hosted directly in `#layout` that fades
opacity or translates flashes the layer behind it mid-animation. Today that flash shows the
desktop; with a Special Theme on it shows the art. Same existing bug, same documented fix
(occlude the grid cell, or keep the panel opaque during motion). This feature makes the
hazard *more visible*, not worse — and no new mitigation is in scope.

**Light-mode input reset.** `body.theme-light` forces `#fff` on native inputs and
out-specifies component styles. The `bunny` theme sets `theme-light`, so its scrim slider
and any input rendered over the art inherits that. Needs the documented
`appearance: none` + scoped override.

**Bundle growth.** 150 KB of art after re-encoding. Acceptable; re-check if the set grows
past ~10 themes, at which point lazy-loading per theme becomes worthwhile.

---

## 11. Testing

- **Unit (`ui/src/theme/special.test.ts`)** — every registry entry has all required fields;
  every `art` URL resolves; `isSpecialThemeId` rejects unknown strings; scrim clamping
  respects `[0, 0.92]` and the ±0.20 bound.
- **Unit** — `termTheme()` returns the special theme's `term` when one is active, and falls
  back to the dark/light pair when not.
- **Unit** — an unknown `special_theme` in settings resolves to `dark`, not a crash.
- **Rust** — `ThemeMode::Special` round-trips through serde; `WindowConfig` deserialises when
  the two new fields are absent (existing configs must not break).
- **Manual, in-app** — each of the five applied end-to-end: art visible behind sidebar,
  tabbar and terminal; scrim slider live; setting persists across restart; switching back to
  a standard theme restores the previous background mode.
