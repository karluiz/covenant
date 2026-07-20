import { describe, expect, it } from "vitest";
import { isBulkyPaste, pasteToken } from "./view";

describe("acp bulky paste", () => {
  it("holds out walls of text, leaves phrases inline", () => {
    expect(isBulkyPaste("fix the tests")).toBe(false);
    expect(isBulkyPaste("a\n".repeat(10))).toBe(true);
    expect(isBulkyPaste("x".repeat(600))).toBe(true);
  });

  it("round-trips a token back to its content on send", () => {
    const p = { id: 1, text: "l1\nl2\nl3" };
    const raw = `check this ${pasteToken(p)} ok`;
    expect(raw.split(pasteToken(p)).join(p.text)).toBe("check this l1\nl2\nl3 ok");
  });
});
