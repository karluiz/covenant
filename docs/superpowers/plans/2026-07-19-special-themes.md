# Special Themes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship five wallpaper-backed whole-window themes (Discord model) plus the theme registry every future Special Theme plugs into.

**Architecture:** Two fixed-position pseudo-elements on `<body>` paint the art and a veil behind the already-transparent `#layout`. A registry module (`ui/src/theme/special.ts`) owns the five theme definitions, the palette math that derives `--bg-*` tokens from each artwork's sampled ground colour, and the DOM applier. `main.ts` gains one branch in `applyTheme()`; Rust gains one enum variant and two optional fields.

**Tech Stack:** TypeScript (strict), Vite asset imports, Vitest + jsdom, xterm.js `ITheme`, Rust + serde.

**Spec:** `docs/superpowers/specs/2026-07-19-special-themes-design.md`

## Global Constraints

- Worktree `.covenant/worktrees/special-themes`, branch `feat/special-themes`. All work happens here.
- `npm test` runs from the repo ROOT, not `ui/`.
- TypeScript `strict: true`. No implicit `any`. No `as any` without a justifying comment.
- **DESIGN.md hard rules apply:** `border-radius: 0` on all new chrome (except 50% dots); ink alphas use slash syntax `rgb(var(--ink-rgb) / 0.08)` — the comma form is invalid CSS and silently drops; no hardcoded white/black alpha overlays; chrome glyphs are inline SVG (`Icons.*`), never emoji; `attachTooltip` never `element.title`; all UI copy in English.
- Conventional Commits (`feat:`, `fix:`, `chore:`).
- **Two separate `ThemeMode` type declarations exist and must stay in sync:** `ui/src/api.ts:1157` and `ui/src/theme/mode.ts:4`.

---

## File Structure

| File | Responsibility |
|---|---|
| `ui/assets/themes/*.webp` | **Create.** The five re-encoded artworks. |
| `ui/src/theme/special.ts` | **Create.** Registry, palette math, scrim clamping, DOM applier. The only file that knows a theme's colours. |
| `ui/src/theme/special.test.ts` | **Create.** Unit tests for the above. |
| `ui/src/theme/mode.ts` | **Modify.** `ThemeMode` gains `"special"`; `resolveTheme` gains an optional second arg. |
| `ui/src/api.ts:1157,1190-1194` | **Modify.** Mirror the `ThemeMode` union; add two `WindowConfig` fields. |
| `ui/src/styles.css` | **Modify.** The `body.theme-special` block — two pseudo-element layers. |
| `ui/src/main.ts:172-196,498-521,1233,1915-1919` | **Modify.** `applyTheme()` branch, boot pre-paint, preview/save wiring. |
| `ui/src/tabs/manager.ts:156-192` | **Modify.** `termTheme()` consults the active special theme. |
| `ui/src/settings/panel.ts` | **Modify.** Tile gallery + scrim slider + save payload. |
| `crates/app/src/settings.rs:815-854` | **Modify.** `ThemeMode::Special`, two `WindowConfig` fields. |

---

### Task 1: Assets + registry module

The foundation. Everything else consumes this.

**Files:**
- Create: `ui/assets/themes/{jjk,kimetsu,onepiece,haikyuu,bunny}.webp`
- Create: `ui/src/theme/special.ts`
- Test: `ui/src/theme/special.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type SpecialThemeId = "jjk" | "kimetsu" | "onepiece" | "haikyuu" | "bunny"`
  - `interface SpecialTermTheme { background, foreground, cursor, cursorAccent, selectionBackground: string }`
  - `interface SpecialTheme { id, name, art, base, ground, veil, scrim, accent, danger?, term }`
  - `const SPECIAL_THEMES: Record<SpecialThemeId, SpecialTheme>`
  - `const SPECIAL_THEME_LIST: readonly SpecialTheme[]`
  - `function isSpecialThemeId(v: unknown): v is SpecialThemeId`
  - `function clampScrim(id: SpecialThemeId, v: number): number`
  - `function compositeGround(t: SpecialTheme, scrim: number): [number, number, number]`
  - `function applySpecialTokens(body: HTMLElement, t: SpecialTheme, scrim: number): void`
  - `function clearSpecialTokens(body: HTMLElement): void`

- [ ] **Step 1: Re-encode the artwork**

`cwebp` is already installed at `/opt/homebrew/bin/cwebp`. Only downscale — never upscale. `jjk-bg.webp` is natively 1600×900 and re-encoding it at its own size is what keeps it small; passing `-resize 1920 0` would upscale it and *grow* the file from 15 KB to 19 KB.

```bash
cd /Users/carlosgallardoarenas/Sources/karlTerminal/.covenant/worktrees/special-themes
mkdir -p ui/assets/themes
SRC=/Users/carlosgallardoarenas/Sources/karlTerminal/themes

cwebp -quiet -q 82 "$SRC/jjk-bg.webp"                    -o ui/assets/themes/jjk.webp
cwebp -quiet -q 82 -resize 1920 0 "$SRC/kimetsu.webp"     -o ui/assets/themes/kimetsu.webp
cwebp -quiet -q 82 -resize 1920 0 "$SRC/onepiece-bg.webp" -o ui/assets/themes/onepiece.webp
cwebp -quiet -q 82 "$SRC/haikiu.webp"                     -o ui/assets/themes/haikyuu.webp
cwebp -quiet -q 82 "$SRC/bunny-sempai-bg.webp"            -o ui/assets/themes/bunny.webp

ls -l ui/assets/themes/
```

Expected: five files totalling ~113 KB — `jjk` 15,688 B, `bunny` 15,684 B, `onepiece` 19,944 B, `haikyuu` 22,224 B, `kimetsu` 42,642 B. If the total exceeds 130 KB, something re-encoded at the wrong size — re-check the `-resize` flags.

- [ ] **Step 2: Write the failing test**

