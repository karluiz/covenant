/// If the SOUL.md's `name:` collides with an existing local operator name
/// (case-insensitive — the local DB has a LOWER(name) unique index), rewrite
/// the frontmatter name with a " (community)" suffix so import never clobbers
/// an existing operator. Returns the (possibly) rewritten SOUL.md text.
export function suffixSoulName(soulMd: string, existingLower: Set<string>): string {
  const m = soulMd.match(/^name:\s*(.+)$/m);
  if (!m) return soulMd;
  const base = m[1].trim().replace(/^["']|["']$/g, "");
  if (!existingLower.has(base.toLowerCase())) return soulMd;
  let candidate = `${base} (community)`;
  let n = 2;
  while (existingLower.has(candidate.toLowerCase())) {
    candidate = `${base} (community ${n++})`;
  }
  return soulMd.replace(/^name:\s*.+$/m, () => `name: ${candidate}`);
}
