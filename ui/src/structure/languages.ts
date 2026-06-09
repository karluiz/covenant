// Language detection + grammar loader for the StructureEditor.
//
// Maps a file path → CodeMirror language extension. Detection is
// extension-first (covers ~95% of cases), with a small filename
// fallback for the special files that don't carry one (Dockerfile,
// Makefile, Cargo.lock, …).
//
// Grammars are bundled — no dynamic import. Total payload is small
// enough (~120 KB across the 12 supported languages) that paying for
// it once at boot is simpler than juggling lazy chunks. If the list
// grows past 25–30 grammars, revisit with `import()` per match.

import type { Extension } from "@codemirror/state";
import { sql, StandardSQL, PostgreSQL, MySQL, MSSQL, SQLite } from "@codemirror/lang-sql";
import type { SQLDialect } from "@codemirror/lang-sql";
import { rust } from "@codemirror/lang-rust";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { yaml } from "@codemirror/lang-yaml";
import { StreamLanguage } from "@codemirror/language";
import type { StreamParser } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";

// Legacy StreamLanguage modes don't all advertise `commentTokens`, so
// CodeMirror's toggle-comment command (Mod-/) has nothing to insert.
// Augment the parser with the line-comment token so the editor's
// comment shortcut works for shell/toml/Dockerfile the same way it
// does for the first-class grammars.
function withLineComment<S>(
  parser: StreamParser<S>,
  line: string,
): StreamParser<S> {
  return {
    ...parser,
    languageData: { ...parser.languageData, commentTokens: { line } },
  };
}

const shellMode = withLineComment(shell, "#");
const tomlMode = withLineComment(toml, "#");
const dockerMode = withLineComment(dockerFile, "#");

// ---------------------------------------------------------------------------
// dotenv grammar
// ---------------------------------------------------------------------------
//
// No upstream CodeMirror grammar ships for `.env`, and the legacy
// `properties` mode mis-handles the values (URLs with `:`, JWTs, etc.).
// The format is trivial enough to tokenize directly: full-line `#`/`;`
// comments, an optional leading `export`, a KEY, the `=` separator, and
// everything after it as the value. Token names route through the custom
// `tokenTable` into the editor's shared HighlightStyle (see theme.ts).

interface DotenvState {
  pos: "start" | "key" | "value";
}

const dotenv: StreamParser<DotenvState> = {
  name: "dotenv",
  startState: () => ({ pos: "start" }),
  token(stream, state) {
    if (stream.sol()) state.pos = "start";

    if (state.pos === "start") {
      if (stream.eatSpace()) return null;
      const ch = stream.peek();
      if (ch === "#" || ch === ";") {
        stream.skipToEnd();
        return "comment";
      }
      // `export FOO=bar` — common in shell-sourced env files.
      if (stream.match(/^export(?=\s)/)) return "keyword";
      state.pos = "key";
    }

    if (state.pos === "key") {
      if (stream.eatSpace()) return null;
      if (stream.eat("=")) {
        state.pos = "value";
        return "operator";
      }
      if (stream.eatWhile(/[^=\s]/)) return "envKey";
      stream.next();
      return null;
    }

    // value — consume the rest of the line verbatim.
    stream.skipToEnd();
    return "envValue";
  },
  languageData: { commentTokens: { line: "#" } },
  tokenTable: {
    envKey: t.attributeName,
    envValue: t.string,
  },
};

/// Match dotenv files by basename: `.env`, `.env.<stage>` (e.g.
/// `.env.local`, `.env.production`), and `*.env`. Excludes lookalikes
/// such as `.environment`.
export function isDotenvPath(path: string): boolean {
  const base = path.split("/").pop() ?? "";
  return base === ".env" || base.startsWith(".env.") || base.endsWith(".env");
}

// ---------------------------------------------------------------------------
// SQL dialect detection
// ---------------------------------------------------------------------------

interface DialectSpec {
  name: "StandardSQL" | "PostgreSQL" | "MySQL" | "MSSQL" | "SQLite";
  dialect: SQLDialect;
}

const DIALECT_BY_NAME: Record<DialectSpec["name"], SQLDialect> = {
  StandardSQL,
  PostgreSQL,
  MySQL,
  MSSQL,
  SQLite,
};

const MARKER_RE = /^\s*--\s*dialect\s*:\s*([A-Za-z]+)\s*$/i;
const MARKER_LOOKAHEAD_LINES = 20;
const HEAD_HEURISTIC_BYTES = 4096;

function dialectFromMarker(head: string): DialectSpec["name"] | null {
  const lines = head.split("\n", MARKER_LOOKAHEAD_LINES);
  for (const line of lines) {
    const m = MARKER_RE.exec(line);
    if (!m) continue;
    const tag = m[1].toLowerCase();
    if (tag === "postgres" || tag === "postgresql") return "PostgreSQL";
    if (tag === "mysql" || tag === "mariadb") return "MySQL";
    if (tag === "sqlite") return "SQLite";
    if (tag === "mssql" || tag === "sqlserver") return "MSSQL";
    if (tag === "standard" || tag === "ansi") return "StandardSQL";
  }
  return null;
}

