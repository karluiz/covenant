import { describe, it, expect } from "vitest";
import { isSpecPath } from "./spec-link-menu";

describe("isSpecPath", () => {
  it("matches absolute paths under docs/specs ending in .md", () => {
    expect(isSpecPath("/Users/x/repo/docs/specs/3.17-foo.md")).toBe(true);
    expect(isSpecPath("/repo/docs/specs/sub/3.17-foo.md")).toBe(true);
  });
  it("matches relative paths", () => {
    expect(isSpecPath("docs/specs/3.17-foo.md")).toBe(true);
    expect(isSpecPath("./docs/specs/3.17-foo.md")).toBe(true);
  });
  it("rejects _template.md", () => {
    expect(isSpecPath("/repo/docs/specs/_template.md")).toBe(false);
  });
  it("rejects drafts/", () => {
    expect(isSpecPath("/repo/docs/specs/drafts/foo.md")).toBe(false);
    expect(isSpecPath("docs/specs/drafts/2026-01-foo.md")).toBe(false);
  });
  it("rejects non-md files", () => {
    expect(isSpecPath("/repo/docs/specs/3.17.txt")).toBe(false);
  });
  it("rejects paths outside docs/specs", () => {
    expect(isSpecPath("/repo/docs/plans/3.17.md")).toBe(false);
    expect(isSpecPath("/repo/README.md")).toBe(false);
  });
});
