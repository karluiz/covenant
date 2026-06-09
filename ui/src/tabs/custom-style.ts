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
    root.style.removeProperty("--tab-custom-radius");
    root.style.removeProperty("--tab-custom-bg");
    root.style.removeProperty("--tab-custom-gradient-start");
    root.style.removeProperty("--tab-custom-gradient-end");
    root.style.removeProperty("--tab-custom-h");
    root.style.removeProperty("--tab-custom-gap");
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
}
