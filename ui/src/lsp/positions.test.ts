import { describe, expect, it } from "vitest";
import { Text } from "@codemirror/state";
import { lspToOffset, offsetToLsp, pathToUri, uriToPath } from "./positions";

describe("positions", () => {
  const doc = Text.of(["fn main() {", "  let s = \"🦀 ok\";", "}"]);

  it("maps offset to LSP line/character (UTF-16)", () => {
    // offset of the `l` in `let` — line 1, after two spaces
    const off = doc.line(2).from + 2;
    expect(offsetToLsp(doc, off)).toEqual({ line: 1, character: 2 });
  });

  it("round-trips through emoji (2 UTF-16 units)", () => {
    const line2 = doc.line(2).text;
    const afterCrab = line2.indexOf("🦀") + 2; // crab = surrogate pair
    const off = doc.line(2).from + afterCrab;
    const lsp = offsetToLsp(doc, off);
    expect(lsp.character).toBe(afterCrab);
    expect(lspToOffset(doc, lsp)).toBe(off);
  });

  it("clamps out-of-range LSP positions", () => {
    expect(lspToOffset(doc, { line: 99, character: 0 })).toBe(doc.length);
    expect(lspToOffset(doc, { line: 0, character: 999 })).toBe(doc.line(1).to);
  });

  it("uri round-trip preserves spaces and unicode", () => {
    const p = "/Users/karluiz/My Projects/año/src/main.rs";
    expect(uriToPath(pathToUri(p))).toBe(p);
    expect(pathToUri(p)).toMatch(/^file:\/\//);
    expect(pathToUri(p)).not.toContain(" ");
  });
});
