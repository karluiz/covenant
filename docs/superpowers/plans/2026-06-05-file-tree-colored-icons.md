# File Tree Colored Per-Type Icons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the file explorer VSCode-style per-extension file icons and per-folder icons, tinted with muted/desaturated colors that fit the dark sidebar.

**Architecture:** A new pure module `ui/src/structure/file-icons.ts` resolves a filename (or folder name + open state) to `{ svg, color }`. Glyphs are inline SVGs added to the existing `ui/src/icons/index.ts`. `tree.ts` calls the resolver and sets `icon.style.color`. Resolution is data-driven and unit-tested with vitest; no npm icon packs.

**Tech Stack:** TypeScript, vitest, existing `Icons.*` SVG helper.

---

## File Structure

- **Create:** `ui/src/structure/file-icons.ts` — resolver + color table + type→glyph map. One responsibility: name → `ResolvedIcon`.
- **Create:** `ui/src/structure/file-icons.test.ts` — unit tests.
- **Modify:** `ui/src/icons/index.ts` — add ~12 new category/brand glyphs.
- **Modify:** `ui/src/structure/tree.ts` — call resolver in `makeNode` (~494), the inline-creation row (~829), and on expand/collapse re-resolve.

Tests run from repo root with `npm test` (vitest). Run a single file with `npx vitest run src/structure/file-icons.test.ts` from `ui/`, or `npm test -- file-icons` from root.

---

## Task 1: Add new glyphs to the icon set

**Files:**
- Modify: `ui/src/icons/index.ts`

We need category glyphs not already present: `braces` (config/json), `fileCode` (code files), `image`, `gear` (cog, dotfile config), `terminalSquare` (shell), `database` (sql), `markdown`, `folderOpen`, plus `boxes` (node_modules), `github`, `settings2` (.vscode), `packageBox` (package.json). Reuse existing `folder` and `fileText`.

- [ ] **Step 1: Add the glyphs**

Add these entries to the `Icons` object in `ui/src/icons/index.ts` (place them near the other file/folder icons; all use the existing `svg()` helper, paths are Lucide MIT):

```ts
  /** Open folder — expanded directory in the tree. */
  folderOpen: (o?: IconOptions): string =>
    svg(
      `<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>`,
      o,
    ),

  /** Curly braces — config / json / structured data. */
  braces: (o?: IconOptions): string =>
    svg(
      `<path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5a2 2 0 0 0 2 2h1"/><path d="M16 21h1a2 2 0 0 0 2-2v-5a2 2 0 0 1 2-2 2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1"/>`,
      o,
    ),

  /** Code file — generic source code. */
  fileCode: (o?: IconOptions): string =>
    svg(
      `<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><path d="m9 13-2 2 2 2"/><path d="m15 13 2 2-2 2"/>`,
      o,
    ),

  /** Image file — png / svg / jpg / gif. */
  image: (o?: IconOptions): string =>
    svg(
      `<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>`,
      o,
    ),

  /** Gear / cog — dotfile config (.eslintrc, .prettierrc, etc.). */
  gear: (o?: IconOptions): string =>
    svg(
      `<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>`,
      o,
    ),

  /** Terminal-in-square — shell scripts. */
  terminalSquare: (o?: IconOptions): string =>
    svg(
      `<path d="m7 11 2-2-2-2"/><path d="M11 13h4"/><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/>`,
      o,
    ),

  /** Database — sql files. */
  database: (o?: IconOptions): string =>
    svg(
      `<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5V19A9 3 0 0 0 21 19V5"/><path d="M3 12A9 3 0 0 0 21 12"/>`,
      o,
    ),

  /** Markdown mark. */
  markdown: (o?: IconOptions): string =>
    svg(
      `<rect width="20" height="16" x="2" y="4" rx="2"/><path d="M6 14V10l2 2 2-2v4"/><path d="M16 10v4"/><path d="m14 13 2 2 2-2"/>`,
      o,
    ),

  /** Boxes — node_modules / vendored deps. */
  boxes: (o?: IconOptions): string =>
    svg(
      `<path d="M2.97 12.92A2 2 0 0 0 2 14.63v3.24a2 2 0 0 0 .97 1.71l3 1.8a2 2 0 0 0 2.06 0L12 19v-5.5l-5-3-4.03 2.42Z"/><path d="m7 16.5-4.74-2.85"/><path d="m7 16.5 5-3"/><path d="M7 16.5v5.17"/><path d="M12 13.5V19l3.97 2.38a2 2 0 0 0 2.06 0l3-1.8a2 2 0 0 0 .97-1.71v-3.24a2 2 0 0 0-.97-1.71L17 10.5l-5 3Z"/><path d="m17 16.5-5-3"/><path d="m17 16.5 4.74-2.85"/><path d="M17 16.5v5.17"/><path d="M7.97 4.42A2 2 0 0 0 7 6.13v4.37l5 3 5-3V6.13a2 2 0 0 0-.97-1.71l-3-1.8a2 2 0 0 0-2.06 0l-3 1.8Z"/><path d="M12 8 7.26 5.15"/><path d="m12 8 4.74-2.85"/><path d="M12 13.5V8"/>`,
      o,
    ),

  /** GitHub mark — .github folder. */
  github: (o?: IconOptions): string =>
    svg(
      `<path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 1 5 1 5 1c-.3 1.15-.3 2.35 0 3.5A5.4 5.4 0 0 0 4 8c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"/><path d="M9 18c-4.51 2-5-2-7-2"/>`,
      o,
    ),

  /** Package box — package.json / package-lock. */
  packageBox: (o?: IconOptions): string =>
    svg(
      `<path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>`,
      o,
    ),
