# SQL Highlighting + XLSX Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add SQL syntax highlighting with auto-detected dialect and a read-only multi-sheet XLSX viewer to the StructureEditor.

**Architecture:** Extend `ui/src/structure/languages.ts` with a SQL grammar and a pure `sqlDialectFor(path, head)` helper. Add a new `XlsxPreview` to `ui/src/structure/preview.ts` plus an `"xlsx"` branch in `previewKindForPath`. Reuse the existing binary-load path in `editor.ts` (the one already feeding `PngPreview` via `structureReadBinaryFile` + `JSON.stringify(bytes)`) so the `Preview` interface stays string-only.

**Tech Stack:** CodeMirror 6 (`@codemirror/lang-sql`), SheetJS (`xlsx`), TypeScript strict, vitest, Tauri.

**Spec:** `docs/superpowers/specs/2026-05-13-sql-highlighting-and-xlsx-viewer-design.md`

**Worktree:** All work happens in a git worktree (see feedback: worktrees mandatory). Branch suggestion: `sql-xlsx-viewer`.

---

## File Structure

- `package.json` — add `@codemirror/lang-sql`, `xlsx` deps.
- `ui/src/structure/languages.ts` — add SQL mapping; introduce `sqlDialectFor(path, head)`; broaden `languageForPath` signature to `(path, head?)`.
- `ui/src/structure/languages.test.ts` — **new** unit tests for dialect detection.
- `ui/src/structure/preview.ts` — `XlsxPreview` class; extend `previewKindForPath` with xlsx extensions.
- `ui/src/structure/preview.test.ts` — **new** unit tests for `XlsxPreview` against an inline fixture workbook.
- `ui/src/structure/editor.ts` — open-path branch for xlsx (binary read like PNG); pass file head to `languageForPath` for `.sql`-family files; hide source toggle for xlsx; ensure xlsx-specific previews don't show the PNG-export button.
- `ui/src/styles.css` — `.structure-preview-xlsx` (sheet-tab row + scrollable grid).

---

## Task 1: Add dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add deps**

```bash
npm install --save @codemirror/lang-sql xlsx
```

- [ ] **Step 2: Verify install**

```bash
npm ls @codemirror/lang-sql xlsx
```

Expected: both resolved, no peer warnings blocking install.

- [ ] **Step 3: Type-check baseline still clean**

```bash
npm run build
```

Expected: existing build passes (no changes to source yet).

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(deps): add @codemirror/lang-sql and xlsx for editor"
```

---

## Task 2: SQL dialect detector — failing tests first

**Files:**
- Create: `ui/src/structure/languages.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// ui/src/structure/languages.test.ts
import { describe, it, expect } from "vitest";
import { sqlDialectFor } from "./languages";