Create `ui/src/theme/special.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import {
  SPECIAL_THEMES,
  SPECIAL_THEME_LIST,
  isSpecialThemeId,
  clampScrim,
  compositeGround,
  applySpecialTokens,
  clearSpecialTokens,
} from "./special";

describe("SPECIAL_THEMES registry", () => {
  it("exposes exactly five themes", () => {
    expect(SPECIAL_THEME_LIST).toHaveLength(5);
  });

  it("keys match each entry's own id", () => {
    for (const [key, theme] of Object.entries(SPECIAL_THEMES)) {
      expect(theme.id).toBe(key);
    }
  });

  it("every theme has a resolved art URL", () => {
    for (const t of SPECIAL_THEME_LIST) {
      expect(typeof t.art).toBe("string");
      expect(t.art.length).toBeGreaterThan(0);
    }
  });

  it("every ground and accent is a 6-digit hex", () => {
    for (const t of SPECIAL_THEME_LIST) {
      expect(t.ground).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(t.accent).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });

  it("keeps every terminal background fully transparent", () => {
    // Special themes must show the art through the xterm grid — including
    // `bunny`, which is light-based but must NOT reuse the opaque white
    // background of TERMINAL_THEME_LIGHT.
    for (const t of SPECIAL_THEME_LIST) {
      expect(t.term.background).toBe("rgba(0, 0, 0, 0)");
    }
  });

  it("bunny is the only light-based theme and uses a white veil", () => {
    expect(SPECIAL_THEMES.bunny.base).toBe("light");
    expect(SPECIAL_THEMES.bunny.veil).toBe("#ffffff");
    const dark = SPECIAL_THEME_LIST.filter((t) => t.base === "dark");
    expect(dark).toHaveLength(4);
    for (const t of dark) expect(t.veil).toBe("#000000");
  });
});

describe("isSpecialThemeId", () => {
  it("accepts every registry id", () => {
    for (const t of SPECIAL_THEME_LIST) expect(isSpecialThemeId(t.id)).toBe(true);
  });

  it("rejects unknown strings and non-strings", () => {
    expect(isSpecialThemeId("naruto")).toBe(false);
    expect(isSpecialThemeId("")).toBe(false);
    expect(isSpecialThemeId(null)).toBe(false);
    expect(isSpecialThemeId(undefined)).toBe(false);
    expect(isSpecialThemeId(7)).toBe(false);
  });
});

describe("clampScrim", () => {
  it("returns the default unchanged", () => {
    expect(clampScrim("jjk", 0.34)).toBeCloseTo(0.34, 5);
  });

  it("bounds to +/- 0.20 around the theme default", () => {
    // jjk default 0.34 -> [0.14, 0.54]
    expect(clampScrim("jjk", 0.0)).toBeCloseTo(0.14, 5);
    expect(clampScrim("jjk", 0.9)).toBeCloseTo(0.54, 5);
  });

  it("never exceeds the absolute 0.92 ceiling", () => {
    // onepiece default 0.68 -> +0.20 would be 0.88, under the ceiling
    expect(clampScrim("onepiece", 1)).toBeCloseTo(0.88, 5);
  });

  it("never goes below zero", () => {
    // haikyuu default 0.30 -> -0.20 = 0.10, still positive
    expect(clampScrim("haikyuu", -5)).toBeCloseTo(0.1, 5);
  });

  it("falls back to the default for NaN", () => {
    expect(clampScrim("kimetsu", Number.NaN)).toBeCloseTo(0.36, 5);
  });
});

describe("compositeGround", () => {
  it("composites each dark theme's ground against the black veil", () => {
    expect(compositeGround(SPECIAL_THEMES.jjk, 0.34)).toEqual([32, 24, 54]);
    expect(compositeGround(SPECIAL_THEMES.kimetsu, 0.36)).toEqual([22, 36, 42]);
    expect(compositeGround(SPECIAL_THEMES.haikyuu, 0.3)).toEqual([27, 36, 55]);
    expect(compositeGround(SPECIAL_THEMES.onepiece, 0.68)).toEqual([67, 27, 29]);
  });

  it("composites bunny against the white veil", () => {
    expect(compositeGround(SPECIAL_THEMES.bunny, 0.55)).toEqual([213, 212, 215]);
  });

  it("returns the raw ground at scrim 0", () => {
    expect(compositeGround(SPECIAL_THEMES.jjk, 0)).toEqual([49, 36, 82]);
  });
});

describe("applySpecialTokens / clearSpecialTokens", () => {
  let body: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = "";
    body = document.createElement("div");
    document.body.appendChild(body);
  });

  it("writes the art, veil and scrim as inline custom properties", () => {
    const t = SPECIAL_THEMES.jjk;
    applySpecialTokens(body, t, 0.34);
    expect(body.style.getPropertyValue("--special-art")).toBe(`url("${t.art}")`);
    expect(body.style.getPropertyValue("--special-veil")).toBe("#000000");
    expect(body.style.getPropertyValue("--special-scrim")).toBe("0.34");
  });

  it("writes the derived surface tokens from the composited ground", () => {
    applySpecialTokens(body, SPECIAL_THEMES.jjk, 0.34);
    // composited (32,24,54); --bg keeps --surface-alpha so vibrancy still applies
    expect(body.style.getPropertyValue("--bg")).toBe(
      "rgb(32 24 54 / var(--surface-alpha))",
    );
    // sidebar and overlay are always opaque per DESIGN.md
    expect(body.style.getPropertyValue("--sidebar-bg")).toBe("rgb(36 28 58)");
    expect(body.style.getPropertyValue("--bg-overlay")).toBe("rgb(24 16 46)");
  });

  it("forces surface-alpha below 1 so the art is never fully occluded", () => {
    applySpecialTokens(body, SPECIAL_THEMES.jjk, 0.34);
    expect(body.style.getPropertyValue("--surface-alpha")).toBe("0.72");
  });

  it("sets the accent from the theme", () => {
    applySpecialTokens(body, SPECIAL_THEMES.haikyuu, 0.3);
    expect(body.style.getPropertyValue("--accent")).toBe("#f0803a");
  });

  it("sets --danger only when the artwork supplies one", () => {
    applySpecialTokens(body, SPECIAL_THEMES.kimetsu, 0.36);
    expect(body.style.getPropertyValue("--danger")).toBe("#e0552f");

    applySpecialTokens(body, SPECIAL_THEMES.jjk, 0.34);
    expect(body.style.getPropertyValue("--danger")).toBe("");
  });

  it("clamps an out-of-range scrim before writing it", () => {
    applySpecialTokens(body, SPECIAL_THEMES.jjk, 0.99);
    expect(body.style.getPropertyValue("--special-scrim")).toBe("0.54");
  });

  it("clearSpecialTokens removes every property it set", () => {
    applySpecialTokens(body, SPECIAL_THEMES.jjk, 0.34);
    clearSpecialTokens(body);
    for (const prop of [
      "--special-art", "--special-veil", "--special-scrim", "--surface-alpha",
      "--bg", "--bg-panel", "--bg-tabbar", "--sidebar-bg", "--bg-overlay",
      "--border", "--accent", "--danger",
    ]) {
      expect(body.style.getPropertyValue(prop)).toBe("");
    }
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- ui/src/theme/special.test.ts`
Expected: FAIL — `Failed to resolve import "./special"`.

- [ ] **Step 4: Write the implementation**

Create `ui/src/theme/special.ts`:

```ts
/// Special Themes — wallpaper-backed whole-window identities.
///
/// Each entry bundles four things applied together and never separately:
/// the art, a per-theme calibrated scrim, a palette derived from the
/// artwork's own sampled ground colour, and matching xterm colours.
///
/// All five sources are flat-vector art: one solid ground across 58-88%
/// of the frame with the subject pushed into the right third. That is why
/// `background-position: right bottom` keeps the character out of the
/// terminal's dense left column, and why the scrim values can stay low.
///
/// Ground colours were sampled by median-cut quantisation of the source
/// files; scrim values were calibrated so the composited grounds land in a
/// 10.8-12.2:1 contrast band against each theme's terminal foreground.
/// See docs/superpowers/specs/2026-07-19-special-themes-design.md.

import jjkArt from "../../assets/themes/jjk.webp";
import kimetsuArt from "../../assets/themes/kimetsu.webp";
import onepieceArt from "../../assets/themes/onepiece.webp";
import haikyuuArt from "../../assets/themes/haikyuu.webp";
import bunnyArt from "../../assets/themes/bunny.webp";

export type SpecialThemeId =
  | "jjk"
  | "kimetsu"
  | "onepiece"
  | "haikyuu"
  | "bunny";

/// The subset of xterm's ITheme a Special Theme overrides. Declared
/// structurally rather than importing ITheme so this module stays free of
/// xterm imports and testable under plain jsdom.
export interface SpecialTermTheme {
  /// Always fully transparent — the art must read through the terminal
  /// grid. `bunny` is light-based but still transparent here, so it can
  /// NOT reuse TERMINAL_THEME_LIGHT (whose background is near-opaque).
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
}

export interface SpecialTheme {
  id: SpecialThemeId;
  /// Shown on the settings tile.
  name: string;
  /// Vite-resolved URL for the bundled .webp.
  art: string;
  /// Which base token set this theme extends. Drives the body class and
  /// the vibrancy material Rust is asked for.
  base: "dark" | "light";
  /// The artwork's flat ground colour, sampled from the source file. Every
  /// surface token derives from this.
  ground: string;
  /// Scrim colour — black darkens a dark ground, white lifts a light one.
  veil: string;
  /// Calibrated default. The user may adjust it by +/- 0.20 (clampScrim).
  scrim: number;
  accent: string;
  /// Only when the artwork supplies a natural danger colour (kimetsu's
  /// ember red). Otherwise the base token stands.
  danger?: string;
  term: SpecialTermTheme;
}

const TRANSPARENT = "rgba(0, 0, 0, 0)";
const BLACK_VEIL = "#000000";
const WHITE_VEIL = "#ffffff";

export const SPECIAL_THEMES: Record<SpecialThemeId, SpecialTheme> = {
  jjk: {
    id: "jjk",
    name: "Jujutsu Kaisen",
    art: jjkArt,
    base: "dark",
    ground: "#312452",
    veil: BLACK_VEIL,
    scrim: 0.34,
    accent: "#a78bfa",
    term: {
      background: TRANSPARENT,
      foreground: "#dcd9e8",
      cursor: "#a78bfa",
      cursorAccent: "#201836",
      selectionBackground: "#3d2f66",
    },
  },
  kimetsu: {
    id: "kimetsu",
    name: "Kimetsu no Yaiba",
    art: kimetsuArt,
    base: "dark",
    ground: "#223941",
    veil: BLACK_VEIL,
    scrim: 0.36,
    accent: "#45d6a6",
    /// The haori's ember red — the only artwork that supplies its own
    /// semantic danger colour.
    danger: "#e0552f",
    term: {
      background: TRANSPARENT,
      foreground: "#cfdcda",
      cursor: "#45d6a6",
      cursorAccent: "#16242a",
      selectionBackground: "#27484a",
    },
  },
  onepiece: {
    id: "onepiece",
    name: "One Piece",
    art: onepieceArt,
    base: "dark",
    ground: "#d0545c",
    veil: BLACK_VEIL,
    /// Roughly double the others: a 0.205-luminance ground needs it. The
    /// red composites to oxblood, a better terminal colour than the source.
    scrim: 0.68,
    accent: "#e8b84a",
    term: {
      background: TRANSPARENT,
      foreground: "#efd9d6",
      cursor: "#e8b84a",
      cursorAccent: "#431b1d",
      selectionBackground: "#6b2b2e",
    },
  },
  haikyuu: {
    id: "haikyuu",
    name: "Haikyuu!!",
    art: haikyuuArt,
    base: "dark",
    ground: "#27344f",
    veil: BLACK_VEIL,
    /// Lowest in the set — the navy ground is already dark and its soft
    /// vertical gradient runs darkest exactly where the tabbar sits.
    scrim: 0.3,
    accent: "#f0803a",
    term: {
      background: TRANSPARENT,
      foreground: "#d3d8e2",
      cursor: "#f0803a",
      cursorAccent: "#1b2437",
      selectionBackground: "#2f4166",
    },
  },
  bunny: {
    id: "bunny",
    name: "Bunny Senpai",
    /// The only light-based theme. Its 0.354-luminance grey ground would
    /// need ~0.78 alpha to reach terminal-dark, which erases the art
    /// entirely — so it takes a white veil and dark ink instead.
    art: bunnyArt,
    base: "light",
    ground: "#a1a0a5",
    veil: WHITE_VEIL,
    scrim: 0.55,
    accent: "#b85c79",
    term: {
      background: TRANSPARENT,
      foreground: "#191a1d",
      cursor: "#b85c79",
      cursorAccent: "#d5d4d7",
      selectionBackground: "#c4bcc0",
    },
  },
};

export const SPECIAL_THEME_LIST: readonly SpecialTheme[] =
  Object.values(SPECIAL_THEMES);

/// Validation boundary for a persisted theme id. `config.json` is
/// user-editable, so an unknown value must be rejected rather than
/// indexed into the registry.
///
/// Uses an own-property check, not `in`: `in` walks the prototype chain,
/// so "constructor" / "toString" / "__proto__" would pass and then resolve
/// to an Object.prototype member instead of a SpecialTheme.
export function isSpecialThemeId(v: unknown): v is SpecialThemeId {
  return (
    typeof v === "string" &&
    Object.prototype.hasOwnProperty.call(SPECIAL_THEMES, v)
  );
}

/// How far the user's slider may move from a theme's calibrated default.
const SCRIM_RANGE = 0.2;
/// Absolute ceiling — beyond this the art is gone whatever the theme.
const SCRIM_MAX = 0.92;

/// Bound a user-supplied scrim to the theme's usable window. Bounded
/// rather than free so the slider cannot reach an illegible terminal or a
/// fully-erased wallpaper. NaN falls back to the calibrated default.
export function clampScrim(id: SpecialThemeId, v: number): number {
  const base = SPECIAL_THEMES[id].scrim;
  if (!Number.isFinite(v)) return base;
  const lo = Math.max(0, base - SCRIM_RANGE);
  const hi = Math.min(SCRIM_MAX, base + SCRIM_RANGE);
  return Math.min(Math.max(v, lo), hi);
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

/// The artwork's ground after the veil is applied — the colour every
/// surface token derives from, so panel chrome reads as the same material
/// as the wallpaper behind it.
export function compositeGround(
  t: SpecialTheme,
  scrim: number,
): [number, number, number] {
  const g = hexToRgb(t.ground);
  const v = hexToRgb(t.veil);
  return [0, 1, 2].map((i) =>
    Math.round(g[i] * (1 - scrim) + v[i] * scrim),
  ) as [number, number, number];
}

function shade(
  rgb: [number, number, number],
  delta: number,
): [number, number, number] {
  return rgb.map((c) => Math.min(255, Math.max(0, c + delta))) as [
    number,
    number,
    number,
  ];
}

const rgbFn = (c: [number, number, number]): string =>
  `rgb(${c[0]} ${c[1]} ${c[2]})`;
const rgbAlpha = (c: [number, number, number]): string =>
  `rgb(${c[0]} ${c[1]} ${c[2]} / var(--surface-alpha))`;

/// Every custom property this module writes. clearSpecialTokens removes
/// exactly this list, so adding a property above means adding it here.
const OWNED_PROPS = [
  "--special-art",
  "--special-veil",
  "--special-scrim",
  "--surface-alpha",
  "--bg",
  "--bg-panel",
  "--bg-tabbar",
  "--sidebar-bg",
  "--bg-overlay",
  "--border",
  "--accent",
  "--danger",
] as const;

/// Translucency forced while a Special Theme is active. Without this a
/// user on `Solid` window background sees opaque panels and the art only
/// survives inside the terminal viewport.
const SPECIAL_SURFACE_ALPHA = "0.72";

/// Write a Special Theme's tokens as inline custom properties.
///
/// These MUST land on <body> rather than <html>: `body.theme-light` sets
/// `--surface-alpha: 1`, and a value inherited from :root would lose to
/// body's own class rule. An inline declaration on body itself outranks
/// every class selector on body, which is what we need for `bunny`.
export function applySpecialTokens(
  body: HTMLElement,
  t: SpecialTheme,
  scrim: number,
): void {
  const s = clampScrim(t.id, scrim);
  const base = compositeGround(t, s);

  const set = (k: string, v: string): void => body.style.setProperty(k, v);

  set("--special-art", `url("${t.art}")`);
  set("--special-veil", t.veil);
  set("--special-scrim", String(s));
  set("--surface-alpha", SPECIAL_SURFACE_ALPHA);

  set("--bg", rgbAlpha(base));
  set("--bg-panel", rgbAlpha(shade(base, 6)));
  set("--bg-tabbar", rgbAlpha(shade(base, -4)));
  // Rails and floating UI stay opaque — DESIGN.md hard rule 7.
  set("--sidebar-bg", rgbFn(shade(base, 4)));
  set("--bg-overlay", rgbFn(shade(base, -8)));
  set("--border", "rgb(var(--ink-rgb) / 0.12)");
  set("--accent", t.accent);
  if (t.danger) set("--danger", t.danger);
  else body.style.removeProperty("--danger");
}

export function clearSpecialTokens(body: HTMLElement): void {
  for (const p of OWNED_PROPS) body.style.removeProperty(p);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- ui/src/theme/special.test.ts`
