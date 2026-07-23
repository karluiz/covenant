import { describe, it, expect } from "vitest";
import { zoomIntent } from "./zoom";

describe("zoomIntent", () => {
  it("returns null when the platform mod is not held", () => {
    expect(zoomIntent("=", false)).toBe(null);
    expect(zoomIntent("-", false)).toBe(null);
    expect(zoomIntent("0", false)).toBe(null);
  });

  it("maps + / = to zoom in (shifted and unshifted)", () => {
    expect(zoomIntent("=", true)).toBe("in");
    expect(zoomIntent("+", true)).toBe("in");
  });

  it("maps - to zoom out", () => {
    expect(zoomIntent("-", true)).toBe("out");
  });

  it("maps 0 to reset", () => {
    expect(zoomIntent("0", true)).toBe("reset");
  });

  it("ignores unrelated keys and shifted variants of - / 0", () => {
    expect(zoomIntent("a", true)).toBe(null);
    expect(zoomIntent("_", true)).toBe(null); // shift+-
    expect(zoomIntent(")", true)).toBe(null); // shift+0
  });
});