describe("sqlDialectFor", () => {
  it("returns PostgreSQL for .psql extension regardless of content", () => {
    expect(sqlDialectFor("/x/foo.psql", "SELECT 1;").name).toBe("PostgreSQL");
  });

  it("returns MySQL for .mysql extension", () => {
    expect(sqlDialectFor("/x/foo.mysql", "SELECT 1;").name).toBe("MySQL");
  });

  it("honors explicit -- dialect: marker in head", () => {
    const head = "-- dialect: sqlite\nSELECT * FROM t;";
    expect(sqlDialectFor("/x/foo.sql", head).name).toBe("SQLite");
  });

  it("marker is case-insensitive and tolerates whitespace", () => {
    const head = "  --   Dialect:   MSSQL  \nSELECT 1;";
    expect(sqlDialectFor("/x/foo.sql", head).name).toBe("MSSQL");
  });

  it("ignores dialect marker past first ~20 lines", () => {
    const head = "\n".repeat(25) + "-- dialect: postgres\n";
    expect(sqlDialectFor("/x/foo.sql", head).name).toBe("StandardSQL");
  });

  it("heuristic: RETURNING → PostgreSQL", () => {
    expect(
      sqlDialectFor("/x/q.sql", "INSERT INTO t(a) VALUES(1) RETURNING id;").name,
    ).toBe("PostgreSQL");
  });

  it("heuristic: AUTO_INCREMENT → MySQL", () => {
    expect(
      sqlDialectFor(
        "/x/q.sql",
        "CREATE TABLE t (id INT AUTO_INCREMENT PRIMARY KEY);",
      ).name,
    ).toBe("MySQL");
  });

  it("heuristic: IDENTITY(1,1) → MSSQL", () => {
    expect(
      sqlDialectFor("/x/q.sql", "CREATE TABLE t (id INT IDENTITY(1,1));").name,
    ).toBe("MSSQL");
  });

  it("heuristic: PRAGMA → SQLite", () => {
    expect(sqlDialectFor("/x/q.sql", "PRAGMA foreign_keys = ON;").name).toBe(
      "SQLite",
    );
  });

  it("fallback: plain SQL → StandardSQL", () => {
    expect(sqlDialectFor("/x/q.sql", "SELECT 1;").name).toBe("StandardSQL");
  });

  it("missing head defaults to StandardSQL for generic .sql", () => {
    expect(sqlDialectFor("/x/q.sql", "").name).toBe("StandardSQL");
  });
});
```

- [ ] **Step 2: Run tests, confirm failure**

```bash
npm test -- languages.test.ts
```

Expected: all tests fail with "sqlDialectFor is not exported / not a function".

---

## Task 3: Implement `sqlDialectFor` + register `.sql` family

**Files:**
- Modify: `ui/src/structure/languages.ts`

- [ ] **Step 1: Add SQL grammar import + helper**

Add near the top of `languages.ts` (after existing imports):

```ts
import { sql, StandardSQL, PostgreSQL, MySQL, MSSQL, SQLite } from "@codemirror/lang-sql";
import type { SQLDialect } from "@codemirror/lang-sql";

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
  const slice = head.slice(0, HEAD_HEURISTIC_BYTES);
  // Order matters: most specific first.
  if (/\bIDENTITY\s*\(/i.test(slice) || /\bNVARCHAR\b/i.test(slice) || /\n\s*GO\s*\n/i.test(slice)) {
    return "MSSQL";
  }
  if (/\bAUTO_INCREMENT\b/i.test(slice) || /`[A-Za-z0-9_]+`/.test(slice) || /\bENGINE\s*=/i.test(slice)) {
    return "MySQL";
  }
  if (/\bRETURNING\b/i.test(slice) || /\bSERIAL\b/i.test(slice) || /\bBIGSERIAL\b/i.test(slice) || /\$\$/.test(slice) || /\bILIKE\b/i.test(slice)) {
    return "PostgreSQL";
  }
  if (/\bPRAGMA\b/i.test(slice) || /\bAUTOINCREMENT\b/.test(slice) || /\bWITHOUT\s+ROWID\b/i.test(slice)) {
    return "SQLite";
  }
  return null;
}

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
```

- [ ] **Step 2: Wire SQL into `BY_EXT` and broaden `languageForPath`**

In `languages.ts`, leave existing `BY_EXT` entries alone and add SQL entries that consult the head. Change the exported `languageForPath` signature:

```ts
const SQL_EXTS = new Set(["sql", "psql", "mysql", "ddl", "dml"]);

