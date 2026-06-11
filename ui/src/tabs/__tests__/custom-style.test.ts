import { describe, it, expect, beforeEach } from "vitest";
import { applyCustomTabStyle, applyPresetTabStyle } from "../custom-style";
import type { TabStylesConfig } from "../../api";

// Live-preview semantics: the settings panel applies preset + custom on
// every knob change (preset first, custom second — same order as the
// saved-settings path in main.ts), and close() re-applies the persisted
// config to revert an unsaved preview. These tests pin that interplay.

const enabled = (over: Partial<TabStylesConfig> = {}): TabStylesConfig => ({
  enabled: true,
  shape: "pill",
  bg_mode: "solid",
  indicator: "stripe",
  height: "normal",
  gap: "normal",
  ...over,
});

beforeEach(() => {
  document.body.className = "";
  document.body.removeAttribute("data-tab-bg");
  document.body.removeAttribute("data-tab-indicator");
  document.documentElement.removeAttribute("style");
});

describe("applyCustomTabStyle", () => {
  it("sets the body class, data attributes, and CSS vars when enabled", () => {
    applyCustomTabStyle(enabled({ shape: "pill", bg_mode: "solid", height: "compact", gap: "loose" }));
    const root = document.documentElement;
    expect(document.body.classList.contains("tab-style-custom")).toBe(true);
    expect(document.body.getAttribute("data-tab-bg")).toBe("solid");
    expect(document.body.getAttribute("data-tab-indicator")).toBe("stripe");
    expect(root.style.getPropertyValue("--tab-custom-radius")).toBe("20px");
    expect(root.style.getPropertyValue("--tab-custom-h")).toBe("26px");
    expect(root.style.getPropertyValue("--tab-custom-gap")).toBe("8px");
  });

  it("strips preset classes when enabled (custom sits on the classic baseline)", () => {
    applyPresetTabStyle("glass");
    applyCustomTabStyle(enabled());
    expect(document.body.classList.contains("tab-style-glass")).toBe(false);
    expect(document.body.classList.contains("tab-style-custom")).toBe(true);
  });

  it("sets gradient vars only in gradient mode", () => {
    applyCustomTabStyle(enabled({ bg_mode: "gradient", bg_gradient: ["#112233", "#445566"] }));
    const root = document.documentElement;
    expect(document.body.getAttribute("data-tab-bg")).toBe("gradient");
    expect(root.style.getPropertyValue("--tab-custom-gradient-start")).toBe("#112233");
    expect(root.style.getPropertyValue("--tab-custom-gradient-end")).toBe("#445566");
  });

  it("disabled config removes the class, attributes, and vars", () => {
    applyCustomTabStyle(enabled());
    applyCustomTabStyle(enabled({ enabled: false }));
    expect(document.body.classList.contains("tab-style-custom")).toBe(false);
    expect(document.body.hasAttribute("data-tab-bg")).toBe(false);
    expect(document.body.hasAttribute("data-tab-indicator")).toBe(false);
    expect(document.documentElement.style.getPropertyValue("--tab-custom-radius")).toBe("");
  });
});

describe("group header customization", () => {
  it("group_shape 'match' follows the tab shape radius", () => {
    applyCustomTabStyle(enabled({ shape: "lofted", group_shape: "match" }));
    expect(document.documentElement.style.getPropertyValue("--tab-custom-group-radius")).toBe("12px");
  });

  it("explicit group_shape overrides the tab shape; pill is a full capsule", () => {
    applyCustomTabStyle(enabled({ shape: "rectangle", group_shape: "pill" }));
    expect(document.documentElement.style.getPropertyValue("--tab-custom-group-radius")).toBe("999px");
  });

  it("defaults to match + tinted when group fields are absent (old configs)", () => {
    applyCustomTabStyle(enabled({ shape: "rounded" }));
    expect(document.documentElement.style.getPropertyValue("--tab-custom-group-radius")).toBe("6px");
    expect(document.body.getAttribute("data-tab-group-bg")).toBe("tinted");
  });

  it("sets data-tab-group-bg and clears it on disable", () => {
    applyCustomTabStyle(enabled({ group_bg: "off" }));
    expect(document.body.getAttribute("data-tab-group-bg")).toBe("off");
    applyCustomTabStyle(null);
    expect(document.body.hasAttribute("data-tab-group-bg")).toBe(false);
    expect(document.documentElement.style.getPropertyValue("--tab-custom-group-radius")).toBe("");
  });
});

describe("live-preview revert sequence (preset first, custom second)", () => {
  it("restores a preset after a custom preview is reverted", () => {
    // User has glass saved, previews custom, then closes without saving:
    // close() re-applies preset + persisted (disabled) custom config.
    applyPresetTabStyle("glass");
    applyCustomTabStyle(enabled()); // preview strips glass
    expect(document.body.classList.contains("tab-style-glass")).toBe(false);

    applyPresetTabStyle("glass");
    applyCustomTabStyle(null);
    expect(document.body.classList.contains("tab-style-glass")).toBe(true);
    expect(document.body.classList.contains("tab-style-custom")).toBe(false);
  });

  it("keeps custom applied when the persisted config is enabled", () => {
    applyPresetTabStyle("classic");
    applyCustomTabStyle(enabled({ shape: "rounded" }));
    expect(document.body.classList.contains("tab-style-custom")).toBe(true);
    expect(document.documentElement.style.getPropertyValue("--tab-custom-radius")).toBe("6px");
  });
});
