# Covenant Design Guidelines

> How Covenant looks and moves, and the rules that keep it coherent.
> Source of truth for tokens is `ui/src/styles.css` (`:root` block). This doc explains the system; when the two disagree, the CSS wins — then fix this doc.

---

## Identity

Covenant is an AI-native terminal. The chrome should read as **instrument, not app**: flat, dark, quiet, monospaced where it touches the terminal, with color used almost exclusively to carry *meaning* (status, group identity, agent activity) — never decoration.

Principles, in priority order:

1. **The terminal is the content.** Chrome recedes. No gradients-for-taste, no shadows-for-depth-theater, no rounded-card aesthetic. Elevation is expressed by *surface tone*, not drop shadows.
2. **Semantic color only.** If a color doesn't mean something (group, status, accent-action), it's a neutral.
3. **One material per region.** A sidebar/rail is one continuous flat surface — no per-row gradients, no border-top seams between rows.
4. **Dense but legible.** Chrome typography lives at 10–12px. Density is a feature; compensate with letter-spacing and weight, not size.
5. **English-first copy.** All UI chrome text is English, regardless of locale.
6. **Branding:** the product is **Covenant** in all user-facing copy (the repo dir `karlTerminal` never leaks into UI).

---

## Surfaces & themes

The window itself is **transparent** — macOS vibrancy (NSVisualEffectView) paints behind it. Every chrome surface is a tint over that, controlled by `--surface-alpha`:

| Mode | Class on `<body>` | `--surface-alpha` |
|---|---|---|
| Vibrant (default) | `bg-vibrant` | 0.72 |
| Translucent | `bg-translucent` | 0.45 |
| Solid | `bg-solid` | 1 |

Three theme modes (toggled from `ui/src/theme/mode.ts`):

- **Dark (default)** — slightly blue-tinted near-black neutrals (`--bg: #0b0d10` @ alpha).
- **Light** — `body.theme-light`. Only *color* tokens flip; layout/spacing tokens are shared. The ink channel `--ink-rgb` flips `255 255 255` → `0 0 0` so every alpha-composed overlay (hovers, borders, dim text) inverts uniformly.
- **True Dark (OLED)** — `body.theme-true-dark`. Pure `#000000`, forces `--surface-alpha: 1` (no wallpaper bleed). **Elevated surfaces use neutral lifts** (`#0b0b0d`, `#0e0e0e`), never accent tints.

### Surface tokens

| Token | Role |
|---|---|
| `--bg` | Workspace base |
| `--bg-panel` | Panels within the workspace |
| `--bg-tabbar` | Tab strip |
| `--sidebar-bg` | Opaque rail/sidebar material (`#1a1c21` dark) — all left/right rails share it so they read as one material |
| `--bg-elevated` | Cards / elevated rows |
| `--bg-overlay` | **Always-opaque** floating UI: popovers, modals, toasts, drag ghosts. Vibrancy bleeding through floating UI over terminal text shreds legibility — anything that *hovers above* the workspace uses this, chrome that *is* the workspace does not |
| `--border` | Hairlines. 1px, always |

**Vibrancy gotcha:** `#layout` is transparent. Opacity fades or translates on panels hosted directly in `#layout` bleed the wallpaper through mid-animation. Either occlude the grid cell or keep the panel opaque during motion.

---

## Color

### Semantic tokens (dark values)

| Token | Dark | Meaning |
|---|---|---|
| `--accent` | `#7aa2f7` | Interactive emphasis, selection, links |
| `--ok` | `#9ece6a` | Success / exit 0 / synced |
| `--fail` | `#f7768e` | Failed command / error state |
| `--danger` | `#e85a5a` | Destructive actions |
| `--running` | `#e0af68` | In-flight / pending; also `--num` (numeric emphasis: token counts, metrics) |

Text hierarchy: `--text-primary` (`#f5f6f7`) → `--text-secondary`/`--fg-dim` (`#8b929b`) → `--text-tertiary` (`#5c626c`) → `--muted`. Three tiers max in any one view.

### Alpha composition, not literals

Hovers, rests, and hairlines compose from the ink channel so they survive theme flips:

