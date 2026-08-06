import type { DirEntry } from "../api";

/**
 * Parse a shell line into the `cd` argument, or null if it isn't a `cd`
 * command. Must run on the RAW (untrimmed) line: `cd ` (trailing space) is
 * the browse-current-dir trigger and yields "". `cd`/`cdk deploy` → null.
 */
export function parseCdLine(line: string): string | null {
  const m = /^cd\s+(.*)$/s.exec(line);
  return m ? m[1] : null;
}

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

/**
 * Keep directories matching `prefix` (case-insensitive) anywhere in the name,
 * prefix hits before mid-name hits. Substring rather than `startsWith`: with
 * prefix-only, `soporte-ti-knowledgebase` was unreachable from "knowledge",
 * so you had to remember how a name *starts* to find it at all.
 */
export function filterDirs(entries: DirEntry[], prefix: string): DirEntry[] {
  const dirs = entries.filter((e) => e.kind === "dir");
  const p = prefix.toLowerCase();
  if (!p) return dirs;
  const head: DirEntry[] = [];
  const mid: DirEntry[] = [];
  for (const e of dirs) {
    const at = e.name.toLowerCase().indexOf(p);
    if (at === 0) head.push(e);
    else if (at > 0) mid.push(e);
  }
  return [...head, ...mid];
}

/** Where `prefix` matches in `name`, or -1. Drives the rendered emphasis. */
export function matchAt(name: string, prefix: string): number {
  return prefix ? name.toLowerCase().indexOf(prefix.toLowerCase()) : -1;
}