Expected: PASS — 20 tests.

If `compositeGround` assertions fail by 1, check that `Math.round` (half-up) is used, not a truncation.

- [ ] **Step 6: Type-check**

Run: `npm run build`
Expected: no TypeScript errors. If `.webp` imports error with "Cannot find module", add `/// <reference types="vite/client" />` at the top of `ui/src/theme/special.ts` — Vite's client types declare the asset modules.

- [ ] **Step 7: Commit**

```bash
git add ui/assets/themes ui/src/theme/special.ts ui/src/theme/special.test.ts
git commit -m "feat(themes): special theme registry and artwork

Five flat-vector artworks re-encoded to 113 KB total, plus the registry
that derives each theme's surface tokens from its sampled ground colour.
Tokens land on <body> so they outrank body.theme-light's surface-alpha."
```

---

### Task 2: Rust persistence

Independent of the frontend — do it early so config round-trips exist before the UI writes them.

**Files:**
- Modify: `crates/app/src/settings.rs:815-854`
- Test: `crates/app/src/settings.rs` (inline `#[cfg(test)]` module)

**Interfaces:**
- Consumes: nothing.
- Produces: `ThemeMode::Special` (serde `"special"`); `WindowConfig.special_theme: Option<String>`; `WindowConfig.special_scrim: Option<f32>`.

- [ ] **Step 1: Write the failing test**

Append to the existing `#[cfg(test)] mod tests` block at the bottom of `crates/app/src/settings.rs` (if the file has no test module, create one at the end of the file with `use super::*;`):

```rust
#[test]
fn theme_mode_special_round_trips() {
    let json = serde_json::to_string(&ThemeMode::Special).unwrap();
    assert_eq!(json, "\"special\"");
    let back: ThemeMode = serde_json::from_str("\"special\"").unwrap();
    assert_eq!(back, ThemeMode::Special);
}

#[test]
fn window_config_deserialises_without_special_fields() {
    // Existing configs on disk predate these fields and must keep loading.
    let cfg: WindowConfig =
        serde_json::from_str(r#"{"background":"vibrant","theme":"dark"}"#).unwrap();
    assert_eq!(cfg.theme, ThemeMode::Dark);
    assert!(cfg.special_theme.is_none());
    assert!(cfg.special_scrim.is_none());
}

#[test]
fn window_config_round_trips_special_fields() {
    let cfg: WindowConfig = serde_json::from_str(
        r#"{"background":"vibrant","theme":"special",
             "special_theme":"jjk","special_scrim":0.34}"#,
    )
    .unwrap();
    assert_eq!(cfg.theme, ThemeMode::Special);
    assert_eq!(cfg.special_theme.as_deref(), Some("jjk"));
    assert_eq!(cfg.special_scrim, Some(0.34));
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p covenant-app settings:: 2>&1 | tail -20`

(If the package name differs, find it with `grep '^name' crates/app/Cargo.toml`.)

Expected: FAIL — `no variant named Special found for enum ThemeMode`.

- [ ] **Step 3: Write the implementation**

In `crates/app/src/settings.rs`, add the variant to `ThemeMode` (after `TrueDark`, line ~827):

```rust
    /// Force a neutral pure-black (OLED) chrome — opaque, no blue tint,
    /// vibrancy hidden. Resolves to the dark xterm palette.
    #[serde(rename = "true_dark")]
    TrueDark,
    /// A wallpaper-backed Special Theme. Which one lives in
    /// `WindowConfig::special_theme`; this variant only says that the
    /// frontend should consult it. Resolves to the theme's own base
    /// (dark or light) at the `set_window_theme` boundary.
    Special,
}
```

Then extend `WindowConfig` (line ~836):

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WindowConfig {
    #[serde(default)]
    pub background: WindowBackground,
    #[serde(default)]
    pub theme: ThemeMode,
    #[serde(default)]
    pub tab_style: TabStyle,
    /// Which Special Theme is active. Only meaningful when
    /// `theme == ThemeMode::Special`. Validated frontend-side — an
    /// unknown id falls back to the dark theme rather than erroring,
    /// because config.json is user-editable.
    #[serde(default)]
    pub special_theme: Option<String>,
    /// User-adjusted scrim. `None` means the theme's calibrated default.
    /// The frontend clamps to +/- 0.20 around that default.
    #[serde(default)]
    pub special_scrim: Option<f32>,
}

