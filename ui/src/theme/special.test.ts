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
