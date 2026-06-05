import { describe, expect, it } from "vitest";
import { operatorChipHtml } from "./activity-view";

describe("operatorChipHtml", () => {
  it("renders the operator name in a chip span", () => {
    const html = operatorChipHtml("Pi");
    expect(html).toContain("tp-act-op");
    expect(html).toContain("Pi");
  });

  it("returns empty string for a null operator (graceful, pre-attribution)", () => {
    expect(operatorChipHtml(null)).toBe("");
  });

  it("returns empty string for an empty name", () => {
    expect(operatorChipHtml("")).toBe("");
  });

  it("escapes HTML in the operator name", () => {
    const html = operatorChipHtml('<img src=x onerror=alert(1)>');
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});
