import { describe, it, expect } from "vitest";
import { INDICATORS, buildIndicatorCss } from "./indicators";

describe("buildIndicatorCss", () => {
  it("returns empty string for no hidden ids", () => {
    expect(buildIndicatorCss([])).toBe("");
  });

  it("emits a display:none rule per hidden id using its selector", () => {
    const css = buildIndicatorCss(["beacon", "sb-git"]);
    expect(css).toContain("#titlebar-beacon{display:none!important}");
    expect(css).toContain(".status-git{display:none!important}");
    // an unselected indicator is absent
    expect(css).not.toContain("#titlebar-view-blocks");
  });

  it("ignores unknown ids", () => {
    expect(buildIndicatorCss(["does-not-exist"])).toBe("");
  });
});

describe("INDICATORS registry", () => {
  it("has unique ids", () => {
    const ids = INDICATORS.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
