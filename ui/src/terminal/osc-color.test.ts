import { describe, expect, it } from "vitest";
import { oscColorReply, xColor } from "./osc-color";

describe("xColor", () => {
  it("expands #rrggbb to 16-bit X11 form", () => {
    expect(xColor("#ffffff")).toBe("rgb:ffff/ffff/ffff");
    expect(xColor("#0b0d10")).toBe("rgb:0b0b/0d0d/1010");
  });

  it("expands #rgb shorthand", () => {
    expect(xColor("#fff")).toBe("rgb:ffff/ffff/ffff");
  });

  it("rejects non-hex colors (rgba stays unanswered, not mis-answered)", () => {
    expect(xColor("rgba(0, 0, 0, 0)")).toBe(null);
    expect(oscColorReply(11, "rgba(0, 0, 0, 0)")).toBe(null);
  });

  it("builds an ST-terminated reply", () => {
    expect(oscColorReply(11, "#ffffff")).toBe("\x1b]11;rgb:ffff/ffff/ffff\x1b\\");
    expect(oscColorReply(10, "#24292f")).toBe("\x1b]10;rgb:2424/2929/2f2f\x1b\\");
  });
});
