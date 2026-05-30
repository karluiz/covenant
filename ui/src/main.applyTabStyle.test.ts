import { describe, it, expect, beforeEach } from "vitest";

// Pure DOM helper mirrored from main.ts. Keep in sync with applyTabStyle().
function applyTabStyle(style: string | undefined): void {
  const styles = ["forge", "glass", "crt"] as const;
  for (const s of styles) {
    document.body.classList.toggle(`tab-style-${s}`, style === s);
  }
}

describe("applyTabStyle", () => {
  beforeEach(() => { document.body.className = ""; });

  it("adds the matching class and no other", () => {
    applyTabStyle("glass");
    expect(document.body.classList.contains("tab-style-glass")).toBe(true);
    expect(document.body.classList.contains("tab-style-forge")).toBe(false);
    expect(document.body.classList.contains("tab-style-crt")).toBe(false);
  });

  it("classic / undefined carries no tab-style class", () => {
    applyTabStyle("forge");
    applyTabStyle("classic");
    expect(document.body.className).toBe("");
    applyTabStyle(undefined);
    expect(document.body.className).toBe("");
  });

  it("switching themes removes the previous class", () => {
    applyTabStyle("crt");
    applyTabStyle("forge");
    expect(document.body.classList.contains("tab-style-crt")).toBe(false);
    expect(document.body.classList.contains("tab-style-forge")).toBe(true);
  });
});
