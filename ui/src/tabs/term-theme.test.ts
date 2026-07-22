import { describe, it, expect, afterEach } from "vitest";
import {
  termTheme,
  setActiveSpecialTermTheme,
  decideTerminalSurface,
  wantsWebgl,
} from "./manager";
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

describe("decideTerminalSurface", () => {
  // The dark themes' background. The visible tint comes from #workspace,
  // an ancestor — xterm is meant to let it through.
  const INHERITS = "rgba(0, 0, 0, 0)";

  it("goes opaque and adopts the surface color when nothing shows through", () => {
    // true_dark: --surface-alpha pinned to 1, --bg #000000.
    const s = decideTerminalSurface(INHERITS, "rgb(0, 0, 0)");
    expect(s.allowTransparency).toBe(false);
    expect(s.background).toBe("rgb(0, 0, 0)");
  });

  it("adopts a non-black opaque surface rather than assuming black", () => {
    // dark + Solid window background: --bg is rgb(11 13 16) at alpha 1.
    // This is the case that would render pure black if we flipped the
    // flag without handing over the color.
    const s = decideTerminalSurface(INHERITS, "rgb(11, 13, 16)");
    expect(s.allowTransparency).toBe(false);
    expect(s.background).toBe("rgb(11, 13, 16)");
  });

  it("stays transparent while the surface is translucent", () => {
    // vibrant (0.72) and translucent (0.45) both must keep showing through.
    for (const painted of ["rgba(11, 13, 16, 0.72)", "rgba(11, 13, 16, 0.45)"]) {
      const s = decideTerminalSurface(INHERITS, painted);
      expect(s.allowTransparency).toBe(true);
      expect(s.background).toBe(INHERITS);
    }
  });

  it("never overrides a background the theme chose for itself", () => {
    // TERMINAL_THEME_LIGHT deliberately sits slightly brighter than --bg.
    // Even on a fully opaque surface it keeps its own color.
    const s = decideTerminalSurface("rgba(255, 255, 255, 0.97)", "rgb(250, 251, 252)");
    expect(s.background).toBe("rgba(255, 255, 255, 0.97)");
    expect(s.allowTransparency).toBe(true);
  });

  it("turns transparency off for a theme that is already fully opaque", () => {
    const s = decideTerminalSurface("rgb(20, 20, 20)", "rgba(11, 13, 16, 0.72)");
    expect(s.allowTransparency).toBe(false);
    expect(s.background).toBe("rgb(20, 20, 20)");
  });

  it("falls back to transparency when either color is unreadable", () => {
    // Hex, keywords and a missing host all land on the pre-existing
    // behavior rather than risking an opaque black terminal.
    expect(decideTerminalSurface("#000000", "rgb(0, 0, 0)").allowTransparency).toBe(true);
    expect(decideTerminalSurface(INHERITS, "transparent").allowTransparency).toBe(true);
    expect(decideTerminalSurface(INHERITS, null).allowTransparency).toBe(true);
    expect(decideTerminalSurface(undefined, "rgb(0, 0, 0)").allowTransparency).toBe(true);
  });
});

describe("wantsWebgl", () => {
  const CFG = {
    font_family: "monospace",
    font_size: 13,
    letter_spacing: 0,
    line_height: 1.2,
    ligatures: false,
    renderer: "dom" as const,
  };
  // termSurface() reads #workspace's painted background; jsdom returns
  // whatever inline style we set, which is enough to drive the decision.
  const surface = (css: string): void => {
    let el = document.getElementById("workspace");
    if (!el) {
      el = document.createElement("div");
      el.id = "workspace";
      document.body.appendChild(el);
    }
    el.style.backgroundColor = css;
  };

  afterEach(() => {
    document.getElementById("workspace")?.remove();
    document.body.className = "";
    setActiveSpecialTermTheme(null);
  });

  const OPTED_IN = { ...CFG, renderer: "webgl" as const };

  it("stays on DOM by default, even on an opaque surface", () => {
    // WebGL flickers the grid on every resize (opening a rail is enough),
    // so it is opt-in rather than the default.
    surface("rgb(0, 0, 0)"); // true_dark
    expect(wantsWebgl(CFG)).toBe(false);
    expect(wantsWebgl({ ...CFG, renderer: undefined as never })).toBe(false);
  });

  it("enables WebGL when opted in on an opaque surface", () => {
    surface("rgb(0, 0, 0)");
    expect(wantsWebgl(OPTED_IN)).toBe(true);
  });

  it("refuses WebGL on a translucent surface even when opted in", () => {
    // Under a Special Theme (alpha 0.72) the GPU atlas bakes NULL_COLOR
    // as opaque black behind underlined cells.
    surface("rgba(250, 251, 252, 0.72)");
    expect(wantsWebgl(OPTED_IN)).toBe(false);
  });

  it("refuses WebGL when ligatures need the canvas renderer", () => {
    surface("rgb(0, 0, 0)");
    expect(wantsWebgl({ ...OPTED_IN, ligatures: true })).toBe(false);
  });
});
