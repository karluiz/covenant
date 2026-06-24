import { describe, it, expect } from "vitest";
import { suffixSoulName } from "./marketplace_install";

const soul = (name: string) => `---\nname: ${name}\ncolor: "#fff"\n---\n\nbody`;

describe("suffixSoulName", () => {
  it("leaves the soul untouched when no name collision", () => {
    expect(suffixSoulName(soul("Scout"), new Set(["guardian"]))).toContain("name: Scout");
  });
  it("appends (community) on collision (case-insensitive)", () => {
    const out = suffixSoulName(soul("Scout"), new Set(["scout"]));
    expect(out).toContain("name: Scout (community)");
  });
  it("bumps a counter when the suffixed name also collides", () => {
    const out = suffixSoulName(soul("Scout"), new Set(["scout", "scout (community)"]));
    expect(out).toContain("name: Scout (community 2)");
  });
});
