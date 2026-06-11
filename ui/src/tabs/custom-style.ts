import type { TabStylesConfig } from "../api";

/// Maps shape variants to CSS `border-radius` values.
const SHAPE_RADII: Record<string, string> = {
  rectangle: "0px",
  rounded: "6px",
  lofted: "12px",
  pill: "20px",
};

/// Maps height variants to CSS `height` values.
const HEIGHT_VALUES: Record<string, string> = {
  compact: "26px",
  normal: "30px",
  spacious: "36px",
};

/// Maps gap variants to CSS `gap` values (horizontal layout).
const GAP_VALUES: Record<string, string> = {
  tight: "2px",
  normal: "4px",
  loose: "8px",
};

/// Maps group-header shape variants to CSS `border-radius` values.
/// "match" is resolved against SHAPE_RADII (the tab shape) instead.
/// Pill uses 999px so the chip is a true capsule at any height.
const GROUP_SHAPE_RADII: Record<string, string> = {
  rectangle: "0px",
  rounded: "6px",
  lofted: "12px",
  pill: "999px",
};

/// Preset tab skin (classic/forge/glass/crt). Flips the matching
/// `body.tab-style-<preset>` class; "classic" carries no class so the
/// shipped look is the no-class baseline. Any unknown value (notably
/// the UI-only "custom" radio) also clears every preset class — the
/// custom layer paints on the classic baseline. Lives here (not
/// main.ts) so the settings panel can live-preview preset changes.
export function applyPresetTabStyle(style: string | undefined): void {
  for (const s of ["forge", "glass", "crt"] as const) {
    document.body.classList.toggle(`tab-style-${s}`, style === s);
  }
}

/// Toggle the vertical-tabbar layout. CSS does the heavy lifting via
/// `body.tabbar-left`; the rest of the app stays layout-agnostic.
/// Exported so the settings panel can live-preview position changes.
export function applyTabbarPosition(pos: "top" | "left" | undefined): void {
  document.body.classList.toggle("tabbar-left", pos === "left");
}

/// Apply custom tab style CSS variables from the given config.
/// If the config is disabled or absent, remove the body class and
/// all custom properties — the tabbar falls back to the classic
/// preset or whatever preset radio is selected.
///
/// When enabled, removes preset body classes (forge/glass/crt) so
/// the custom CSS sits cleanly on top of the classic baseline.
///
/// Safe to call repeatedly (idempotent, no-ops if nothing changed).
export function applyCustomTabStyle(config: TabStylesConfig | undefined | null): void {
  const root = document.documentElement;
  const body = document.body;

  if (!config?.enabled) {
    body.classList.remove("tab-style-custom");
    body.removeAttribute("data-tab-bg");
    body.removeAttribute("data-tab-indicator");
    body.removeAttribute("data-tab-group-bg");
    root.style.removeProperty("--tab-custom-radius");
    root.style.removeProperty("--tab-custom-bg");
    root.style.removeProperty("--tab-custom-gradient-start");
    root.style.removeProperty("--tab-custom-gradient-end");
    root.style.removeProperty("--tab-custom-h");
    root.style.removeProperty("--tab-custom-gap");
    root.style.removeProperty("--tab-custom-group-radius");
    return;
  }

  // Remove preset classes so custom.css sits on the classic baseline
  // without conflicting with forge/glass/crt selectors.
  body.classList.remove("tab-style-forge", "tab-style-glass", "tab-style-crt");
  body.classList.add("tab-style-custom");

  // Shape → border-radius
  root.style.setProperty("--tab-custom-radius", SHAPE_RADII[config.shape] ?? "0px");

  // Background mode → CSS var + data attribute
  body.setAttribute("data-tab-bg", config.bg_mode);
  if (config.bg_mode === "solid") {
    root.style.setProperty("--tab-custom-bg", "var(--tab-bg-rest)");
  } else if (config.bg_mode === "translucent" || config.bg_mode === "off") {
    root.style.removeProperty("--tab-custom-bg");
  } else if (config.bg_mode === "gradient") {
    root.style.removeProperty("--tab-custom-bg");
    if (config.bg_gradient) {
      root.style.setProperty("--tab-custom-gradient-start", config.bg_gradient[0]);
      root.style.setProperty("--tab-custom-gradient-end", config.bg_gradient[1]);
    } else {
      root.style.removeProperty("--tab-custom-gradient-start");
      root.style.removeProperty("--tab-custom-gradient-end");
    }
  }

  // Active indicator → data attribute on body
  body.setAttribute("data-tab-indicator", config.indicator);

  // Height
  root.style.setProperty("--tab-custom-h", HEIGHT_VALUES[config.height] ?? "30px");

  // Gap
  root.style.setProperty("--tab-custom-gap", GAP_VALUES[config.gap] ?? "4px");

  // Group header chip — shape "match" follows the tab radius.
  const groupShape = config.group_shape ?? "match";
  root.style.setProperty(
    "--tab-custom-group-radius",
    groupShape === "match"
      ? (SHAPE_RADII[config.shape] ?? "0px")
      : (GROUP_SHAPE_RADII[groupShape] ?? "10px"),
  );
  body.setAttribute("data-tab-group-bg", config.group_bg ?? "tinted");
}
