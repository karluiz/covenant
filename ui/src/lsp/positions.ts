// LSP positions are 0-based (line, UTF-16 character). CM6 offsets are
// document-wide UTF-16 offsets (JS strings), so per-line arithmetic on
// `Text.line` is exact — no encoding conversion needed.
import type { Text } from "@codemirror/state";

export interface LspPosition {
  line: number;
  character: number;
}

export function offsetToLsp(doc: Text, offset: number): LspPosition {
  const clamped = Math.max(0, Math.min(offset, doc.length));
  const line = doc.lineAt(clamped);
  return { line: line.number - 1, character: clamped - line.from };
}

export function lspToOffset(doc: Text, pos: LspPosition): number {
  if (pos.line >= doc.lines) return doc.length;
  const line = doc.line(Math.max(0, pos.line) + 1);
  return Math.min(line.from + Math.max(0, pos.character), line.to);
}

export function pathToUri(path: string): string {
  return "file://" + path.split("/").map(encodeURIComponent).join("/");
}

export function uriToPath(uri: string): string {
  const stripped = uri.replace(/^file:\/\//, "");
  return stripped.split("/").map(decodeURIComponent).join("/");
}
