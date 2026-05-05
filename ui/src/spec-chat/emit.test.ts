import { describe, it, expect } from "vitest";
import { parseSpecMarkdown, validateSpecSections } from "./emit";

const FULL_SPEC = `
## Goal

Make foo work across all supported platforms.

## Out of scope

- bar
- baz

## Acceptance criteria

- [ ] foo works on macOS
- [ ] foo works on Linux

## File boundaries

- **Create**: \`src/foo.rs\` (≤ 100 lines)
- **DO NOT touch**: \`src/bar.rs\`

## Complexity

small

## Open questions

- Should foo support Windows?
`.trimStart();

// 1. Parse a fully valid spec → all 6 sections present with non-empty trimmed values.
describe("parseSpecMarkdown", () => {
  it("parses a fully valid spec — all 6 sections present", () => {
    const sections = parseSpecMarkdown(FULL_SPEC);
    expect(sections.get("Goal")).toBe("Make foo work across all supported platforms.");
    expect(sections.get("Out of scope")).toBe("- bar\n- baz");
    expect(sections.get("Acceptance criteria")).toBe(
      "- [ ] foo works on macOS\n- [ ] foo works on Linux",
    );
    expect(sections.has("File boundaries")).toBe(true);
    expect(sections.get("Complexity")).toBe("small");
    expect(sections.has("Open questions")).toBe(true);
    expect(validateSpecSections(sections)).toEqual([]);
  });

  // 2. Parse a spec missing ## File boundaries → validateSpecSections returns ["File boundaries"].
  it("detects missing File boundaries section", () => {
    const md = FULL_SPEC.replace(/^## File boundaries[\s\S]*?(?=^##)/m, "");
    const sections = parseSpecMarkdown(md);
    const missing = validateSpecSections(sections);
    expect(missing).toEqual(["File boundaries"]);
  });

  // 3. Parse a spec where one section is present but empty → returned in the missing list.
  it("treats a present-but-empty section as missing", () => {
    // Replace Goal content with blank to make it empty.
    const sections = parseSpecMarkdown(FULL_SPEC);
    sections.set("Goal", "   ");
    const missing = validateSpecSections(sections);
    expect(missing).toContain("Goal");
  });

  // 4. ### sub-headings inside a section stay in content, NOT split into top-level keys.
  it("keeps sub-headings (###) inside the parent section content", () => {
    const md = `## Goal\n\n### Sub-goal\n\nDo the thing.\n\n## Out of scope\n\n- nothing\n`;
    const sections = parseSpecMarkdown(md);
    // ### Sub-goal should NOT be a top-level key.
    expect(sections.has("Sub-goal")).toBe(false);
    // It should appear inside Goal's content.
    const goal = sections.get("Goal") ?? "";
    expect(goal).toContain("### Sub-goal");
    expect(goal).toContain("Do the thing.");
  });

  // 5. Handles trailing whitespace, CRLF line endings, and arbitrary blank lines.
  it("handles CRLF endings, trailing spaces, and extra blank lines", () => {
    const crlf = "## Goal  \r\n\r\n  Make foo work.  \r\n\r\n\r\n## Out of scope\r\n\r\n- bar\r\n";
    const sections = parseSpecMarkdown(crlf);
    expect(sections.get("Goal")).toBe("Make foo work.");
    expect(sections.get("Out of scope")).toBe("- bar");
  });
});