impl Default for WindowConfig {
    fn default() -> Self {
        Self {
            background: WindowBackground::default(),
            theme: ThemeMode::default(),
            tab_style: TabStyle::default(),
            special_theme: None,
            special_scrim: None,
        }
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p covenant-app settings:: 2>&1 | tail -20`
Expected: PASS.

If other code constructs `WindowConfig { .. }` literally, the compiler will flag missing fields — add `special_theme: None, special_scrim: None` at those sites. Find them with `grep -rn "WindowConfig {" crates/`.

- [ ] **Step 5: Check the whole workspace still builds**

Run: `cargo test --workspace 2>&1 | tail -20`
Expected: PASS. Per `docs/superpowers` notes, telegram tests can hang under a broad `cargo test` — if it stalls there, fall back to `cargo test -p covenant-app`.

- [ ] **Step 6: Commit**

```bash
git add crates/app/src/settings.rs
git commit -m "feat(themes): persist special theme selection and scrim

ThemeMode::Special plus two optional WindowConfig fields. Both default,
so configs written before this change keep deserialising."
```

---

### Task 3: The CSS layer

**Files:**
- Modify: `ui/src/styles.css` (insert after the `body.theme-true-dark` block, ~line 322)

**Interfaces:**
- Consumes: `--special-art`, `--special-veil`, `--special-scrim` (written by `applySpecialTokens` from Task 1).
- Produces: the `body.theme-special` visual contract.

- [ ] **Step 1: Add the block**

Insert immediately after the closing brace of `body.theme-true-dark { … }` (currently ends around line 322, just before the `#layout` rule):

```css
/* Special Themes — wallpaper-backed whole-window identities. The art and
   its veil are two fixed pseudo-elements behind the already-transparent
   #layout; every panel then composites over them at --surface-alpha,
   exactly as it composites over the desktop today.

   `position: fixed` is load-bearing, not cosmetic: <body> is a flex
   container, so an in-flow ::before/::after would become a flex ITEM and
   consume layout space. Fixed positioning takes them out of flow.

   All the colour tokens come from applySpecialTokens() as inline styles
   on <body> — inline beats body.theme-light's `--surface-alpha: 1`,
   which the light-based `bunny` theme would otherwise inherit. */
body.theme-special::before,
body.theme-special::after {
    content: "";
    position: fixed;
    inset: 0;
    pointer-events: none;
}

body.theme-special::before {
    z-index: -2;
    background-image: var(--special-art);
    background-size: cover;
    /* Every source artwork pushes its subject into the right third.
       Anchoring right keeps the character in the gutter beside the
       terminal's ragged-right output instead of behind the text. */
    background-position: right bottom;
    background-repeat: no-repeat;
}

body.theme-special::after {
    z-index: -1;
    background: var(--special-veil);
    opacity: var(--special-scrim);
}
```

- [ ] **Step 2: Verify no rule below re-opaques the surfaces**

Run: `grep -n "surface-alpha" ui/src/styles.css`
Expected: the existing declarations at `:root`, `body.theme-light*`, `body.bg-*`, `body.theme-true-dark`. None should mention `theme-special` — the takeover is inline-only by design. Confirm `body.theme-true-dark` and `body.theme-special` are never applied together (Task 4 enforces this).

- [ ] **Step 3: Commit**

```bash
git add ui/src/styles.css
git commit -m "feat(themes): art and veil layers for special themes

Two fixed pseudo-elements behind the transparent #layout. Fixed rather
than in-flow because body is a flex container."
```

---

### Task 4: Theme resolution and application

**Files:**
- Modify: `ui/src/theme/mode.ts:4,9-13`
- Modify: `ui/src/api.ts:1157,1190-1194`
- Modify: `ui/src/main.ts:172-196,498-521,1233`
- Test: `ui/src/theme/mode.test.ts` (extend the existing file)

**Interfaces:**
- Consumes: `SPECIAL_THEMES`, `isSpecialThemeId`, `applySpecialTokens`, `clearSpecialTokens` (Task 1).
- Produces:
  - `ThemeMode` union gains `"special"` (both declarations).
  - `resolveTheme(mode: ThemeMode, specialId?: string | null): ResolvedTheme`
  - `applyTheme(mode, tabs, specialId?, scrim?)` in `main.ts`
  - Module-level `activeSpecialTheme: SpecialTheme | null` exported from `main.ts` as `getActiveSpecialTheme()` for Task 5.

- [ ] **Step 1: Write the failing test**

Append to `ui/src/theme/mode.test.ts`:

```ts
describe("resolveTheme with special themes", () => {
  it("resolves special to the named theme's own base", () => {
    expect(resolveTheme("special", "jjk")).toBe("dark");
    expect(resolveTheme("special", "bunny")).toBe("light");
  });

  it("falls back to dark when the special id is unknown or missing", () => {
    expect(resolveTheme("special", "naruto")).toBe("dark");
    expect(resolveTheme("special", null)).toBe("dark");
    expect(resolveTheme("special", undefined)).toBe("dark");
  });

  it("ignores the special id for non-special modes", () => {
    expect(resolveTheme("light", "jjk")).toBe("light");
    expect(resolveTheme("dark", "bunny")).toBe("dark");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- ui/src/theme/mode.test.ts`
Expected: FAIL — TypeScript rejects `"special"` as a `ThemeMode`, and `resolveTheme` takes one argument.

- [ ] **Step 3: Update `ui/src/theme/mode.ts`**

Replace lines 1-13 with:

```ts
/// Theme axis — independent of `window_background`. `system` follows the
/// macOS appearance via prefers-color-scheme; the resolved value is what
/// we actually apply to the DOM and pass to the backend.
///
/// `special` is a wallpaper-backed Special Theme; which one is a separate
/// setting (`window.special_theme`), so resolving it needs that id.
import { SPECIAL_THEMES, isSpecialThemeId } from "./special";

export type ThemeMode = "dark" | "light" | "system" | "true_dark" | "special";
export type ResolvedTheme = "dark" | "light";

const LIGHT_QUERY = "(prefers-color-scheme: light)";

export function resolveTheme(
  mode: ThemeMode,
  specialId?: string | null,
): ResolvedTheme {
  if (mode === "special") {
    // An unknown id means a hand-edited config.json. Fall back rather
    // than render a broken theme.
    return isSpecialThemeId(specialId) ? SPECIAL_THEMES[specialId].base : "dark";
  }
  if (mode === "light") return "light";
  if (mode === "dark" || mode === "true_dark") return "dark";
  return window.matchMedia(LIGHT_QUERY).matches ? "light" : "dark";
}
```

Leave `claudeThemeFor` and `watchSystemTheme` unchanged.

- [ ] **Step 4: Update `ui/src/api.ts`**

Line 1157 — mirror the union:

```ts
export type ThemeMode = "dark" | "light" | "system" | "true_dark" | "special";
```

Lines 1190-1194 — extend `WindowConfig`:

```ts
export interface WindowConfig {
  background: WindowBackground;
  theme?: ThemeMode;
  tab_style?: TabStyle;
  /// Which Special Theme is active. Only meaningful when theme === "special".
  special_theme?: string | null;
  /// User-adjusted scrim; null/undefined means the theme's calibrated default.
  special_scrim?: number | null;
}
```

- [ ] **Step 5: Run the mode test to verify it passes**

Run: `npm test -- ui/src/theme/mode.test.ts`
Expected: PASS.

- [ ] **Step 6: Update `applyTheme` in `ui/src/main.ts`**

Add the import next to the existing theme import at line 51:

```ts
import { resolveTheme, watchSystemTheme, claudeThemeFor, type ThemeMode } from "./theme/mode";
import {
  SPECIAL_THEMES,
  isSpecialThemeId,
  applySpecialTokens,
  clearSpecialTokens,
  type SpecialTheme,
} from "./theme/special";
```

Replace lines 164-196 (the `unwatchSystem` / `activeThemeMode` declarations and the whole `applyTheme` function) with:

```ts
let unwatchSystem: (() => void) | null = null;
/// Latest applied theme mode, mirrored here so `runSpawn` can resolve the
/// Claude theme for a freshly-launched executor without re-reading settings.
let activeThemeMode: ThemeMode = "system";
/// The Special Theme currently painted, or null under the four standard
/// modes. Read by TabManager.termTheme() via getActiveSpecialTheme().
let activeSpecialTheme: SpecialTheme | null = null;

/// The Special Theme in effect, for consumers that need its colours
/// (currently only the xterm palette). Null under standard modes.
export function getActiveSpecialTheme(): SpecialTheme | null {
  return activeSpecialTheme;
}

/// Single source of truth for theme application. Resolves system mode,
/// flips the body class, calls the Rust effect swap, and reapplies the
/// xterm palette to every live terminal. Idempotent.
///
/// For `special`, the theme's own `base` drives the light/dark body class
/// and the vibrancy material, and its tokens are written inline on <body>
/// (which is what lets a light-based special theme keep translucency —
/// see applySpecialTokens).
async function applyTheme(
  mode: ThemeMode,
  tabs: { applyTerminalTheme: () => void },
  specialId?: string | null,
  scrim?: number | null,
): Promise<void> {
  activeThemeMode = mode;
  const body = document.body;

  const special =
    mode === "special" && isSpecialThemeId(specialId)
      ? SPECIAL_THEMES[specialId]
      : null;
  activeSpecialTheme = special;

  const resolved = resolveTheme(mode, specialId);
  body.classList.toggle("theme-light", resolved === "light");
  body.classList.toggle("theme-dark", resolved === "dark");
  // True Dark and Special are mutually exclusive: one forces opaque
  // pure-black chrome, the other needs translucency to show the art.
  body.classList.toggle("theme-true-dark", mode === "true_dark");
  body.classList.toggle("theme-special", special !== null);

  if (special) applySpecialTokens(body, special, scrim ?? special.scrim);
  else clearSpecialTokens(body);

  unwatchSystem?.();
  unwatchSystem = null;
  if (mode === "system") {
    unwatchSystem = watchSystemTheme((t) => {
      body.classList.toggle("theme-light", t === "light");
      body.classList.toggle("theme-dark", t === "dark");
      tabs.applyTerminalTheme();
      void setWindowTheme(t).catch(() => {});
    });
  }

  tabs.applyTerminalTheme();
  await setWindowTheme(resolved).catch(() => {});
}
```

- [ ] **Step 7: Update the boot pre-paint block**

Replace lines 516-520 of `ui/src/main.ts`:

```ts
  const initialThemeMode = (initialSettings?.window?.theme ?? "system") as ThemeMode;
  const initialSpecialId = initialSettings?.window?.special_theme ?? null;
  const initialScrim = initialSettings?.window?.special_scrim ?? null;
  const initialResolvedTheme = resolveTheme(initialThemeMode, initialSpecialId);
  document.body.classList.toggle("theme-light", initialResolvedTheme === "light");
  document.body.classList.toggle("theme-dark", initialResolvedTheme === "dark");
  document.body.classList.toggle("theme-true-dark", initialThemeMode === "true_dark");
  // Paint the art before first frame so the boot splash already wears the
  // theme — same reason the light/dark class is set this early.
  if (initialThemeMode === "special" && isSpecialThemeId(initialSpecialId)) {
    const t = SPECIAL_THEMES[initialSpecialId];
    document.body.classList.add("theme-special");
    applySpecialTokens(document.body, t, initialScrim ?? t.scrim);
  }
```

- [ ] **Step 8: Update the deferred apply at line 1233**

```ts
  // Initial theme apply now that the TabManager exists. Settings may have
  // been unreachable at the early boot block above — fall back to "system".
  void applyTheme(initialThemeMode, manager, initialSpecialId, initialScrim);
```

- [ ] **Step 9: Type-check and run the full suite**

Run: `npm run build && npm test`
Expected: build clean; all tests pass.

- [ ] **Step 10: Commit**

```bash
git add ui/src/theme/mode.ts ui/src/theme/mode.test.ts ui/src/api.ts ui/src/main.ts
git commit -m "feat(themes): resolve and apply special themes

resolveTheme takes the special id so a light-based theme resolves light.
Boot paints the art pre-first-frame so the splash already wears it."
```

---

### Task 5: xterm palette

**Files:**
- Modify: `ui/src/tabs/manager.ts:156-192`
- Test: `ui/src/tabs/term-theme.test.ts` (create)

**Interfaces:**
- Consumes: `getActiveSpecialTheme()` from `main.ts` (Task 4); `SpecialTermTheme` from `theme/special.ts`.
- Produces: `termTheme()` returns the special palette when one is active.

**Note on the import direction:** `manager.ts` importing from `main.ts` would be a cycle (`main.ts` imports `TabManager`). Instead, `main.ts` pushes the active theme into the manager module via a setter.

- [ ] **Step 1: Write the failing test**

Create `ui/src/tabs/term-theme.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { termTheme, setActiveSpecialTermTheme } from "./manager";
import { SPECIAL_THEMES } from "../theme/special";

describe("termTheme", () => {
  afterEach(() => {
    setActiveSpecialTermTheme(null);
    document.body.className = "";
  });

  it("returns the dark palette by default", () => {
    expect(termTheme().foreground).toBe("#d6d8db");
  });

  it("returns the light palette under theme-light", () => {
    document.body.classList.add("theme-light");
    expect(termTheme().foreground).toBe("#24292f");
  });

  it("prefers an active special palette over the dark default", () => {
    setActiveSpecialTermTheme(SPECIAL_THEMES.jjk.term);
    expect(termTheme().foreground).toBe("#dcd9e8");
    expect(termTheme().cursor).toBe("#a78bfa");
  });

  it("prefers an active special palette over the light default", () => {
    // bunny is light-based: theme-light IS set, but the opaque white
    // background of TERMINAL_THEME_LIGHT would hide the art.
    document.body.classList.add("theme-light");
    setActiveSpecialTermTheme(SPECIAL_THEMES.bunny.term);
    expect(termTheme().background).toBe("rgba(0, 0, 0, 0)");
    expect(termTheme().foreground).toBe("#191a1d");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- ui/src/tabs/term-theme.test.ts`
Expected: FAIL — `termTheme` and `setActiveSpecialTermTheme` are not exported.

- [ ] **Step 3: Update `ui/src/tabs/manager.ts`**

Add the type import near the other imports at the top of the file:

```ts
import type { SpecialTermTheme } from "../theme/special";
```

Replace lines 188-192 (the `termTheme` function) with:

```ts
/// The active Special Theme's palette, pushed in by main.ts's applyTheme.
/// A setter rather than an import because manager.ts importing main.ts
/// would close an import cycle (main.ts imports TabManager).
let activeSpecialTerm: SpecialTermTheme | null = null;

export function setActiveSpecialTermTheme(t: SpecialTermTheme | null): void {
  activeSpecialTerm = t;
}

export function termTheme():
  | typeof TERMINAL_THEME_DARK
  | typeof TERMINAL_THEME_LIGHT
  | SpecialTermTheme {
  // A Special Theme wins over both defaults, including under theme-light:
  // TERMINAL_THEME_LIGHT's background is near-opaque white, which would
  // hide the artwork behind the terminal grid.
  if (activeSpecialTerm) return activeSpecialTerm;
  return document.body.classList.contains("theme-light")
    ? TERMINAL_THEME_LIGHT
    : TERMINAL_THEME_DARK;
}
```

- [ ] **Step 4: Push the palette from `applyTheme`**

In `ui/src/main.ts`, add `setActiveSpecialTermTheme` to the existing `TabManager` import (find it with `grep -n 'from "./tabs/manager"' ui/src/main.ts`), then in `applyTheme` — immediately after the `if (special) applySpecialTokens(...) else clearSpecialTokens(...)` lines — add:

```ts
  setActiveSpecialTermTheme(special ? special.term : null);
```

This must run BEFORE `tabs.applyTerminalTheme()` further down, which it does.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- ui/src/tabs/term-theme.test.ts`
Expected: PASS — 4 tests.

If the test file fails to import `./manager` because the module runs side effects on import, move `termTheme`, `setActiveSpecialTermTheme` and the two palette constants into a new `ui/src/tabs/term-theme.ts`, re-export them from `manager.ts`, and point the test at the new module.

- [ ] **Step 6: Full suite + build**

Run: `npm run build && npm test`
Expected: both clean.

- [ ] **Step 7: Commit**

```bash
git add ui/src/tabs/manager.ts ui/src/tabs/term-theme.test.ts ui/src/main.ts
git commit -m "feat(themes): special theme xterm palettes

termTheme() prefers the active special palette over both defaults —
including under theme-light, whose opaque background would hide the art."
```

---

### Task 6: Settings UI

**Files:**
- Modify: `ui/src/settings/panel.ts` (~line 528 markup, ~1337 refs, ~1470 preview, ~2098 save payload, ~2008 search index, ~258 `onPreview` type)
- Modify: `ui/src/main.ts:1915-1919` (preview handler), `ui/src/main.ts:1921+` (saved handler)
- Modify: `ui/src/styles.css` (gallery styles, append after the special theme block from Task 3)

**Interfaces:**
- Consumes: `SPECIAL_THEME_LIST`, `SPECIAL_THEMES`, `clampScrim`, `isSpecialThemeId` (Task 1); `applyTheme` signature (Task 4).
- Produces: `onPreview` payload gains `specialTheme: string | null` and `specialScrim: number | null`.

- [ ] **Step 1: Add the gallery markup**

In `ui/src/settings/panel.ts`, immediately after the closing `</fieldset>` of the Theme radio group (currently ends at line 528, right before the `Window background` fieldset), insert:

```ts
          <fieldset class="settings-field settings-radio-group">
            <legend class="settings-label">Special themes</legend>
            <small class="settings-hint">
              Wallpaper-backed identities applied to the whole window. Selecting
              one replaces the theme above and takes over the window background.
            </small>
            <div class="special-theme-grid" id="special-theme-grid">
              ${SPECIAL_THEME_LIST.map(
                (t) => `
                <button type="button" class="special-tile" data-special-id="${t.id}"
                        aria-pressed="false">
                  <span class="special-tile-art" style="background-image:url('${t.art}')">
                    <span class="special-tile-veil"
                          style="background:${t.veil};opacity:${t.scrim}"></span>
                  </span>
                  <span class="special-tile-name">${t.name}</span>
                </button>`,
              ).join("")}
            </div>
            <label class="settings-field special-scrim-row" id="special-scrim-row" hidden>
              <span class="settings-label">
                Scrim <output id="special-scrim-value">0.00</output>
              </span>
              <input type="range" name="special_scrim" id="special-scrim"
                     min="0" max="0.92" step="0.01" />
              <small class="settings-hint">
                How much the veil covers the artwork. Bounded to keep text legible.
              </small>
            </label>
          </fieldset>
```

Add the import at the top of `panel.ts`:

```ts
import {
  SPECIAL_THEME_LIST,
  SPECIAL_THEMES,
  clampScrim,
  isSpecialThemeId,
} from "../theme/special";
```

- [ ] **Step 2: Add the gallery styles**

Append to `ui/src/styles.css`, after the `body.theme-special::after` rule from Task 3:

```css
/* Settings -> Appearance -> Special themes gallery. Tiles show the real
   artwork at the theme's own shipped scrim, so the choice is never blind. */
.special-theme-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: 10px;
    margin-top: 10px;
}

.special-tile {
    display: flex;
    flex-direction: column;
    gap: 7px;
    padding: 0 0 8px;
    background: transparent;
    border: 1px solid rgb(var(--ink-rgb) / 0.1);
    border-radius: 0;
    cursor: pointer;
    text-align: left;
    color: var(--fg-dim);
    font: inherit;
    font-size: 12px;
}

.special-tile:hover {
    border-color: rgb(var(--ink-rgb) / 0.22);
    color: var(--fg);
}

.special-tile:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
}