```

- [ ] **Step 2: Type-check**

Run from repo root: `cd ui && npx tsc --noEmit`
Expected: no errors (new entries are well-typed string-returning functions).

- [ ] **Step 3: Commit**

```bash
git add ui/src/icons/index.ts
git commit -m "feat(icons): add file-type and folder glyphs for the explorer"
```

---

## Task 2: Create the icon resolver with tests (TDD)

**Files:**
- Create: `ui/src/structure/file-icons.ts`
- Test: `ui/src/structure/file-icons.test.ts`

The resolver is pure: input is a name string, output is `{ svg, color }`. We reuse `isDotenvPath` from `./languages` for `.env` matching.

- [ ] **Step 1: Write the failing test**

Create `ui/src/structure/file-icons.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { resolveFileIcon, resolveFolderIcon } from "./file-icons";

describe("resolveFileIcon — exact filenames", () => {
  it("package.json → package color", () => {
    const r = resolveFileIcon("package.json");
    expect(r.color).toBe("#9a8b3c");
    expect(r.svg).toContain("<svg");
  });
  it("package-lock.json is treated as a lockfile", () => {
    expect(resolveFileIcon("package-lock.json").color).toBe("#7d8590");
  });
  it("Dockerfile (any case) → config gray", () => {
    expect(resolveFileIcon("Dockerfile").color).toBe("#7d8590");
    expect(resolveFileIcon("dockerfile").color).toBe("#7d8590");
  });
  it("README.md → markdown color", () => {
    expect(resolveFileIcon("README.md").color).toBe("#8a93a0");
  });
  it(".gitignore → config gray", () => {
    expect(resolveFileIcon(".gitignore").color).toBe("#7d8590");
  });
  it(".env → config gray", () => {
    expect(resolveFileIcon(".env").color).toBe("#7d8590");
  });
});

describe("resolveFileIcon — compound extensions", () => {
  it(".d.ts → ts color", () => {
    expect(resolveFileIcon("next-env.d.ts").color).toBe("#4d7eaa");
  });
  it("next.config.js → js color", () => {
    expect(resolveFileIcon("next.config.js").color).toBe("#b8a13e");
  });
});

describe("resolveFileIcon — simple extensions", () => {
  it.each([
    ["firebase.ts", "#4d7eaa"],
    ["i18n.js", "#b8a13e"],
    ["main.rs", "#c07a52"],
    ["components.json", "#9a8b3c"],
    ["build.css", "#5a8fb0"],
    ["app.py", "#5a86a8"],
    ["logo.svg", "#9a6fa0"],
    ["query.sql", "#4f9aa8"],
  ])("%s → %s", (name, color) => {
    expect(resolveFileIcon(name).color).toBe(color);
  });
});