export function languageForPath(path: string, head: string = ""): Extension | null {
  const base = path.split("/").pop() ?? "";

  const byName = BY_NAME[base];
  if (byName) return byName();

  if (base.startsWith(".") && /^\.(z|ba)shrc$|^\.profile$|^\.zprofile$/.test(base)) {
    return StreamLanguage.define(shell);
  }

  const dot = base.lastIndexOf(".");
  if (dot <= 0) return null;
  const ext = base.slice(dot + 1).toLowerCase();

  if (SQL_EXTS.has(ext)) {
    const spec = sqlDialectFor(path, head);
    return sql({ dialect: spec.dialect });
  }

  const factory = BY_EXT[ext];
  return factory ? factory() : null;
}
```

If the existing `languageForPath` already does extension lookup at the bottom, fold the SQL branch in place and keep the rest of the function intact. The behavior for non-SQL paths must not change.

- [ ] **Step 3: Run tests, confirm pass**

```bash
npm test -- languages.test.ts
```

Expected: all 11 tests pass.

- [ ] **Step 4: Commit**

```bash
git add ui/src/structure/languages.ts ui/src/structure/languages.test.ts
git commit -m "feat(editor): SQL highlighting with auto-detected dialect"
```

---

## Task 4: Wire dialect detection into editor open path

**Files:**
- Modify: `ui/src/structure/editor.ts`

- [ ] **Step 1: Locate `buildState` (used by `enterSource`)**

Run:

```bash
grep -n "languageForPath\|buildState" ui/src/structure/editor.ts
```

`buildState(path, text)` calls `languageForPath(path)`. We need it to pass a head slice for SQL detection. The simplest change: pass `text` itself — `sqlDialectFor` already only inspects the first 4 KB.

- [ ] **Step 2: Update the `languageForPath` call**

Change the single call site inside `buildState` from:

```ts
const lang = languageForPath(path);
```

to:

```ts
const lang = languageForPath(path, text);
```

No other change. Non-SQL paths ignore the second argument.

- [ ] **Step 3: Manual smoke test**

```bash
npm run dev
```

Open a `.sql` file with `RETURNING id` somewhere in the top 20 lines. Verify keywords are colored and the file looks SQL-tinted (the exact dialect isn't user-visible but the highlight should render). Open a file containing `AUTO_INCREMENT` and confirm it still highlights (MySQL grammar).

Stop the dev server.

- [ ] **Step 4: Commit**

```bash
git add ui/src/structure/editor.ts
git commit -m "feat(editor): pass file head to languageForPath for SQL dialect detection"
```

---

## Task 5: Register `xlsx` preview kind — failing test first

**Files:**
- Modify: `ui/src/structure/preview.ts`
- Create: `ui/src/structure/preview.test.ts`

- [ ] **Step 1: Write the failing test for `previewKindForPath`**

```ts
// ui/src/structure/preview.test.ts
import { describe, it, expect } from "vitest";
import { previewKindForPath } from "./preview";

describe("previewKindForPath xlsx coverage", () => {
  it.each(["xlsx", "xls", "xlsm", "ods"])("returns 'xlsx' for .%s", (ext) => {
    expect(previewKindForPath(`/x/file.${ext}`)).toBe("xlsx");
  });

  it("still returns 'png' for image files", () => {
    expect(previewKindForPath("/x/photo.png")).toBe("png");
  });

  it("returns null for unsupported types", () => {
    expect(previewKindForPath("/x/code.rs")).toBeNull();
  });
});
```

- [ ] **Step 2: Run, confirm failure**

```bash
npm test -- preview.test.ts
```

Expected: the `xlsx`/`xls`/`xlsm`/`ods` cases fail (return `null`).

- [ ] **Step 3: Extend `PreviewKind` + `previewKindForPath`**

In `preview.ts`:

```ts
export type PreviewKind = "markdown" | "svg" | "png" | "html" | "xlsx";
```

Inside `previewKindForPath`, before the final `return null;`:

```ts
if (ext === "xlsx" || ext === "xls" || ext === "xlsm" || ext === "ods") {
  return "xlsx";
}
```

- [ ] **Step 4: Run, confirm pass**

```bash
npm test -- preview.test.ts
```

Expected: all 6 cases pass.

- [ ] **Step 5: Commit**

```bash
git add ui/src/structure/preview.ts ui/src/structure/preview.test.ts
git commit -m "feat(editor): register xlsx preview kind"
```

---

## Task 6: `XlsxPreview` — single sheet rendering (TDD)

**Files:**
- Modify: `ui/src/structure/preview.ts`
- Modify: `ui/src/structure/preview.test.ts`

The interface stays `mount(host, content: string)` — bytes are passed as `JSON.stringify(Array.from(uint8))` exactly like `PngPreview`.

- [ ] **Step 1: Append failing test for single-sheet render**

Add to `preview.test.ts`:

```ts
import { XlsxPreview } from "./preview";
import * as XLSX from "xlsx";