.special-tile[aria-pressed="true"] {
    border-color: var(--accent);
    color: var(--fg);
}

.special-tile-art {
    position: relative;
    display: block;
    aspect-ratio: 16 / 9;
    background-size: cover;
    background-position: right bottom;
}

.special-tile-veil {
    position: absolute;
    inset: 0;
    display: block;
}

.special-tile-name {
    padding: 0 8px;
}

.special-scrim-row {
    margin-top: 12px;
}

.special-scrim-row output {
    color: var(--accent);
    font-variant-numeric: tabular-nums;
}
```

- [ ] **Step 3: Wire selection, exclusivity and preview**

In `panel.ts`, after the `themeRadios` lookup (~line 1337), add:

```ts
    const specialTiles = form.querySelectorAll<HTMLButtonElement>(
      "button[data-special-id]",
    );
    const specialScrimRow = form.querySelector<HTMLElement>("#special-scrim-row")!;
    const specialScrim = form.querySelector<HTMLInputElement>("#special-scrim")!;
    const specialScrimValue = form.querySelector<HTMLOutputElement>(
      "#special-scrim-value",
    )!;
    /// Null when a standard theme mode is selected. Tiles and the four
    /// theme radios are one exclusive choice expressed as two controls.
    let selectedSpecial: string | null =
      this.current.window?.theme === "special" &&
      isSpecialThemeId(this.current.window?.special_theme)
        ? this.current.window.special_theme
        : null;

    const syncSpecialUi = (): void => {
      specialTiles.forEach((tile) => {
        const on = tile.dataset.specialId === selectedSpecial;
        tile.setAttribute("aria-pressed", String(on));
      });
      specialScrimRow.hidden = selectedSpecial === null;
      if (selectedSpecial && isSpecialThemeId(selectedSpecial)) {
        const t = SPECIAL_THEMES[selectedSpecial];
        specialScrim.min = String(Math.max(0, t.scrim - 0.2));
        specialScrim.max = String(Math.min(0.92, t.scrim + 0.2));
        specialScrimValue.textContent = Number(specialScrim.value).toFixed(2);
      }
      // A special theme owns the window background while it is active.
      windowBgRadios.forEach((r) => {
        r.disabled = selectedSpecial !== null;
      });
    };
