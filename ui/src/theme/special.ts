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

/// Stable identifier for a Special Theme. Also the key under which the
/// theme is persisted in `config.json` and the `data-special-id` value on
/// its settings tile.
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

/// The registry. Adding a Special Theme means adding one entry here and
/// one .webp under ui/assets/themes/ — nothing else in the app changes.
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

/// Iteration order for the settings gallery. Derived from SPECIAL_THEMES
/// so the two can never drift.
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
///
/// Assumes `scrim` is already within the theme's usable range — callers
/// outside applySpecialTokens should pass it through clampScrim first, or
/// an out-of-range value yields components outside 0-255.
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
  "--tab-bg-active",
  "--bg-elevated",
  "--settings-btn-fill",
  "--settings-btn-fill-hover",
  "--op-card-fill",
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
  // The active tab and elevated/card surfaces are opaque in every built-in
  // theme (:root, body.theme-light, body.theme-true-dark all hardcode
  // solid hex here) — so these derive without --surface-alpha too, same as
  // sidebar-bg/bg-overlay above. Both lift toward the veil rather than away
  // from it: shade()'s positive delta always brightens (moves every
  // channel toward 255), which reads as "raised" for a dark ground *and*
  // for bunny's light ground alike, matching how body.theme-light's own
  // --bg-panel/--tab-bg-active/--bg-elevated are already brighter than
  // its --bg. --tab-bg-active sits just above --bg-panel (the selected
  // surface reads slightly more raised than plain panel chrome);
  // --bg-elevated goes further still, as the most-lifted card surface.
  set("--tab-bg-active", rgbFn(shade(base, 10)));
  set("--bg-elevated", rgbFn(shade(base, 14)));
  // body.theme-light hardcodes these three to #ffffff. Without an override
  // they stay pure white under `bunny` (the one light-based theme), which
  // reads as bright slabs punched through the artwork.
  set("--settings-btn-fill", rgbFn(shade(base, 10)));
  set("--settings-btn-fill-hover", rgbFn(shade(base, 16)));
  set("--op-card-fill", rgbFn(shade(base, 10)));
  set("--border", "rgb(var(--ink-rgb) / 0.12)");
  set("--accent", t.accent);
  if (t.danger) set("--danger", t.danger);
  else body.style.removeProperty("--danger");
}

export function clearSpecialTokens(body: HTMLElement): void {
  for (const p of OWNED_PROPS) body.style.removeProperty(p);
}
