import { describe, expect, it } from "vitest";
import { parseHeadings } from "./anchors";

describe("parseHeadings", () => {
  it("extracts heading text without hashes, skipping code fences", () => {
    const md = "# Title\n\n## Goal\ntext\n```\n# not a heading\n```\n### Deep One\n";
    expect(parseHeadings(md)).toEqual(["Title", "Goal", "Deep One"]);
  });
});