function fixtureBytes(): string {
  const wb = XLSX.utils.book_new();
  const ws1 = XLSX.utils.aoa_to_sheet([
    ["name", "qty"],
    ["apples", 3],
    ["pears", 5],
  ]);
  XLSX.utils.book_append_sheet(wb, ws1, "Inventory");
  const ws2 = XLSX.utils.aoa_to_sheet([["greeting"], ["hello"]]);
  XLSX.utils.book_append_sheet(wb, ws2, "Notes");
  const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as Uint8Array;
  return JSON.stringify(Array.from(buf));
}

describe("XlsxPreview", () => {
  it("renders the first sheet's cells", async () => {
    const host = document.createElement("div");
    const p = new XlsxPreview();
    p.mount(host, fixtureBytes());
    // SheetJS load is async (dynamic import). Poll briefly.
    await new Promise((r) => setTimeout(r, 50));
    expect(host.textContent).toContain("apples");
    expect(host.textContent).toContain("pears");
    p.dispose();
  });

  it("exposes both sheet names as tabs", async () => {
    const host = document.createElement("div");
    const p = new XlsxPreview();
    p.mount(host, fixtureBytes());
    await new Promise((r) => setTimeout(r, 50));
    const tabs = host.querySelectorAll(".structure-preview-xlsx-tab");
    const names = Array.from(tabs).map((t) => t.textContent);
    expect(names).toEqual(["Inventory", "Notes"]);
    p.dispose();
  });

  it("switches sheet when a tab is clicked", async () => {
    const host = document.createElement("div");
    const p = new XlsxPreview();
    p.mount(host, fixtureBytes());
    await new Promise((r) => setTimeout(r, 50));
    const notesTab = Array.from(
      host.querySelectorAll<HTMLElement>(".structure-preview-xlsx-tab"),
    ).find((t) => t.textContent === "Notes")!;
    notesTab.click();
    await new Promise((r) => setTimeout(r, 10));
    expect(host.textContent).toContain("hello");
    expect(host.textContent).not.toContain("apples");
    p.dispose();
  });

  it("renders a placeholder when payload exceeds the size guard", () => {
    const host = document.createElement("div");
    const p = new XlsxPreview();
    // 26 MB of nothing — placeholder path doesn't even parse.
    const fakeHugeBytes = JSON.stringify(new Array(26 * 1024 * 1024).fill(0));
    p.mount(host, fakeHugeBytes);
    expect(host.textContent?.toLowerCase()).toContain("demasiado grande");
    p.dispose();
  });
});
```

- [ ] **Step 2: Run, confirm failure**

```bash
npm test -- preview.test.ts
```

Expected: new `XlsxPreview` cases fail with "XlsxPreview is not exported".

- [ ] **Step 3: Implement `XlsxPreview`**

Append to `preview.ts`:

```ts
const XLSX_MAX_BYTES = 25 * 1024 * 1024;

export class XlsxPreview implements Preview {
  private host: HTMLElement | null = null;
  private tabsEl: HTMLElement | null = null;
  private gridEl: HTMLElement | null = null;
  private workbook: unknown | null = null;
  private activeSheet: string | null = null;
  private disposed = false;

