// Targeted single-line frontmatter scalar patching for the SOUL split editor.
// Backend `operator_soul_parse` is authoritative for READS; this only writes
// the handful of scalar keys the form controls own (voice, model,
// escalate_threshold, color, avatar, name).

const FENCE = "---";

/** Set or insert a scalar `key: value` line inside the leading frontmatter. */
export function setFrontmatterScalar(raw: string, key: string, value: string): string {
  const text = raw.replace(/\r\n/g, "\n");
  if (!text.startsWith(FENCE + "\n")) {
    return `---\n${key}: ${value}\n---\n\n${text}`;
  }
  const end = text.indexOf("\n" + FENCE, FENCE.length + 1);
  if (end === -1) return text;
  const head = text.slice(FENCE.length + 1, end);
  const tail = text.slice(end); // starts with "\n---"
  const lines = head.split("\n");
  const idx = lines.findIndex((l) => new RegExp(`^${key}\\s*:`).test(l));
  const line = `${key}: ${value}`;
  if (idx === -1) lines.push(line);
  else lines[idx] = line;
  return `${FENCE}\n${lines.join("\n")}${tail}`;
}
