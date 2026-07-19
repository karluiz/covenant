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
    setActiveSpecialTermTheme(SPECIAL_THEMES.jjk.term, SPECIAL_THEMES.jjk.base);
    expect(termTheme().foreground).toBe("#dcd9e8");
    expect(termTheme().cursor).toBe("#a78bfa");
  });

  it("prefers an active special palette over the light default", () => {
    // bunny is light-based: theme-light IS set, but the opaque white
    // background of TERMINAL_THEME_LIGHT would hide the art.
    document.body.classList.add("theme-light");
    setActiveSpecialTermTheme(SPECIAL_THEMES.bunny.term, SPECIAL_THEMES.bunny.base);
    expect(termTheme().background).toBe("rgba(0, 0, 0, 0)");
    expect(termTheme().foreground).toBe("#191a1d");
  });

  it("gives a light-based special theme the light ANSI 16", () => {
    // Regression: bunny/steinsgate carry no ANSI colours, so xterm's
    // dark-tuned defaults applied over a light ground — `ls` directory
    // names came out as near-invisible pale cyan.
    for (const id of ["bunny", "steinsgate"] as const) {
      const t = SPECIAL_THEMES[id];
      setActiveSpecialTermTheme(t.term, t.base);
      expect(termTheme().cyan).toBe("#1b7c83");
      expect(termTheme().blue).toBe("#0969da");
      // The theme's own overrides still win over the borrowed palette.
      expect(termTheme().foreground).toBe(t.term.foreground);
    }
  });

  it("leaves a dark-based special theme without ANSI overrides", () => {
    setActiveSpecialTermTheme(SPECIAL_THEMES.jjk.term, SPECIAL_THEMES.jjk.base);
    expect(termTheme().cyan).toBeUndefined();
  });
});