  mount(host: HTMLElement, content: string): void {
    this.host = host;
    host.innerHTML = "";
    const root = document.createElement("div");
    root.className = "structure-preview-xlsx";
    this.tabsEl = document.createElement("div");
    this.tabsEl.className = "structure-preview-xlsx-tabs";
    this.gridEl = document.createElement("div");
    this.gridEl.className = "structure-preview-xlsx-grid";
    root.appendChild(this.tabsEl);
    root.appendChild(this.gridEl);
    host.appendChild(root);

    const bytes = decodeBytes(content);
    if (!bytes) {
      this.renderPlaceholder("No se pudieron leer los bytes del archivo.");
      return;
    }
    if (bytes.length > XLSX_MAX_BYTES) {
      this.renderPlaceholder(
        `Archivo demasiado grande para previsualizar (${formatMB(bytes.length)}).`,
      );
      return;
    }

    // Dynamic import keeps SheetJS out of the initial bundle.
    import("xlsx").then((XLSX) => {
      if (this.disposed) return;
      try {
        const wb = XLSX.read(bytes, { type: "array" });
        this.workbook = wb;
        const names: string[] = wb.SheetNames;
        if (names.length === 0) {
          this.renderPlaceholder("Workbook vacío.");
          return;
        }
        this.activeSheet = names[0];
        this.renderTabs(names);
        this.renderActiveSheet(XLSX);
      } catch (err) {
        this.renderPlaceholder(`Error parseando XLSX: ${err}`);
      }
    });
  }

  update(host: HTMLElement, content: string): void {
    this.mount(host, content);
  }

  dispose(): void {
    this.disposed = true;
    this.host = null;
    this.tabsEl = null;
    this.gridEl = null;
    this.workbook = null;
    this.activeSheet = null;
  }

  private renderPlaceholder(msg: string): void {
    if (!this.host) return;
    this.host.innerHTML = `<div class="structure-preview-xlsx-placeholder">${escapeHtml(msg)}</div>`;
  }

  private renderTabs(names: string[]): void {
    if (!this.tabsEl) return;
    this.tabsEl.innerHTML = "";
    if (names.length <= 1) {
      this.tabsEl.hidden = true;
      return;
    }
    this.tabsEl.hidden = false;
    for (const name of names) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "structure-preview-xlsx-tab";
      if (name === this.activeSheet) btn.classList.add("active");
      btn.textContent = name;
      btn.addEventListener("click", () => {
        if (name === this.activeSheet) return;
        this.activeSheet = name;
        for (const el of this.tabsEl!.querySelectorAll(".structure-preview-xlsx-tab")) {
          el.classList.toggle("active", el.textContent === name);
        }
        import("xlsx").then((XLSX) => {
          if (!this.disposed) this.renderActiveSheet(XLSX);
        });
      });
      this.tabsEl.appendChild(btn);
    }
  }

  private renderActiveSheet(XLSX: typeof import("xlsx")): void {
    if (!this.gridEl || !this.workbook || !this.activeSheet) return;
    const wb = this.workbook as import("xlsx").WorkBook;
    const sheet = wb.Sheets[this.activeSheet];
    if (!sheet) {
      this.gridEl.innerHTML = "";
      return;
    }
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      raw: false,
      defval: "",
    });
    const table = document.createElement("table");
    table.className = "structure-preview-xlsx-table";
    const tbody = document.createElement("tbody");
    const limit = Math.min(rows.length, 500);
    for (let r = 0; r < limit; r++) {
      const tr = document.createElement("tr");
      const row = rows[r] ?? [];
      for (let c = 0; c < row.length; c++) {
        const cell = document.createElement(r === 0 ? "th" : "td");
        cell.textContent = String(row[c] ?? "");
        tr.appendChild(cell);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    this.gridEl.innerHTML = "";
    this.gridEl.appendChild(table);
    if (rows.length > limit) {
      const more = document.createElement("div");
      more.className = "structure-preview-xlsx-more";
      more.textContent = `… ${rows.length - limit} filas más no mostradas`;
      this.gridEl.appendChild(more);
    }
  }
}

function decodeBytes(content: string): Uint8Array | null {
  try {
    const arr = JSON.parse(content) as number[];
    if (!Array.isArray(arr)) return null;
    return Uint8Array.from(arr);
  } catch {
    return null;
  }
}