```css
background: rgba(var(--ink-rgb), 0.04);   /* rest */
background: rgba(var(--ink-rgb), 0.08);   /* hover */
border-color: rgba(var(--ink-rgb), 0.14); /* active edge */
```

Never hardcode `rgba(255,255,255,…)` for these — it breaks in light theme.

### Group color

Every workspace group has one identity color (`--group-color`), set inline on the group's subtree. It is the **only** decorative color in the chrome and it appears as:

- a 2px left **spine** (`--rail-spine`) on group headers and active tabs,
- tinted fills/borders derived via `color-mix(in srgb, var(--group-color) 8–32%, transparent)` — never the raw color as a fill,
- text via `color-mix` toward `#fff`/`#000` for contrast.

New group-colored UI must derive through `color-mix` with a `var(--group-color, fallback)` so ungrouped contexts degrade to neutrals.

---

## Typography

Two families, strict division of labor:

| Stack | Token / literal | Used for |
|---|---|---|
| **Sansation** → SF Pro fallback | `--ui-font` (user-overridable in Settings; `main.ts` writes the override onto `:root`) | All chrome: settings, panels, modals, labels, buttons |
| `ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace` | literal stack | Anything terminal-adjacent: tab titles, paths, commands, versions, shortcuts, block metadata |
| User's terminal font | `--terminal-font` | xterm content only |

Sansation's wide, technical letterforms **are** the brand voice (see the `COVENANT` wordmark and settings headers). Don't introduce a third family.

### Scale (rail system)

| Token | Size | Use |
|---|---|---|
| `--fs-title` | 11.5px | Section titles — **uppercase + `letter-spacing: var(--ls-title)` (0.09em)** |
| `--fs-body` | 12px | Row labels, body |
| `--fs-meta` | 11px | Secondary metadata |
| `--fs-micro` | 10px | Badges, counts, kbd hints |

Rules:

- Section headers / group names / category labels are **UPPERCASE via CSS** (`text-transform: uppercase`), never by mutating the string. Uppercase always pairs with positive letter-spacing.
- Chrome text weight is 400–500; 700 is reserved for the wordmark and true emphasis.
- Larger sizes (13–20px) appear only in full-page surfaces (Settings body copy, onboarding, empty states).

---

## Layout & chrome

- App shell is a CSS grid: `38px` titlebar row / `1fr` workspace / `auto` status bar (`--statusbar-h`: 50px two-row, 26px single-row).
- **Tabs are square** (`--tab-radius: 0`), 30px tall, monospace, top-corners-only radius slot kept as a token in case a theme rounds them.
- Left tabbar expanded width `--tabbar-w-expanded: 232px`; right rail `--right-sidebar-w: 240px`.

### Rail design system (`.rail-*`)

Every right-rail panel (Blocks, Files, Beacon, Notes, Teammate, …) uses the shared rail chrome — tokens in `:root`, component classes at the end of `styles.css`:

| Token | Value |
|---|---|
| `--rail-header-h` / `--rail-controls-h` / `--rail-footer-h` | 40 / 36 / 30px |
| `--rail-pad-x` | 12px |
| `--rail-row-py` | 8px |
| `--rail-radius` | 6px |
| `--rail-spine` | 2px |

