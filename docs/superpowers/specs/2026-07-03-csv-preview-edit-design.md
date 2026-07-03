# CSV table preview with in-place editing

**Date:** 2026-07-03 · **Status:** implemented

## Goal

`.csv` / `.tsv` files in the Structure editor get a Source / Preview toggle
like markdown/html, where Preview renders a spreadsheet-style table (same
chrome as the xlsx preview) with editable cells — like the xlsx view, but
writable, since CSV is text and round-trips.

## Design

- New `PreviewKind` `"csv"` on the existing **text** path (not the binary
  xlsx path). Source/preview toggle, per-extension view-mode preference,
  and find-in-preview are all inherited for free.
- `CsvPreview` (ui/src/structure/preview.ts) parses to a raw `string[][]`
  matrix and renders a table reusing `.structure-preview-xlsx-*` styles.
  First row is the header (`th`); every cell is
  `contenteditable="plaintext-only"`.
- **Not SheetJS**: an editable view must not re-format untouched cells
  (`3e-06` → `0.000003`, big-int precision loss). A ~50-line RFC 4180
  parser keeps cells as raw strings; the serializer quotes minimally.
  Values are preserved exactly; redundant quoting is normalized.
- Render cap: 500 rows (matches xlsx). The full matrix is retained, so an
  edit re-serializes the whole file including unrendered rows.
- Ragged rows are padded with virtual cells for display; they only
  materialize into the file when actually edited.
- EOL style (LF/CRLF) and trailing-newline presence are detected at mount
  and preserved on serialize. TSV uses a tab delimiter (by extension).

## Edit flow

Cell blur / Enter commits → `PreviewCtx.onEdit(fullText)` →
`StructureEditor.onPreviewEdit` updates `liveContent` + dirty badge.
⌘S is bound at the editor root for preview mode (the CM6 keymap doesn't
exist there) and blurs the in-flight cell before saving; the ⌘⇧P toggle
does the same blur-commit before snapshotting. Escape reverts the cell.

## Tests

`ui/src/structure/preview.test.ts`: parse/serialize round-trips (quotes,
embedded delimiters/newlines, CRLF, numeric-looking strings, trailing
newline), kind mapping, render cap + full-file serialization, unchanged
blur is a no-op, ragged-row padding semantics.