function formatMB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}
```

- [ ] **Step 4: Register `"xlsx"` in the factory used by `editor.ts`**

Locate the preview factory (search `grep -n "case \"png\"" ui/src/structure/preview.ts` or wherever `makePreview` lives — could be at the bottom of `preview.ts`). Add:

```ts
case "xlsx": return new XlsxPreview();
```

If a factory does not exist and `editor.ts` instantiates previews inline, instead export `XlsxPreview` (already done) and add the case to whatever switch matches `previewKind` inside `editor.ts`.

- [ ] **Step 5: Run tests**

```bash
npm test -- preview.test.ts
```

Expected: all `XlsxPreview` tests pass. If the size-guard test is slow due to the giant array, lower the constant to make the assertion testable (e.g., introduce a private static `MAX_BYTES` and inject in test) — but only if needed; a 26 MB array allocation is acceptable in a vitest run.

- [ ] **Step 6: Commit**

```bash
git add ui/src/structure/preview.ts ui/src/structure/preview.test.ts
git commit -m "feat(editor): XlsxPreview with multi-sheet tabs and size guard"
```

---

## Task 7: Editor open path — binary load + xlsx mount

**Files:**
- Modify: `ui/src/structure/editor.ts`

The editor already has `openImage(path)` for PNG. Generalize for xlsx by reusing `structureReadBinaryFile`.

- [ ] **Step 1: Branch xlsx into the binary-read path**

Replace the existing PNG check inside `open()`:

```ts
if (previewKindForPath(path) === "png") {
  await this.openImage(path);
  return;
}
```

with:

```ts
const kind = previewKindForPath(path);
if (kind === "png" || kind === "xlsx") {
  await this.openBinary(path, kind);
  return;
}
```

- [ ] **Step 2: Rename + generalize `openImage` to `openBinary`**

Update the method (the diff vs. current `openImage`):

```ts
private async openBinary(path: string, kind: "png" | "xlsx"): Promise<void> {
  let result;
  try {
    result = await structureReadBinaryFile(path);
  } catch (err) {
    this.showPlaceholder(`Failed to read file: ${err}`);
    return;
  }
  if (result.kind === "too_large") {
    this.showPlaceholder(
      `File too large to preview (${formatBytes(result.size_bytes)}).`,
    );
    return;
  }

  if (this.view) { this.view.destroy(); this.view = null; }
  if (this.currentPreview) { this.currentPreview.dispose(); this.currentPreview = null; }
  this.previewHostEl.innerHTML = "";

  this.previewKind = kind;
  this.viewMode = "preview";
  this.editorHostEl.hidden = true;
  this.previewHostEl.hidden = false;
  this.placeholderEl.hidden = true;
  this.originalContent = null;
  this.liveContent = "";
  this.dirty = false;

  this.currentPreview = makePreview(kind);
  this.currentPreview.mount(this.previewHostEl, JSON.stringify(result.bytes));

  this.refreshPreviewButton();
  this.renderStatus();
}
```

- [ ] **Step 3: Suppress source toggle + PNG-export button for xlsx**

Find these guards and extend them:

```ts
// toggleViewMode (was: if (this.previewKind === "png") return;)
if (this.previewKind === "png" || this.previewKind === "xlsx") return;
```

For `refreshPreviewButton` / PNG export button visibility: confirm the existing logic only shows `pngBtn` / `pngScaleSelect` when `previewKind === "svg"`. If the toggle button also surfaces for xlsx, hide it the same way PNG does (the existing code likely already handles this since toggleViewMode no-ops; verify the button is visually absent — if not, gate `previewBtn.hidden = false` on `previewKind !== "png" && previewKind !== "xlsx"`).

- [ ] **Step 4: Manual smoke test**

```bash
npm run dev
```

Open a `.xlsx` file with two sheets. Verify:
- Grid renders.
- Sheet tabs visible; clicking switches sheets.
- No source/preview toggle button visible.
- PNG export button hidden.

Open a regular `.rs` file afterwards — confirm normal source mode still works.

Stop the dev server.

- [ ] **Step 5: Commit**

```bash
git add ui/src/structure/editor.ts
git commit -m "feat(editor): wire xlsx preview through binary-read path"
```

---

## Task 8: Styles

**Files:**
- Modify: `ui/src/styles.css`

- [ ] **Step 1: Add xlsx preview styles**

Append (placement: near other `.structure-preview-*` blocks — `grep -n "structure-preview-md" ui/src/styles.css` to find them):

```css
.structure-preview-xlsx {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  font: 12px/1.4 ui-monospace, "SF Mono", Menlo, monospace;
}

