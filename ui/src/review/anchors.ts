/** Anchor contract shared with the server reviewer page: headings are
 *  `#{1,6} ` lines outside ``` fences; anchor = text after hashes, trimmed. */
export function parseHeadings(md: string): string[] {
  const out: string[] = [];
  let inCode = false;
  for (const line of md.split("\n")) {
    if (/^```/.test(line)) { inCode = !inCode; continue; }
    if (inCode) continue;
    const m = line.match(/^#{1,6}\s+(.*)$/);
    if (m) out.push(m[1].trim());
  }
  return out;
}