```

Replace the `previewAppearance` block (lines 1476-1486) with:

```ts
    const previewAppearance = (): void => {
      this.onPreview?.({
        theme: selectedSpecial
          ? "special"
          : ((Array.from(themeRadios).find((r) => r.checked)?.value ??
              "system") as ThemeMode),
        background: (Array.from(windowBgRadios).find((r) => r.checked)?.value ??
          "vibrant") as WindowBackground,
        specialTheme: selectedSpecial,
        specialScrim: selectedSpecial ? Number(specialScrim.value) : null,
      });
    };

    [...themeRadios, ...windowBgRadios].forEach((r) =>
      r.addEventListener("change", () => {
        // Picking a standard theme clears the special selection.
        selectedSpecial = null;
        syncSpecialUi();
        previewAppearance();
      }),
    );

    specialTiles.forEach((tile) => {
      tile.addEventListener("click", () => {
        const id = tile.dataset.specialId ?? null;
        // Clicking the active tile deselects it, back to the radios.
        selectedSpecial = id === selectedSpecial ? null : id;
        if (selectedSpecial && isSpecialThemeId(selectedSpecial)) {
          const stored = this.current.window?.special_scrim;
          specialScrim.value = String(
            clampScrim(
              selectedSpecial,
              typeof stored === "number" ? stored : SPECIAL_THEMES[selectedSpecial].scrim,
            ),
          );
        }
        syncSpecialUi();
        previewAppearance();
      });
    });

    specialScrim.addEventListener("input", () => {
      specialScrimValue.textContent = Number(specialScrim.value).toFixed(2);
      previewAppearance();
    });

    // Seed the slider before the first sync so the row shows a real value.
    if (selectedSpecial && isSpecialThemeId(selectedSpecial)) {
      const stored = this.current.window?.special_scrim;
      specialScrim.value = String(
        clampScrim(
          selectedSpecial,
          typeof stored === "number" ? stored : SPECIAL_THEMES[selectedSpecial].scrim,
        ),
      );
    }
    syncSpecialUi();
