// Resolves a file or folder name to a tinted icon for the structure tree.
//
// Pure and data-driven so it is unit-testable without a DOM. Colors are
// muted/desaturated to sit calmly in the dark sidebar; each ResolvedIcon
// carries an Icons.* SVG string plus a hex the caller applies via
// `el.style.color` (overriding the inherited `currentColor`).

import { Icons } from "../icons";
import { isDotenvPath } from "./languages";

export interface ResolvedIcon {
  svg: string;
  color: string;
}

const SIZE = 13;

// Muted palette. Keep keys stable — tests assert on these exact hexes.
const C = {
  ts: "#4d7eaa",
  js: "#b8a13e",
  rust: "#c07a52",
  json: "#9a8b3c",
  md: "#8a93a0",
  css: "#5a8fb0",
  py: "#5a86a8",
  go: "#4f9aa8",
  shell: "#6f9a6a",
  html: "#bb7a55",
  image: "#9a6fa0",
  sql: "#4f9aa8",
  config: "#7d8590",
  folder: "#6f7681",
  fallback: "#6e7681",
} as const;

function icon(glyph: (o: { size: number }) => string, color: string): ResolvedIcon {
  return { svg: glyph({ size: SIZE }), color };
}

// Exact filename matches (lowercased). Highest priority.
const EXACT: Record<string, ResolvedIcon> = {
  "package.json": icon(Icons.packageBox, C.json),
  "tsconfig.json": icon(Icons.braces, C.config),
  "dockerfile": icon(Icons.gear, C.config),
  "readme.md": icon(Icons.markdown, C.md),
  "claude.md": icon(Icons.markdown, C.md),
  ".gitignore": icon(Icons.gear, C.config),
  ".gitattributes": icon(Icons.gear, C.config),
  "components.json": icon(Icons.braces, C.json),
};

// Simple extension → ResolvedIcon. Lowercased, no leading dot.
const BY_EXT: Record<string, ResolvedIcon> = {
  ts: icon(Icons.fileCode, C.ts),
  tsx: icon(Icons.fileCode, C.ts),
  js: icon(Icons.fileCode, C.js),
  jsx: icon(Icons.fileCode, C.js),
  mjs: icon(Icons.fileCode, C.js),
  cjs: icon(Icons.fileCode, C.js),
  rs: icon(Icons.fileCode, C.rust),
  json: icon(Icons.braces, C.json),
  md: icon(Icons.markdown, C.md),
  mdx: icon(Icons.markdown, C.md),
  css: icon(Icons.fileCode, C.css),
  scss: icon(Icons.fileCode, C.css),
  html: icon(Icons.fileCode, C.html),
  py: icon(Icons.fileCode, C.py),
  go: icon(Icons.fileCode, C.go),
  sh: icon(Icons.terminalSquare, C.shell),
  bash: icon(Icons.terminalSquare, C.shell),
  zsh: icon(Icons.terminalSquare, C.shell),
  toml: icon(Icons.braces, C.config),
  yaml: icon(Icons.braces, C.config),
  yml: icon(Icons.braces, C.config),
  sql: icon(Icons.database, C.sql),
  png: icon(Icons.image, C.image),
  jpg: icon(Icons.image, C.image),
  jpeg: icon(Icons.image, C.image),
  gif: icon(Icons.image, C.image),
  svg: icon(Icons.image, C.image),
  txt: icon(Icons.fileText, C.md),
  lock: icon(Icons.gear, C.config),
};

const FALLBACK: ResolvedIcon = icon(Icons.fileText, C.fallback);
const DOTFILE_CONFIG: ResolvedIcon = icon(Icons.gear, C.config);
const LOCKFILE: ResolvedIcon = icon(Icons.gear, C.config);

export function resolveFileIcon(name: string): ResolvedIcon {
  const lower = name.toLowerCase();

  // 1. Exact filename
  if (EXACT[lower]) return EXACT[lower];
  if (lower === "package-lock.json" || lower.endsWith(".lock") || lower === "yarn.lock") {
    return LOCKFILE;
  }
  if (isDotenvPath(name)) return DOTFILE_CONFIG;
  if (/^\.?(eslint|prettier|babel|stylelint)(rc|ignore|\.config)?/.test(lower)) {
    return DOTFILE_CONFIG;
  }
  if (/^(vite|next|tailwind|postcss|rollup|webpack)\.config\./.test(lower)) {
    // config-of-X — color by its trailing ext, glyph braces
    const ext = lower.split(".").pop() ?? "";
    const base = BY_EXT[ext];
    return base
      ? { svg: Icons.braces({ size: SIZE }), color: base.color }
      : icon(Icons.braces, C.config);
  }

  // 2. Compound extension (.d.ts etc.)
  if (lower.endsWith(".d.ts")) return BY_EXT.ts;

  // 3. Simple extension
  const ext = lower.includes(".") ? lower.split(".").pop()! : "";
  if (ext && BY_EXT[ext]) return BY_EXT[ext];

  // 4. Bare dotfile with no known match → config gear
  if (lower.startsWith(".")) return DOTFILE_CONFIG;

  // 5. Fallback
  return FALLBACK;
}

// Known folders → glyph factory (closed). Open state swaps to folderOpen
// for the generic ones; special folders keep their brand glyph.
const FOLDER_SPECIAL: Record<
  string,
  { closed: (o: { size: number }) => string; color: string }
> = {
  ".github": { closed: Icons.github, color: C.config },
  ".git": { closed: Icons.github, color: C.config },
  ".vscode": { closed: Icons.gear, color: C.css },
  "node_modules": { closed: Icons.boxes, color: C.config },
  "src": { closed: Icons.folder, color: C.ts },
  "public": { closed: Icons.folder, color: C.go },
  "docs": { closed: Icons.folder, color: C.md },
  "dist": { closed: Icons.folder, color: C.config },
  "build": { closed: Icons.folder, color: C.config },
  "test": { closed: Icons.folder, color: C.shell },
  "tests": { closed: Icons.folder, color: C.shell },
  "assets": { closed: Icons.folder, color: C.image },
};

export function resolveFolderIcon(name: string, open: boolean): ResolvedIcon {
  const special = FOLDER_SPECIAL[name.toLowerCase()];
  if (special) {
    // Brand glyphs (github/boxes/gear) don't have an open variant; plain
    // folders flip to folderOpen so expand state reads visually.
    const isPlainFolder = special.closed === Icons.folder;
    const glyph = isPlainFolder && open ? Icons.folderOpen : special.closed;
    return { svg: glyph({ size: SIZE }), color: special.color };
  }
  const glyph = open ? Icons.folderOpen : Icons.folder;
  return { svg: glyph({ size: SIZE }), color: C.folder };
}
