/// True when `cwd` is the worktree root `root` or a directory inside it.
/// Boundary-safe: a trailing slash on the prefix stops "/w/foo-2" from
/// matching root "/w/foo". Worktrees are never nested (AGENTS.md), so a
/// single prefix test is unambiguous.
export function cwdUnderRoot(
  cwd: string | null | undefined,
  root: string | null | undefined,
): boolean {
  if (!cwd || !root) return false;
  if (cwd === root) return true;
  const base = root.endsWith("/") ? root : root + "/";
  return cwd.startsWith(base);
}