```

- [ ] **Step 4: Update the `onPreview` type**

Replace lines 258-262 of `panel.ts`:

```ts
  /// Fired as the user toggles Theme / Window-background radios or picks a
  /// Special Theme tile, before saving, so chrome + xterm reflect the
  /// choice live. close() re-fires it with the persisted values to revert
  /// an unsaved preview.
  public onPreview:
    | ((p: {
        theme: ThemeMode;
        background: WindowBackground;
        specialTheme: string | null;
        specialScrim: number | null;
      }) => void)
    | null = null;
```

- [ ] **Step 5: Update the save payload**

Replace the `window:` block in the save payload (lines ~2098-2110):

```ts
        window: {
          background:
            (Array.from(windowBgRadios).find((r) => r.checked)
              ?.value as WindowBackground) || "vibrant",
          theme: selectedSpecial
            ? "special"
            : (Array.from(themeRadios).find((r) => r.checked)
                ?.value as ThemeMode) || "system",
          tab_style:
            // "custom" is UI-only (maps to experimental.tab_styles.enabled);
            // keep the last real preset so disabling custom restores it.
            selectedTabStyle() === "custom"
              ? (this.current!.window?.tab_style ?? "classic")
              : ((selectedTabStyle() as TabStyle) || "classic"),
          special_theme: selectedSpecial,
          special_scrim:
            selectedSpecial && isSpecialThemeId(selectedSpecial)
              ? clampScrim(selectedSpecial, Number(specialScrim.value))
              : null,
        },
```

- [ ] **Step 6: Extend the search index**

Replace the `sec-appearance` line (~2008):

```ts
      "sec-appearance": "theme dark light color font opacity accent sidebar folded rail collapsed zen icons hover special wallpaper background art anime jujutsu kaisen kimetsu demon slayer one piece haikyuu bunny senpai scrim",
```

- [ ] **Step 7: Update the main.ts handlers**

Replace lines 1915-1919 of `ui/src/main.ts`:

```ts
  settings.onPreview = ({ theme, background, specialTheme, specialScrim }) => {
    applyWindowBackground(background);
    void applyTheme(theme, manager, specialTheme, specialScrim);
  };
```

And in `settings.onSaved` (~line 1924), replace the `applyTheme` call:

```ts
    void applyTheme(
      (next.window?.theme ?? "system") as ThemeMode,
      manager,
      next.window?.special_theme ?? null,
      next.window?.special_scrim ?? null,
    );
```

- [ ] **Step 8: Find and fix any other onPreview caller**

Run: `grep -rn "onPreview" ui/src --include='*.ts'`

Every call site must now pass the two new fields. The panel's `close()` re-fires the preview to revert — update it to pass the persisted `special_theme` / `special_scrim` from `this.current.window`.

- [ ] **Step 9: Build and run the full suite**

Run: `npm run build && npm test`
Expected: both clean.

- [ ] **Step 10: Commit**

```bash
git add ui/src/settings/panel.ts ui/src/styles.css ui/src/main.ts
git commit -m "feat(themes): special theme gallery in Appearance settings

Tiles render the real artwork at each theme's shipped scrim so the choice
is never blind. Tiles and the theme radios are one exclusive selection;
an active special theme disables the window-background radios."
```

---

### Task 7: Manual verification

Automated tests cannot confirm the art actually paints behind the chrome. This task is a checklist, not code.

**Files:** none.

- [ ] **Step 1: Launch**

Run: `npm run tauri:dev`

If Vite HMR misses the Rust change, use the `respawn` skill for a clean restart.

- [ ] **Step 2: Walk each theme**

Open Settings → Appearance → Special themes. For each of the five tiles, confirm:

1. The artwork is visible behind the **sidebar**, the **tabbar** and the **terminal** — not just one of them.
2. The character sits in the right gutter, not behind the terminal text.
3. Terminal text is comfortably legible.
4. The accent colour appears on focus rings and active states.
5. The window-background radios are disabled while a tile is active.

- [ ] **Step 3: Check bunny specifically**

`bunny` is the light-based theme and the highest-risk case:

- The chrome is light, not dark.
- The terminal background is transparent — the art reads through the grid. (A white terminal block means `termTheme()` fell through to `TERMINAL_THEME_LIGHT`.)
- Native inputs in the settings panel are not forced to `#fff` by `body.theme-light`. If they are, apply the documented `appearance: none` + scoped override.

- [ ] **Step 4: Scrim slider**

Drag the slider for `onepiece` (widest range: 0.48-0.88). The veil should update live with no flicker and no terminal reflow. Confirm the bounds hold at both ends.

- [ ] **Step 5: Persistence**

Select `kimetsu`, adjust the scrim, Save, quit and relaunch. The theme and scrim must survive. Then inspect:

```bash
python3 -m json.tool ~/Library/Application\ Support/com.karluiz.covenant/config.json | grep -A6 '"window"'
```

Expected: `"theme": "special"`, `"special_theme": "kimetsu"`, and the adjusted `special_scrim`.

- [ ] **Step 6: Invalid-config fallback**

Quit the app. Hand-edit `config.json` to set `"special_theme": "naruto"` while leaving `"theme": "special"`. Relaunch.

Expected: the app opens in the dark theme with no artwork and no error. This is the `isSpecialThemeId` guard doing its job.

- [ ] **Step 7: Round-trip back to a standard theme**

Select `jjk`, save, then pick **True Dark** and save. The artwork must disappear completely and the chrome go pure black — confirming `clearSpecialTokens` removed every inline property.

- [ ] **Step 8: Record the outcome**

If anything fails, use the `superpowers:systematic-debugging` skill before patching. Once all steps pass, note the verification in the branch — the memory entry for this project should record LIVE-VERIFIED status.

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §1 What a Special Theme is | 1 (registry shape) |
| §2 Art-derived architecture | 1 (ground/veil/scrim), 3 (`right bottom` anchor) |
| §3 The five themes | 1 |
| §4 Data model + scrim clamping | 1 |
| §5 Application + compositing + surface-alpha takeover | 1 (`applySpecialTokens`), 3 (CSS), 4 (`applyTheme`) |
| §6 Persistence | 2 |
| §7 Settings UI | 6 |
| §8 Assets | 1 step 1 |
| §9 Out of scope | not implemented, by design |
| §10 Risks — light-mode input reset | 7 step 3 |
| §11 Testing | 1, 2, 4, 5 (unit); 7 (manual) |

No gaps.

**Deviations from the spec, deliberate:**
- The spec put `applySpecialTokens` conceptually in `main.ts`. It lives in `theme/special.ts` instead so it is testable without importing `main.ts`, which runs boot side effects on import.
- `termTheme()` reads a module-level setter rather than importing `main.ts`, which would close an import cycle.

**Type consistency:** `SpecialThemeId`, `SpecialTheme`, `SpecialTermTheme`, `SPECIAL_THEMES`, `SPECIAL_THEME_LIST`, `isSpecialThemeId`, `clampScrim`, `compositeGround`, `applySpecialTokens`, `clearSpecialTokens`, `setActiveSpecialTermTheme`, `getActiveSpecialTheme` are each defined once (Task 1 or 5) and referenced under the same name everywhere after. `applyTheme(mode, tabs, specialId?, scrim?)` is defined in Task 4 and called with that arity in Tasks 4, 5 and 6.
