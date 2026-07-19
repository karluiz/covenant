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

/// WCAG relative luminance / contrast, so the calibration the registry
/// claims in its comments is actually asserted rather than trusted.
function luminance(rgb: [number, number, number]): number {
  const [r, g, b] = rgb.map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [
    number,
    number,
    number,
  ];
}

function contrast(a: [number, number, number] | string, b: string): number {
  const la = luminance(typeof a === "string" ? hexToRgb(a) : a);
  const lb = luminance(hexToRgb(b));
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

describe("SPECIAL_THEMES registry", () => {
  it("exposes every registered theme", () => {
    expect(SPECIAL_THEME_LIST).toHaveLength(7);
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

  it("moves every ground away from its own terminal ink", () => {
    // The real invariant, and NOT "dark themes use a black veil, light
    // themes use white" — that correlation held for the first five and
    // `steinsgate` breaks it: a pure-white ground (1.000 luminance) needs
    // a BLACK veil to become a usable surface while still being a light
    // theme, because its ink is dark. What must always hold is that the
    // composited ground stays far from the foreground drawn on it.
    for (const t of SPECIAL_THEME_LIST) {
      const ratio = contrast(compositeGround(t, t.scrim), t.term.foreground);
      expect(
        ratio,
        `${t.id}: composited ground vs terminal foreground is ${ratio.toFixed(1)}:1`,
      ).toBeGreaterThan(7);
    }
  });

  it("keeps the shipped scrims in one calibrated band", () => {
    // Grounds span an order of magnitude in luminance (0.025 to 1.000).
    // Landing them all in a narrow contrast band is what shows the scrim
    // values were measured rather than guessed — a new theme falling
    // outside it has not been calibrated yet.
    const ratios = SPECIAL_THEME_LIST.map((t) =>
      contrast(compositeGround(t, t.scrim), t.term.foreground),
    );
    expect(Math.min(...ratios)).toBeGreaterThan(9);
    expect(Math.max(...ratios)).toBeLessThan(14);
  });

  it("has at least one theme per base, so both paths stay exercised", () => {
    const bases = new Set(SPECIAL_THEME_LIST.map((t) => t.base));
    expect([...bases].sort()).toEqual(["dark", "light"]);
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

  it("rejects inherited Object.prototype keys", () => {
    // `in` would accept all of these; the guard must use an own-property
    // check because it validates a user-editable config value.
    for (const key of [
      "constructor",
      "toString",
      "valueOf",
      "hasOwnProperty",
      "isPrototypeOf",
      "__proto__",
    ]) {
      expect(isSpecialThemeId(key)).toBe(false);
    }
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
    // active tab and elevated/card surfaces are also opaque, and lift
    // further above the composited base than --bg-panel does — the tab
    // chrome must read as the same raised material as the wallpaper, not
    // a stock slab.
    expect(body.style.getPropertyValue("--tab-bg-active")).toBe("rgb(42 34 64)");
    expect(body.style.getPropertyValue("--bg-elevated")).toBe("rgb(46 38 68)");
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
    // Derived from what was actually written rather than a hand-kept list:
    // a hardcoded enumeration silently stops covering any token added to
    // applySpecialTokens but forgotten in OWNED_PROPS, which is exactly the
    // leak this test exists to catch. kimetsu is used because it is the one
    // theme that also supplies --danger.
    applySpecialTokens(body, SPECIAL_THEMES.kimetsu, 0.36);
    const written = Array.from(body.style);
    expect(written).toContain("--danger");
    expect(written.length).toBeGreaterThan(10);

    clearSpecialTokens(body);
    for (const prop of written) {
      expect(body.style.getPropertyValue(prop)).toBe("");
    }
    expect(Array.from(body.style)).toHaveLength(0);
  });

  it("overrides the white fills body.theme-light hardcodes", () => {
    // Without these, `bunny` (the light-based theme) keeps #ffffff here and
    // the surfaces punch bright slabs through the artwork.
    applySpecialTokens(body, SPECIAL_THEMES.bunny, 0.55);
    // composited base (213, 212, 215)
    expect(body.style.getPropertyValue("--settings-btn-fill")).toBe("rgb(223 222 225)");
    expect(body.style.getPropertyValue("--settings-btn-fill-hover")).toBe("rgb(229 228 231)");
    expect(body.style.getPropertyValue("--op-card-fill")).toBe("rgb(223 222 225)");
  });
});