New panels **must** compose `.rail-*` classes, not re-invent header/footer/rows. (Gotcha: a panel's left divider belongs on the panel *host* element, not on `.rail-panel` — see Beacon.)

### Radii

6px (`--rail-radius`) is the default for cards, rows, and controls. 0 for tabs. Anything larger belongs to full-screen immersive surfaces only.

### Scrollbars

Globally hidden (WKWebView paints native scrollbars over styled ones). Scrollable regions reveal a 6px thumb (`rgba(var(--ink-rgb), 0.22)`) on hover/focus-within by opting into the reveal list at the top of `styles.css`. Never re-enable scrollbars ad hoc.

---

## Motion

Motion is functional: confirm a state change, preserve spatial continuity. Nothing idles, nothing bounces for fun.

| Kind | Recipe |
|---|---|
| Color/hover states | `0.12s ease-out` on `background`, `color`, `border-color` |
| Layout (widths, folds, reveals) | `0.3s cubic-bezier(0.4, 0, 0.2, 1)` — the house ease |
| Snappy exits/entries | `cubic-bezier(0.2, 0.8, 0.2, 1)` |
| Playful pop (rare — badges, dots) | `cubic-bezier(0.34, 1.56, 0.64, 1)` |

Rules:

- Animate `transform`/`opacity` (compositor) for anything large — panel slides and folds are transform-based, not width-thrash (see rail slide / sidebar fold work).
- Respect the vibrancy-bleed rule above when fading anything on `#layout`.
- Sidebar/rail folds tween the grid track; instant snaps read as bugs, especially on True Dark.

---

## Components & interaction rules

- **Tooltips:** always `attachTooltip()` from `ui/src/tooltip/tooltip.ts`. **Never** `element.title` — native tooltips are banned.
- **Confirmations:** destructive actions use the in-app command-palette card style (`command-palette-overlay` / `command-palette-card`, see `workspaces/confirm-prompt.ts`), not native dialogs.
- **Drag & drop:** in-page HTML5 DnD does not fire in the webview — use pointer events + `elementFromPoint` (the tab strip is the reference implementation).
- **Fixed overlays:** clamp against `window.innerWidth/Height ÷ zoom`, not `documentElement.client*` (visual px under WKWebView zoom).
- **Buttons:** primary = `--accent` fill with dark text; everything else is ghost (transparent, ink-alpha hover). One primary per view.
- **Focus/keyboard:** every surface is keyboard-reachable; shortcuts render in monospace micro-size (`--fs-micro`) kbd chips.

---

## Hard rules (review blockers)

1. No native tooltips (`title=`), no native dialogs for in-flow confirms.
2. No new font families; chrome uses `--ui-font` or the mono stack.
3. No hardcoded white/black alpha overlays — compose from `--ink-rgb`.
4. No accent-tinted elevation on True Dark — neutral lifts only.
5. No per-row gradients or seams inside sidebars/rails — one flat material.
6. Uppercase via CSS only; copy stays English.
7. Floating UI is opaque (`--bg-overlay`); workspace chrome honors `--surface-alpha`.
8. No new heavyweight frontend deps for visuals (no component libraries, no CSS frameworks).
9. Semantic states always use `--ok`/`--fail`/`--running`/`--danger` — never ad-hoc greens and reds.
10. **Exit with `esc`, not an ×.** Full-screen / immersive surfaces (cockpit, miner, create surfaces, readers) close via a labelled `esc` affordance (`<kbd class="settings-esc">esc</kbd>`) **and** the Escape key — never a close ×. Rail/sidebar panels close via their rail toggle, so they carry no × either. Reserve × only where there is genuinely no rail toggle and no full-screen Escape context. **`esc` closes the whole surface back to the terminal** — never to an intermediate view (a fullscreen "board"/"cockpit" expanded from a rail closes the rail too, matching Settings / Changes / Tasker / Release log).
11. **Full-screen surfaces respect the chrome.** Anything `position: fixed` starts at `top: 38px` (below the titlebar / traffic lights) and carries a `border-top`; it never paints over the window controls. Working surfaces (cockpit) also inset the sidebar (`--tabbar-w`) and status bar (`--statusbar-h`); focused immersive moments (create, miner) may go full-bleed below the titlebar.
12. **No emoji in chrome — icons are inline SVG.** Every glyph comes from `ui/src/icons` (Lucide, `currentColor`) or `ui/src/icons/brands.ts`; never an emoji character in UI copy or labels. (Operator avatars users pick themselves are the one exception.) Plain text glyphs (`▲ ▽ ✓ ✗ ·`) are fine — the ban is on emoji.
13. **Compose ink alphas with the slash syntax: `rgb(var(--ink-rgb) / 0.08)`.** `--ink-rgb` is space-separated (`255 255 255`), so the legacy comma form `rgba(var(--ink-rgb), 0.08)` is INVALID CSS — the declaration silently drops at computed-value time and the style vanishes. (Historic occurrences of the comma form are being migrated; never add new ones.)
