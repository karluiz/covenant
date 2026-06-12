# File Tree Colored Per-Type Icons

> Give the file explorer VSCode-style per-extension icons and per-folder
> icons, tinted with muted/desaturated colors that fit the dark sidebar.

## Problem

The structure tree (`ui/src/structure/tree.ts`) renders exactly two
glyphs: `Icons.folder` for directories and `Icons.fileText` for every
file, all monochrome. There is no per-type differentiation, so the tree
is visually undifferentiated and harder to scan than VSCode.

## Goals

- Distinct glyph + muted color per common file type (~25–30 types).
- Distinct glyph + tint for well-known folders (`.github`, `src`, etc.).
- Pure, data-driven, unit-testable resolution. No npm icon packs.

## Non-goals (YAGNI)

- User-configurable icon themes / icon packs.
- Light-mode color variants.
- Coloring the file *name* label (icon only).
- Bespoke brand logos for every type — reuse category shapes where no
  real glyph is warranted.

## Architecture

### New module: `ui/src/structure/file-icons.ts`

Pure functions, no DOM. Fully testable.

```ts
export interface ResolvedIcon {
  svg: string;    // an Icons.* SVG string, size 13
  color: string;  // muted hex, applied via el.style.color
}

export function resolveFileIcon(name: string): ResolvedIcon;
export function resolveFolderIcon(name: string, open: boolean): ResolvedIcon;
```

**File resolution order (first match wins):**

1. **Exact filename** — `package.json`, `package-lock.json`, `Dockerfile`,
   `dockerfile`, `tsconfig.json`, `.gitignore`, `.env`, `.eslintrc*`,
   `.eslintignore`, `.prettierrc*`, `.prettierignore`, `vite.config.*`,
   `next.config.*`, `README.md`, `CLAUDE.md`, `*.lock`.
2. **Compound extension** — `.d.ts`, `.config.js`, `.test.ts`/`.spec.ts`,
   `.module.css`.
3. **Simple extension** — `ts tsx js jsx rs json md css scss html py go
   sh toml yaml yml sql png svg jpg jpeg gif lock txt`.
4. **Fallback** — generic `fileText`, neutral gray.

Dotfiles with no specific match (e.g. `.eslintignore`,
`.prettierignore`) get the **config-gear** glyph, gray.

**Folder resolution:** recognize `.github`, `.vscode`, `src`, `public`,
`docs`, `node_modules`, `dist`, `build`, `.git`, `test`, `tests`,
`assets`. Each maps to a tinted folder glyph with open/closed variants;
everything else uses the default folder, faintly tinted.

### Glyph set: `ui/src/icons/index.ts`

Add ~25–30 inline SVGs via the existing `svg()` helper. Where no real
brand glyph exists, reuse a small set of category shapes:

- braces `{}` — config/json
- document — markup/markdown/text
- image — png/svg/jpg
- gear — dotfile config
- terminal — shell scripts
- existing `fileText` — fallback

### Color table

Static map keyed by type → muted hex. Tuned dim for the dark sidebar:

| type | hex |
|---|---|
| ts/tsx | `#4d7eaa` |
| js/jsx | `#b8a13e` |
| rust | `#c07a52` |
| json | `#9a8b3c` |
| md | `#8a93a0` |
| css/scss | `#5a8fb0` |
| python | `#5a86a8` |
| go | `#4f9aa8` |
| shell | `#6f9a6a` |
| html | `#bb7a55` |
| image | `#9a6fa0` |
| config/gear | `#7d8590` |
| fallback | `#6e7681` |

(Exact values may be nudged during implementation for cohesion.)

## Wiring

In `tree.ts` `makeNode` (~line 494):

```ts
const resolved = entry.kind === "dir"
  ? resolveFolderIcon(entry.name, node.expanded)
  : resolveFileIcon(entry.name);
icon.innerHTML = resolved.svg;
icon.style.color = resolved.color;
```

- Same two-line change at the inline file/folder creation row (~829).
- On folder expand/collapse, re-resolve so the open-folder glyph/tint
  updates (folder icons have open/closed variants).

`color` overrides the inherited `currentColor` so the active-row and
hover styles continue to work on the label and chevron.

## Testing

Unit tests for `resolveFileIcon` / `resolveFolderIcon`:

- each resolution tier (exact / compound / simple / fallback)
- every exact filename from the screenshot
- dotfile → gear fallback
- folder open vs closed returns different svg
- unknown ext → fallback gray

No DOM required.

## Open decisions (defaulted)

- Dotfiles without a specific match → config-gear glyph, gray. ✅
- Folder tints are subtle, icon-only (not label). ✅
