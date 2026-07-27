/// True when `cwd` is the worktree root `root` or a directory inside it.
/// Boundary-safe: a trailing slash on the prefix stops "/w/foo-2" from
/// matching root "/w/foo". Worktrees are never nested as git checkouts,
/// but linked worktrees DO live physically inside the main checkout
/// (`.covenant/worktrees/<slug>`, `.claude/worktrees/<slug>`) — a cwd in
/// one of those is a different checkout, not "under" the main root.
export function cwdUnderRoot(
  cwd: string | null | undefined,
  root: string | null | undefined,
): boolean {
  if (!cwd || !root) return false;
  if (cwd === root) return true;
  const base = root.endsWith("/") ? root : root + "/";
  if (!cwd.startsWith(base)) return false;
  return !/(^|\/)\.(covenant|claude)\/worktrees\//.test(cwd.slice(base.length));
}