describe("resolveFileIcon — dotfile & fallback", () => {
  it(".eslintignore → config gear gray", () => {
    expect(resolveFileIcon(".eslintignore").color).toBe("#7d8590");
  });
  it(".prettierignore → config gear gray", () => {
    expect(resolveFileIcon(".prettierignore").color).toBe("#7d8590");
  });
  it("unknown extension → fallback gray", () => {
    const r = resolveFileIcon("outdated_packages.txt");
    expect(r.color).toBe("#8a93a0"); // txt is mapped
    expect(resolveFileIcon("mystery.xyz").color).toBe("#6e7681");
  });
});

describe("resolveFolderIcon", () => {
  it("known folder .github → github glyph, open differs from closed", () => {
    const closed = resolveFolderIcon(".github", false);
    const open = resolveFolderIcon("src", true);
    expect(closed.svg).toContain("<svg");
    expect(open.svg).not.toBe(resolveFolderIcon("src", false).svg);
  });
  it("unknown folder open vs closed returns different svg", () => {
    expect(resolveFolderIcon("whatever", true).svg).not.toBe(
      resolveFolderIcon("whatever", false).svg,
    );
  });
  it("unknown folder has a tint color", () => {
    expect(resolveFolderIcon("whatever", false).color).toBe("#6f7681");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run from `ui/`: `npx vitest run src/structure/file-icons.test.ts`
Expected: FAIL — `Failed to resolve import "./file-icons"`.

- [ ] **Step 3: Write the resolver**

Create `ui/src/structure/file-icons.ts`:

```ts
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
    return base ? { svg: Icons.braces({ size: SIZE }), color: base.color } : icon(Icons.braces, C.config);
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
const FOLDER_SPECIAL: Record<string, { closed: (o: { size: number }) => string; color: string }> = {
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run from `ui/`: `npx vitest run src/structure/file-icons.test.ts`
Expected: PASS (all cases). If `outdated_packages.txt` or any hex assertion fails, reconcile the test's expected hex with the `C` table — they must agree.

- [ ] **Step 5: Commit**

```bash
git add ui/src/structure/file-icons.ts ui/src/structure/file-icons.test.ts
git commit -m "feat(structure): add data-driven file/folder icon resolver"
```

---

## Task 3: Wire the resolver into the tree

**Files:**
- Modify: `ui/src/structure/tree.ts`

Three call sites: the main `makeNode` icon (~494), the inline-creation row (~829), and folder expand/collapse so the open glyph/tint updates.

- [ ] **Step 1: Import the resolver**

At the top of `ui/src/structure/tree.ts`, add to the existing imports:

```ts
import { resolveFileIcon, resolveFolderIcon } from "./file-icons";
```

- [ ] **Step 2: Replace the icon assignment in `makeNode`**

Find (around line 492-498):

```ts
    const icon = document.createElement("span");
    icon.className = "structure-icon";
    icon.innerHTML =
      entry.kind === "dir"
        ? Icons.folder({ size: 13 })
        : Icons.fileText({ size: 13 });
    row.appendChild(icon);
```

Replace with:

```ts
    const icon = document.createElement("span");
    icon.className = "structure-icon";
    const resolved =
      entry.kind === "dir"
        ? resolveFolderIcon(entry.name, false)
        : resolveFileIcon(entry.name);
    icon.innerHTML = resolved.svg;
    icon.style.color = resolved.color;
    row.appendChild(icon);
```

- [ ] **Step 3: Update the icon on folder expand/collapse**

Expand/collapse run through the `private async expand(node)` (line ~911) and `private collapse(node)` (line ~950) methods, each of which flips `node.expanded` and toggles the `structure-node-expanded` class. Add a helper near them:

```ts
  private refreshFolderIcon(node: NodeState): void {
    if (node.entry.kind !== "dir") return;
    const iconEl = node.el.querySelector<HTMLElement>(".structure-icon");
    if (!iconEl) return;
    const r = resolveFolderIcon(node.entry.name, node.expanded);
    iconEl.innerHTML = r.svg;
    iconEl.style.color = r.color;
  }
```

In `expand`, immediately after:

```ts
    node.expanded = true;
    node.el.classList.add("structure-node-expanded");
```

add:

```ts
    this.refreshFolderIcon(node);
```

In `collapse`, immediately after:

```ts
    node.expanded = false;
    node.el.classList.remove("structure-node-expanded");
```

add:

```ts
    this.refreshFolderIcon(node);
```

Note: `expand` returns early at line 912 (`if (node.expanded) return;`) before reaching this point only when already expanded, so the refresh always runs on a real expand. Placing the call right after the classList toggle (not after the early `return` paths further down) guarantees it fires on both the already-loaded and freshly-loaded branches.

- [ ] **Step 4: Replace the icon assignment in the inline-creation row**

Find the inline create-row block (around line 829-837) that mirrors the `makeNode` pattern:

```ts
    icon.innerHTML =
      kind === "dir"
        ? Icons.folder({ size: 13 })
        : Icons.fileText({ size: 13 });
```

Replace with (the draft row has a typed name input; use a neutral default until a name exists, resolving live is optional):

```ts
    const draftResolved =
      kind === "dir" ? resolveFolderIcon("", false) : resolveFileIcon("");
    icon.innerHTML = draftResolved.svg;
    icon.style.color = draftResolved.color;
```

(`resolveFileIcon("")` returns the fallback; `resolveFolderIcon("", false)` the generic folder — correct for an unnamed draft.)

- [ ] **Step 5: Type-check and run the full UI test suite**

Run from `ui/`: `npx tsc --noEmit && npx vitest run`
Expected: tsc clean; all tests pass including the existing `structure/tree.test.ts` (the structural DOM it asserts on — `.structure-icon` span — is unchanged; only its `innerHTML`/`color` differ).

If `tree.test.ts` asserts on the exact `innerHTML` of a file icon (the old `fileText` path), update that assertion to match the resolver's output for the tested name, or relax it to assert the span contains `<svg`.

- [ ] **Step 6: Commit**

```bash
git add ui/src/structure/tree.ts
git commit -m "feat(structure): render colored per-type icons in the file tree"
```

---

## Task 4: Manual verification

- [ ] **Step 1: Launch the app** (use the `respawn` skill or `npm run tauri:dev`), open the file explorer on a real repo (e.g. the groowcity-frontend in the screenshot).

- [ ] **Step 2: Confirm visually:**
  - `.ts`/`.js`/`.rs`/`.json`/`.md`/`.css` files each show a distinct tint.
  - `package.json` shows the package-box glyph; `Dockerfile`, `.gitignore`, `.eslintignore`, `.prettierignore` show the gear, gray.
  - `.github`, `src`, `public`, `docs`, `node_modules` folders show their special glyph/tint.
  - Expanding a plain folder swaps to the open-folder glyph; collapsing restores it.
  - Active-row highlight and hover still look correct (label/chevron color unaffected; only the icon is tinted).

- [ ] **Step 3:** If a chosen hue reads too bright/dim against the sidebar, nudge the value in the `C` table in `file-icons.ts` and re-verify. No test changes needed unless you change a hex an assertion pins — keep them in sync.

---

## Self-Review Notes

- **Spec coverage:** resolver module ✅ (Task 2), glyph set ✅ (Task 1), color table ✅ (Task 2), folder icons w/ open/closed ✅ (Tasks 2-3), wiring at all three call sites ✅ (Task 3), tests per tier ✅ (Task 2), dotfile→gear default ✅, icon-only tint (no label color) ✅ (Task 3 sets only `icon.style.color`).
- **Type consistency:** `ResolvedIcon { svg, color }`, `resolveFileIcon(name)`, `resolveFolderIcon(name, open)`, `refreshFolderIcon(node)` used consistently across tasks.
- **Hex consistency:** test expectations in Task 2 Step 1 mirror the `C` table in Step 3 — verified pairwise (ts `#4d7eaa`, js `#b8a13e`, rust `#c07a52`, json `#9a8b3c`, md `#8a93a0`, css `#5a8fb0`, py `#5a86a8`, sql/go `#4f9aa8`, image `#9a6fa0`, config `#7d8590`, folder `#6f7681`, fallback `#6e7681`).
