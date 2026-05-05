/**
 * Utilities for parsing the markdown emitted by the spec-author agent and
 * validating that all required sections are present.
 */

export const REQUIRED_SECTION_KEYS = [
  "Goal",
  "Out of scope",
  "Acceptance criteria",
  "File boundaries",
  "Complexity",
  "Open questions",
] as const;

/**
 * Parse a markdown string with `## Heading\n<content>\n## Next heading...`
 * into a Map from heading text → trimmed content.
 *
 * - Text before the first `##` heading is ignored.
 * - `### sub-headings` inside a section remain in the section's content.
 * - CRLF line endings are normalised to LF before parsing.
 */
export function parseSpecMarkdown(md: string): Map<string, string> {
  const out = new Map<string, string>();
  // Normalise CRLF.
  const normalised = md.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalised.split("\n");

  let current: string | null = null;
  let buf: string[] = [];

  for (const line of lines) {
    // Match only level-2 headings (exactly two `#`).
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      if (current !== null) {
        out.set(current, buf.join("\n").trim());
      }
      current = m[1];
      buf = [];
    } else if (current !== null) {
      buf.push(line);
    }
    // Lines before the first ## are silently ignored.
  }

  if (current !== null) {
    out.set(current, buf.join("\n").trim());
  }

  return out;
}

/**
 * Return the list of required section keys that are missing or empty in
 * `sections`. An empty array means the spec is valid.
 */
export function validateSpecSections(sections: Map<string, string>): string[] {
  const missing: string[] = [];
  for (const key of REQUIRED_SECTION_KEYS) {
    const value = sections.get(key);
    if (value === undefined || value.trim() === "") {
      missing.push(key);
    }
  }
  return missing;
}
