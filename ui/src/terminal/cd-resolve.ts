import type { DirEntry } from "../api";

/**
 * Verbs whose path argument is worth completing, and whether only directories
 * make sense. Kept short on purpose — adding one is a one-line edit, and a verb
 * that shouldn't be here is a wrong completion on every keystroke.
 *
 * `rm`/`mv` are safe to list because the picker *inserts* the path and never
 * runs the line; the user still presses Return themselves.
 */
const VERBS: Record<string, { dirsOnly: boolean }> = {
  cd: { dirsOnly: true },
  pushd: { dirsOnly: true },
  rmdir: { dirsOnly: true },
  ls: { dirsOnly: false },
  cat: { dirsOnly: false },
  less: { dirsOnly: false },
  head: { dirsOnly: false },
  tail: { dirsOnly: false },
  open: { dirsOnly: false },
  code: { dirsOnly: false },
  vim: { dirsOnly: false },
  nvim: { dirsOnly: false },
  source: { dirsOnly: false },
  cp: { dirsOnly: false },
  mv: { dirsOnly: false },
  rm: { dirsOnly: false },
};

export interface PathArg {
  /** The token being typed — what resolves to listDir + prefix. */
  arg: string;
  /** Everything before it, verbatim. select() retypes the line from this. */
  linePrefix: string;
  dirsOnly: boolean;
}

/**
 * Parse a shell line into the path token under the cursor, or null when the
 * line isn't a completable verb. Must run on the RAW (untrimmed) line:
 * `cd ` (trailing space) is the browse-current-dir trigger and yields "".
 *
 * Only the LAST token is the candidate, so `cp a b` completes `b` and leaves
 * `cp a ` alone. Splitting is on unescaped whitespace — `cd my\ dir` is one
 * token, which is also what the shell thinks.
 */
export function parsePathLine(line: string): PathArg | null {
  const m = /^([a-z_.][\w.-]*)\s+(.*)$/is.exec(line);
  if (!m) return null; // no verb, or no space after it (`cd`, `cdk`)
  const verb = VERBS[m[1]];
  if (!verb) return null;
  const rest = m[2];
  // Start of the last token: after the final unescaped whitespace run.
  const lastSep = /(?:^|[^\\])\s+(?=\S*$)/.exec(rest);
  const argStart = lastSep ? lastSep.index + lastSep[0].length : 0;
  const raw = rest.slice(argStart);
  if (raw.startsWith("-")) return null; // a flag, not a path
  return {
    // Unescape so the token matches the real filesystem name: the user typed
    // `my\ dir`, the directory is called `my dir`.
    arg: raw.replace(/\\(.)/g, "$1"),
    linePrefix: line.slice(0, line.length - rest.length + argStart),
    dirsOnly: verb.dirsOnly,
  };
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
export function filterDirs(
  entries: DirEntry[],
  prefix: string,
  opts?: { dirsOnly?: boolean; rank?: (e: DirEntry) => number },
): DirEntry[] {
  const dirsOnly = opts?.dirsOnly ?? true;
  const pool = dirsOnly ? entries.filter((e) => e.kind === "dir") : entries;
  const p = prefix.toLowerCase();
  const head: DirEntry[] = [];
  const mid: DirEntry[] = [];
  for (const e of pool) {
    const at = p ? e.name.toLowerCase().indexOf(p) : 0;
    if (at === 0) head.push(e);
    else if (at > 0) mid.push(e);
  }
  // Frecency orders WITHIN each group, never across it: a prefix match is a
  // stronger statement of intent than "you were there yesterday", and a
  // frecency-first list would reorder under the user mid-keystroke.
  if (opts?.rank) {
    const by = (a: DirEntry, b: DirEntry): number => opts.rank!(b) - opts.rank!(a);
    head.sort(by);
    mid.sort(by);
  }
  return [...head, ...mid];
}

/**
 * zoxide-style frecency: visit count discounted by how long ago. Buckets, not a
 * curve — the exact shape doesn't matter, only that today beats last month.
 */
export function frecency(count: number, lastUsedMs: number, nowMs: number): number {
  const hours = Math.max(0, nowMs - lastUsedMs) / 3_600_000;
  const weight = hours < 1 ? 4 : hours < 24 ? 2 : hours < 168 ? 0.5 : 0.25;
  return count * weight;
}

/** Where `prefix` matches in `name`, or -1. Drives the rendered emphasis. */
export function matchAt(name: string, prefix: string): number {
  return prefix ? name.toLowerCase().indexOf(prefix.toLowerCase()) : -1;
}
