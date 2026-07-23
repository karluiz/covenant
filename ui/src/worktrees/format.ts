import type { GitWorktreeSummary } from "../api";

// ponytail: worktreeLabel/compactPath duplicate the 6-line bar.ts privates
// rather than exporting from that 3000-line file.

export function worktreeLabel(wt: GitWorktreeSummary): string {
  if (wt.branch) return wt.branch;
  const base = wt.path.split("/").filter(Boolean).pop() ?? wt.path;
  if (wt.detached && wt.head) return `DETACHED@${wt.head.slice(0, 7)}`;
  if (wt.bare) return `${base} (bare)`;
  return base;
}

export function compactPath(path: string): string {
  return path.replace(/^\/Users\/[^/]+/, "~");
}

/** KB → "6.2 GB" / "52 MB" / "800 KB". */
export function humanSize(kb: number): string {
  if (kb >= 1024 * 1024) return `${(kb / 1024 / 1024).toFixed(1)} GB`;
  if (kb >= 1024) return `${Math.round(kb / 1024)} MB`;
  return `${Math.round(kb)} KB`;
}