.structure-preview-xlsx-tabs {
  display: flex;
  gap: 4px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border, #2a2a2a);
  overflow-x: auto;
  flex: 0 0 auto;
}

.structure-preview-xlsx-tab {
  appearance: none;
  background: transparent;
  border: 1px solid var(--border, #2a2a2a);
  border-radius: 6px;
  padding: 2px 10px;
  font: inherit;
  color: inherit;
  cursor: pointer;
  white-space: nowrap;
}

.structure-preview-xlsx-tab.active {
  background: var(--chip-active-bg, rgba(255,255,255,0.08));
  border-color: var(--chip-active-border, rgba(255,255,255,0.2));
}

.structure-preview-xlsx-grid {
  flex: 1 1 auto;
  overflow: auto;
  padding: 8px;
}

.structure-preview-xlsx-table {
  border-collapse: collapse;
  min-width: 100%;
}

.structure-preview-xlsx-table th,
.structure-preview-xlsx-table td {
  border: 1px solid var(--border, #2a2a2a);
  padding: 2px 6px;
  text-align: left;
  vertical-align: top;
  white-space: pre;
}

.structure-preview-xlsx-table th {
  background: var(--row-alt-bg, rgba(255,255,255,0.04));
  font-weight: 600;
}

.structure-preview-xlsx-more {
  padding: 6px 4px;
  opacity: 0.6;
  font-style: italic;
}

.structure-preview-xlsx-placeholder {
  padding: 16px;
  opacity: 0.7;
}
```

If the codebase uses different CSS variable names (check `grep -n "^--" ui/src/styles.css` near the top), substitute the actual variable names. Don't add new variables.

- [ ] **Step 2: Manual visual check**

```bash
npm run dev
```

Open the same `.xlsx`. Confirm tabs and grid render with consistent styling (no obvious clashes with the rest of the editor chrome).

Stop the dev server.

- [ ] **Step 3: Commit**

```bash
git add ui/src/styles.css
git commit -m "style(editor): xlsx preview tabs + grid"
```

---

## Task 9: Final verification

- [ ] **Step 1: Full test suite**

```bash
npm test
```

Expected: all tests green, including new SQL + XLSX cases.

- [ ] **Step 2: Type-check + build**

```bash
npm run build
```

Expected: clean build, no TS errors.

- [ ] **Step 3: Sanity smoke**

```bash
npm run dev
```

Open in order:
- A `.sql` file with a `-- dialect: postgres` marker — colors visible.
- A `.psql` file — colors visible.
- A `.xlsx` with two sheets — tabs work, switching sheets works.
- A `.rs` file — source mode unchanged.
- A `.png` — still opens via image preview.

Stop the dev server.

- [ ] **Step 4: Final commit gate**

If everything passes, the branch is ready for merge / PR per the standard `superpowers:finishing-a-development-branch` flow.

---

## Risks & Notes

- **SheetJS bundle weight (~400 KB).** Lazy `import("xlsx")` keeps it out of the initial chunk. Confirm with `npm run build && ls -lh dist/assets/` that the main bundle did not grow disproportionately.
- **Vitest jsdom environment.** Make sure `vitest.config.ts` (or top-level `test.environment`) is `jsdom` for the DOM-touching XlsxPreview tests. If not, prepend `// @vitest-environment jsdom` to `preview.test.ts`.
- **Large workbook payloads.** The 25 MB cap is a hard floor; users hitting it see a placeholder rather than a frozen UI.
- **Dialect heuristic false positives.** Worst case is wrong syntax color — `-- dialect:` marker is the explicit override.