function dialectFromHeuristic(head: string): DialectSpec["name"] | null {
  const slice = head
    .slice(0, HEAD_HEURISTIC_BYTES)
    .split("\n")
    .map((line) => {
      const i = line.indexOf("--");
      return i === -1 ? line : line.slice(0, i);
    })
    .join("\n");
  if (
    /\bIDENTITY\s*\(/i.test(slice) ||
    /\bNVARCHAR\b/i.test(slice) ||
    /\n\s*GO\s*\n/i.test(slice)
  ) {
    return "MSSQL";
  }
  if (
    /\bAUTO_INCREMENT\b/i.test(slice) ||
    /`[A-Za-z0-9_]+`/.test(slice) ||
    /\bENGINE\s*=/i.test(slice)
  ) {
    return "MySQL";
  }
  if (
    /\bRETURNING\b/i.test(slice) ||
    /\bSERIAL\b/i.test(slice) ||
    /\bBIGSERIAL\b/i.test(slice) ||
    /\$\$/.test(slice) ||
    /\bILIKE\b/i.test(slice)
  ) {
    return "PostgreSQL";
  }
  if (
    /\bPRAGMA\b/i.test(slice) ||
    /\bAUTOINCREMENT\b/i.test(slice) ||
    /\bWITHOUT\s+ROWID\b/i.test(slice)
  ) {
    return "SQLite";
  }
  return null;
}

/// Detect the SQL dialect for a file, using extension, explicit marker
/// comment, or content heuristics. Returns a DialectSpec with `.name`
/// and `.dialect` for use with `sql({ dialect })`.
export function sqlDialectFor(path: string, head: string): DialectSpec {
  const base = (path.split("/").pop() ?? "").toLowerCase();
  const ext = base.includes(".") ? base.slice(base.lastIndexOf(".") + 1) : "";
  if (ext === "psql") return { name: "PostgreSQL", dialect: PostgreSQL };
  if (ext === "mysql") return { name: "MySQL", dialect: MySQL };

  const fromMarker = dialectFromMarker(head);
  if (fromMarker) return { name: fromMarker, dialect: DIALECT_BY_NAME[fromMarker] };

  const fromHeuristic = dialectFromHeuristic(head);
  if (fromHeuristic) return { name: fromHeuristic, dialect: DIALECT_BY_NAME[fromHeuristic] };

  return { name: "StandardSQL", dialect: StandardSQL };
}

/// SQL extensions that route through sqlDialectFor instead of BY_EXT.
const SQL_EXTS = new Set(["sql", "psql", "mysql", "ddl", "dml"]);

/// Lookup by lowercased extension. Multiple keys can map to the same
/// language (`.ts` and `.tsx` both → typescript variant of JS).
const BY_EXT: Record<string, () => Extension> = {
  rs: () => rust(),
  ts: () => javascript({ typescript: true }),
  tsx: () => javascript({ typescript: true, jsx: true }),
  js: () => javascript(),
  jsx: () => javascript({ jsx: true }),
  mjs: () => javascript(),
  cjs: () => javascript(),
  py: () => python(),
  pyi: () => python(),
  json: () => json(),
  md: () => markdown(),
  markdown: () => markdown(),
  mdx: () => markdown(),
  css: () => css(),
  scss: () => css(),
  html: () => html(),
  htm: () => html(),
  astro: () => html(),
  xml: () => html(),
  yaml: () => yaml(),
  yml: () => yaml(),
  sh: () => StreamLanguage.define(shellMode),
  bash: () => StreamLanguage.define(shellMode),
  zsh: () => StreamLanguage.define(shellMode),
  toml: () => StreamLanguage.define(tomlMode),
};

/// Filename fallback — exact (case-sensitive) match against the
/// basename. These are filenames that don't carry an extension but
/// whose language is well-known.
const BY_NAME: Record<string, () => Extension> = {
  Dockerfile: () => StreamLanguage.define(dockerMode),
  Containerfile: () => StreamLanguage.define(dockerMode),
  Makefile: () => StreamLanguage.define(shellMode), // close enough; shell-shaped
  "Cargo.lock": () => StreamLanguage.define(tomlMode),
  "Cargo.toml": () => StreamLanguage.define(tomlMode),
};

/// Resolve a CodeMirror language extension for `path`. Returns null
/// when no supported language matches — caller falls back to plain
/// text editing (still gets gutters, undo, search, just no colors).
///
/// `head` is the first few KB of the file content, used only for SQL
/// dialect detection. It defaults to "" and is ignored for all other
/// languages.
export function languageForPath(path: string, head: string = ""): Extension | null {
  const base = path.split("/").pop() ?? "";

  const byName = BY_NAME[base];
  if (byName) return byName();

  // dotenv files (`.env`, `.env.local`, `*.env`) — handled here because
  // the basename either has no extension (`.env`) or a misleading one
  // (`.env.local` → "local") that BY_EXT can't key off.
  if (isDotenvPath(base)) return StreamLanguage.define(dotenv);

  // Dotfiles like `.zshrc`, `.bashrc` — treat as shell.
  if (base.startsWith(".") && /^\.(z|ba)shrc$|^\.profile$|^\.zprofile$/.test(base)) {
    return StreamLanguage.define(shell);
  }

  const dot = base.lastIndexOf(".");
  if (dot <= 0) return null;
  const ext = base.slice(dot + 1).toLowerCase();

  // SQL extensions route through dialect detection rather than BY_EXT,
  // because the correct grammar depends on the file's content.
  if (SQL_EXTS.has(ext)) {
    return sql({ dialect: sqlDialectFor(path, head).dialect });
  }

  const factory = BY_EXT[ext];
  return factory ? factory() : null;
}
