const SPEC_RE = /(^|\/)docs\/specs\/(.+)$/;

export function isSpecPath(path: string): boolean {
  if (!path.endsWith(".md")) return false;
  const m = SPEC_RE.exec(path);
  if (!m) return false;
  const rest = m[2]; // e.g. "drafts/foo.md", "_template.md", "3.17-foo.md"
  if (rest.startsWith("drafts/")) return false;
  if (rest.includes("/drafts/")) return false;
  const fileName = rest.split("/").pop() ?? "";
  if (fileName === "_template.md") return false;
  return true;
}
