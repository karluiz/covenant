import { describe, it, expect } from "vitest";
import { setFrontmatterScalar } from "./soul_frontmatter";

describe("setFrontmatterScalar", () => {
  const raw = `---\nname: Atlas\nvoice: terse\n---\n\n# Atlas\nbody\n`;
  it("replaces an existing key", () => {
    expect(setFrontmatterScalar(raw, "voice", "warm")).toContain("voice: warm");
  });
  it("inserts a missing key", () => {
    const out = setFrontmatterScalar(raw, "color", '"#fff"');
    expect(out).toContain('color: "#fff"');
    expect(out).toContain("# Atlas");
  });
  it("preserves the body", () => {
    expect(setFrontmatterScalar(raw, "voice", "formal")).toContain("# Atlas\nbody");
  });
});
