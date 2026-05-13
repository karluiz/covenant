# SQL highlighting + XLSX viewer

Status: design approved 2026-05-13.

Two additions to the StructureEditor (`ui/src/structure/`):

1. SQL syntax highlighting with auto-detected dialect.
2. Read-only XLSX viewer with multi-sheet tabs.

Both are scoped, additive, and follow existing patterns (CodeMirror language
registry for #1, `Preview` interface for #2).

---

## 1. SQL syntax highlighting

### Dependency

- Add `@codemirror/lang-sql` to `ui/package.json` (~25 KB, fits within the
  existing ~120 KB grammar budget documented in `languages.ts`).

### Extensions handled

- `.sql`, `.psql`, `.mysql`, `.ddl`, `.dml` → SQL.

### Dialect detection

Helper `sqlDialectFor(path: string, head: string): SQLDialectSpec` resolved in
this order (first match wins, fallback `StandardSQL`):

1. **Extension**
   - `.psql` → PostgreSQL
   - `.mysql` → MySQL
2. **Explicit marker** in the first ~20 lines:
   `-- dialect: postgres | mysql | sqlite | mssql | mariadb`
   (case-insensitive; whitespace tolerant).
3. **Heuristic** over the first ~4 KB of the file:
   - PostgreSQL: `SERIAL`, `BIGSERIAL`, `RETURNING`, `::` casts, `$$` quoting,
     `ILIKE`, `NOW()`.
   - MySQL/MariaDB: `AUTO_INCREMENT`, backtick-quoted identifiers,
     `ENGINE=`, `UNSIGNED`.
   - MSSQL: `IDENTITY(`, `TOP `, `NVARCHAR`, `[bracket]` identifiers, `GO\n`.
   - SQLite: `AUTOINCREMENT`, `PRAGMA `, `WITHOUT ROWID`.
4. Fallback: `StandardSQL`.

The function is pure and unit-testable. Detection runs once at file open;
re-runs only when the path changes (not on every edit).

### Integration

- `languages.ts` exposes `languageForPath(path, head?)`. The optional `head`
  argument lets the SQL branch consult the buffer. Non-SQL paths ignore it
  (backwards compatible — call sites that don't have content pass nothing).
- The editor passes the loaded text (sliced to 4 KB) when resolving language
  for `.sql`-family files.

### Tests

`ui/src/structure/languages.test.ts`:

- `.sql` plain → StandardSQL.
- `.psql` → PostgreSQL regardless of content.
- `.sql` with `AUTO_INCREMENT` → MySQL.
- `.sql` with `RETURNING` → PostgreSQL.
- `.sql` with `-- dialect: sqlite` marker → SQLite (marker beats heuristic).
- Marker on line 25 → ignored (out of header window).

---

## 2. XLSX viewer

### Dependency

- Add `xlsx` (SheetJS community) to `ui/package.json`.
- **Lazy-loaded** via dynamic `import("xlsx")` inside `XlsxPreview.mount`. The
  ~400 KB bundle never ships in the initial chunk; it's fetched the first
  time a user opens a spreadsheet.

### Extensions handled

- `.xlsx`, `.xls`, `.xlsm`, `.ods` → preview kind `"xlsx"`.
- CSV/TSV remain plain text (out of scope, can be added later).

### Preview interface change

Current:

```ts
interface Preview {
  mount(host: HTMLElement, content: string): void;
  update(host: HTMLElement, content: string): void;
  dispose(): void;
}
```

Updated to accept binary content:

```ts
type PreviewContent = string | Uint8Array;

interface Preview {
  mount(host: HTMLElement, content: PreviewContent): void;
  update(host: HTMLElement, content: PreviewContent): void;
  dispose(): void;
}
```

Existing previews (`MarkdownPreview`, `SvgPreview`, `HtmlPreview`,
`PngPreview`) keep accepting strings; they narrow at the top of `mount` and
ignore `Uint8Array`. PNG already loads bytes through a separate path; this
change is forward-only.

### Binary loading

`StructureEditor` already has a code branch that loads PNG bytes via Tauri
instead of `read_text_file`. The same branch handles xlsx:

- Source mode is disabled for `previewKind === "png" | "xlsx"`. The
  source/preview toggle is hidden (button stays hidden, same as PNG today).
- File contents are read as `Uint8Array` and passed to `XlsxPreview.mount`.

If `read_file_bytes` (or equivalent) doesn't exist yet, the plan step adds
it; otherwise reuse the PNG path verbatim.

### XlsxPreview rendering

```ts
class XlsxPreview implements Preview {
  private workbook: XLSX.WorkBook | null;
  private activeSheet: string;          // current sheet name
  private host: HTMLElement | null;
  // ...
}
```

Mount flow:

1. `const XLSX = await import("xlsx")`.
2. `read(content, { type: "array" })` → `WorkBook`.
3. Pick active sheet: stored pref for this path (see below) or
   `workbook.SheetNames[0]`.
4. Render header (sheet tabs) + grid.

### UI

- **Header (sheet tabs):** horizontal chip row, reuses the existing chip
  styles (`.chip`-family classes already present in `styles.css`). Active
  tab is highlighted. Hidden when the workbook has a single sheet.
- **Grid:** plain HTML `<table>` with two header strips (`A B C…` columns,
  `1 2 3…` rows). Cell text uses `cell.w` (SheetJS's formatted string) when
  available, falling back to `String(cell.v)`. Empty cells render as blanks
  with a faint border.
- **Virtualization:** chunked rendering — render first 500 rows immediately,
  append further chunks on scroll via `IntersectionObserver` on a sentinel
  row. No virtualization library.
- **Size guard:** if file > 25 MB, render a placeholder (`Archivo
  demasiado grande para previsualizar`) with byte count instead of parsing.
- **Find bar:** the editor already has an in-preview find bar covering
  markdown/svg. Xlsx joins that path: a case-insensitive substring search
  over `cell.w` of the active sheet, highlighting matching cells (`<mark>`
  inside the cell). Match navigation reuses the existing prev/next buttons.

### Per-path sheet preference

- LocalStorage key: `covenant.editor.xlsx-sheet-by-path`.
- Shape: `{ [absolutePath: string]: string }` (sheet name).
- Optional UX polish; skip in MVP if it complicates the plan.

### Disposal

`dispose()` clears `workbook`, removes the IntersectionObserver, drops the
host reference.

### Tests

Manual smoke + a small unit test of `XlsxPreview` against a fixture
workbook (two sheets, mixed types, one date) verifying:

- Both sheet names appear as tabs.
- Switching tab swaps the rendered table.
- Date cell uses `cell.w` (formatted).
- File > 25 MB shows placeholder.

---

## Files touched

- `ui/package.json` — add `@codemirror/lang-sql`, `xlsx`.
- `ui/src/structure/languages.ts` — SQL mapping + `sqlDialectFor`.
- `ui/src/structure/languages.test.ts` — new tests.
- `ui/src/structure/preview.ts` — `PreviewContent` type, `XlsxPreview`,
  `xlsx` branch in `previewKindForPath`.
- `ui/src/structure/editor.ts` — binary-load branch covers xlsx; hide
  source toggle for xlsx; pass `head` to `languageForPath` for SQL.
- `ui/src/styles.css` — `.structure-preview-xlsx` (table, sheet tabs,
  scroll container).

## Out of scope

- Cell editing / saving.
- CSV/TSV grid (still rendered as text).
- Formula evaluation beyond what SheetJS already provides.
- Column resizing, sort, filter — read-only viewer only.
- Export to PNG / image (button stays hidden for xlsx).

## Risks

- **SheetJS bundle weight (~400 KB).** Mitigated by dynamic import; cost
  paid only by users who open spreadsheets.
- **Large workbooks.** Hard 25 MB cap on parsing; chunked render handles
  long sheets gracefully.
- **Dialect heuristic false positives.** Worst case is wrong syntax color
  on edge files. The explicit `-- dialect:` marker is the escape hatch.
