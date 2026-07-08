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

export function editsByUri(edit: WorkspaceEdit): Record<string, LspEdit[]> {
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

/// Number of files a WorkspaceEdit touches (uris with at least one
/// edit). Shared by the confirm-dialog count (cm6.ts) and
/// `applyWorkspaceEdit` below so the two can never diverge.
export function countFiles(edit: WorkspaceEdit): number {
  return Object.values(editsByUri(edit)).filter((edits) => edits.length > 0).length;
}

/// Apply a WorkspaceEdit across however many files it touches. The
/// active-editor uri is dispatched through `host` (CM6 changes, undo
/// preserved); every other uri is patched on disk via
/// structureReadFile → applyTextEdits → structureWriteFile. Returns
/// counts for the caller's confirmation UI.
///
/// Ordering: disk files are read/written BEFORE the active view is
/// touched. structureReadFile/structureWriteFile can throw (see the
/// non-text guard below); doing all disk work first means a failure
/// there aborts the whole rename before the live CM6 buffer — which
/// has no rollback here — is ever changed.
///
/// ponytail: no cross-file rollback in P2 — a mid-apply failure leaves
/// earlier disk files edited; surfaced to the user (the throw
/// propagates to commitRename's try/finally), full transactionality if
/// it proves needed.
export async function applyWorkspaceEdit(
  edit: WorkspaceEdit,
  host: WorkspaceEditHost,
): Promise<{ files: number; edits: number }> {
  const byUri = editsByUri(edit);
  const activeUri = host.activeUri();
  const files = countFiles(edit);
  let editCount = 0;
  let activeEdits: LspEdit[] | null = null;
  for (const [uri, uriEdits] of Object.entries(byUri)) {
    if (!uriEdits.length) continue;
    editCount += uriEdits.length;
    if (uri === activeUri) {
      activeEdits = uriEdits;
      continue;
    }
    const path = uriToPath(uri);
    const result = await structureReadFile(path);
    if (result.kind !== "text" || result.content == null) {
      throw new Error(`cannot apply rename to non-text file: ${path}`);
    }
    const newText = applyTextEdits(result.content, uriEdits);
    await structureWriteFile(path, newText);
  }
  if (activeEdits) host.applyToActiveView(activeEdits);
  return { files, edits: editCount };
}
