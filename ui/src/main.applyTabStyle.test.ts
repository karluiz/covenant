import { describe, it, expect, beforeEach } from "vitest";
import { applyPresetTabStyle } from "./tabs/custom-style";

describe("applyPresetTabStyle", () => {
  beforeEach(() => { document.body.className = ""; });

  it("adds the matching class and no other", () => {
    applyPresetTabStyle("glass");
    expect(document.body.classList.contains("tab-style-glass")).toBe(true);
    expect(document.body.classList.contains("tab-style-forge")).toBe(false);
    expect(document.body.classList.contains("tab-style-crt")).toBe(false);
  });

  it("classic / undefined carries no tab-style class", () => {
    applyPresetTabStyle("forge");
    applyPresetTabStyle("classic");
    expect(document.body.className).toBe("");
    applyPresetTabStyle(undefined);
    expect(document.body.className).toBe("");
  });

  it("switching themes removes the previous class", () => {
    applyPresetTabStyle("crt");
    applyPresetTabStyle("forge");
    expect(document.body.classList.contains("tab-style-crt")).toBe(false);
    expect(document.body.classList.contains("tab-style-forge")).toBe(true);
  });
});
