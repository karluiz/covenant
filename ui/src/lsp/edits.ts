// WorkspaceEdit applier — shared by rename (this task) and code actions
// (T5). Two apply paths: the active-editor file goes through CM6
// `dispatch` (via `host`) so undo works and the buffer stays
// authoritative; every other file is read from / written to disk
// directly (structureReadFile/structureWriteFile from api.ts).
import { structureReadFile, structureWriteFile } from "../api";
import type { LspPosition } from "./positions";
import { uriToPath } from "./positions";

export interface LspEdit {
  range: { start: LspPosition; end: LspPosition };
  newText: string;
}

// rust-analyzer (and LSP servers generally) may return either `changes`
// (uri → edits, the common case) or `documentChanges` (an array of
// `{textDocument, edits}`, used when edits need versioning/create/rename
// file ops). P2 doesn't need the create/rename/delete resource
// operations documentChanges can also carry — only text edits — so we
// just flatten whichever shape the server sent into per-uri edit lists.
export interface WorkspaceEdit {
  changes?: Record<string, LspEdit[]>;
  documentChanges?: Array<{ textDocument: { uri: string }; edits: LspEdit[] }>;
}

export interface WorkspaceEditHost {
  /// uri of the file currently open in the active editor view, or null
  /// if nothing is open / it isn't an LSP-backed file.
  activeUri(): string | null;
  /// Dispatch `edits` (in original-document LSP coordinates) as CM6
  /// changes against the active view. The host owns the live `Text`
  /// doc, so it does the LSP→CM offset mapping itself.
  applyToActiveView(edits: LspEdit[]): void;
}

/// Pure splice: sort edits by start position DESCENDING and apply each
/// against `text` in that order, so an earlier (lower-offset) splice
/// never invalidates the string indices already computed for a later
/// one — same ordering principle as the incremental `didChange` sync.
export function applyTextEdits(text: string, edits: LspEdit[]): string {
  if (!edits.length) return text;
  const lineStarts = lineStartOffsets(text);
  const spans = edits
    .map((e) => ({
      from: posToStringOffset(lineStarts, text.length, e.range.start),
      to: posToStringOffset(lineStarts, text.length, e.range.end),
      newText: e.newText,
    }))
    .sort((a, b) => b.from - a.from || b.to - a.to);
  let result = text;
  for (const { from, to, newText } of spans) {
    result = result.slice(0, from) + newText + result.slice(to);
  }
  return result;
}

function lineStartOffsets(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

// Mirrors `lspToOffset` (positions.ts) but against a plain string
// instead of a CM6 `Text` — used here because non-active files are
// plain strings read from disk, not live editor documents.
function posToStringOffset(lineStarts: number[], textLength: number, pos: LspPosition): number {
  if (pos.line >= lineStarts.length) return textLength;
  const line = Math.max(0, pos.line);
  const lineStart = lineStarts[line];
  const lineEnd = line + 1 < lineStarts.length ? lineStarts[line + 1] - 1 : textLength;
  return Math.min(lineStart + Math.max(0, pos.character), lineEnd);
}

function editsByUri(edit: WorkspaceEdit): Record<string, LspEdit[]> {
  if (edit.changes) return edit.changes;
  if (edit.documentChanges) {
    const byUri: Record<string, LspEdit[]> = {};
    for (const dc of edit.documentChanges) {
      byUri[dc.textDocument.uri] = [...(byUri[dc.textDocument.uri] ?? []), ...dc.edits];
    }
    return byUri;
  }
  return {};
}

/// Apply a WorkspaceEdit across however many files it touches. The
/// active-editor uri is dispatched through `host` (CM6 changes, undo
/// preserved); every other uri is patched on disk via
/// structureReadFile → applyTextEdits → structureWriteFile. Returns
/// counts for the caller's confirmation UI.
export async function applyWorkspaceEdit(
  edit: WorkspaceEdit,
  host: WorkspaceEditHost,
): Promise<{ files: number; edits: number }> {
  const byUri = editsByUri(edit);
  const activeUri = host.activeUri();
  let files = 0;
  let editCount = 0;
  for (const [uri, uriEdits] of Object.entries(byUri)) {
    if (!uriEdits.length) continue;
    files++;
    editCount += uriEdits.length;
    if (uri === activeUri) {
      host.applyToActiveView(uriEdits);
    } else {
      const path = uriToPath(uri);
      const result = await structureReadFile(path);
      const text = result.content ?? "";
      const newText = applyTextEdits(text, uriEdits);
      await structureWriteFile(path, newText);
    }
  }
  return { files, edits: editCount };
}
