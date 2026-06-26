import type { DirEntry } from "../api";

/** Derive the home dir from a cwd under /Users/<n> or /home/<n>. No $HOME env on the frontend. */
// ponytail: derive ~ from cwd prefix instead of a Tauri round-trip; covers the only two macOS/Linux shapes.
export function homeFromCwd(cwd: string | null): string | null {
  if (!cwd) return null;
  const m = /^(\/Users\/[^/]+|\/home\/[^/]+)/.exec(cwd);
  return m ? m[1] : null;
}

/** Join two POSIX path segments, collapsing the separator. */
function join(base: string, rel: string): string {
  if (!rel) return base;
  return `${base.replace(/\/+$/, "")}/${rel}`.replace(/\/{2,}/g, "/");
}

/**
 * Split the `cd ` argument into the directory to list and the basename prefix
 * being typed. Returns null when it can't be resolved (relative with no cwd,
 * or ~ with no home).
 */
export function resolveCdArg(
  arg: string,
  cwd: string | null,
  home: string | null,
): { listDir: string; prefix: string } | null {
  const slash = arg.lastIndexOf("/");
  const prefix = arg.slice(slash + 1);
  const dirPart = slash >= 0 ? arg.slice(0, slash + 1) : ""; // includes trailing slash, or ""

  // ponytail: leading ~ only; no $VAR or ~user expansion.
  if (arg.startsWith("~")) {
    if (!home) return null;
    const afterTilde = dirPart.replace(/^~\/?/, ""); // "~/Doc" → dirPart "~/" → ""
    const tildeSlash = arg.lastIndexOf("/");
    const tildePrefix = tildeSlash >= 0 ? arg.slice(tildeSlash + 1) : "";
    return { listDir: join(home, afterTilde), prefix: tildePrefix };
  }
  if (arg.startsWith("/")) {
    const base = dirPart || "/";
    const listDir = base === "/" ? "/" : base.replace(/\/+$/, "");
    return { listDir, prefix };
  }
  if (!cwd) return null;
  return { listDir: join(cwd, dirPart.replace(/\/+$/, "")), prefix };
}

/** Keep directories whose name starts with `prefix` (case-insensitive). */
export function filterDirs(entries: DirEntry[], prefix: string): DirEntry[] {
  const p = prefix.toLowerCase();
  return entries.filter((e) => e.kind === "dir" && e.name.toLowerCase().startsWith(p));
}
