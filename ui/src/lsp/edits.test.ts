import { describe, expect, it, vi } from "vitest";
import type { ReadResult } from "../api";
import {
  applyTextEdits,
  applyWorkspaceEdit,
  countFiles,
  type WorkspaceEdit,
  type WorkspaceEditHost,
} from "./edits";

vi.mock("../api", () => ({
  structureReadFile: vi.fn(),
  structureWriteFile: vi.fn(),
}));

describe("applyTextEdits", () => {
  it("applies a single edit", () => {
    const text = "hello world";
    const result = applyTextEdits(text, [
      { range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } }, newText: "there" },
    ]);
    expect(result).toBe("hello there");
  });

  it("returns the text unchanged when there are no edits", () => {
    expect(applyTextEdits("unchanged", [])).toBe("unchanged");
  });

  it("sorts out-of-order edits descending so earlier splices don't invalidate later offsets", () => {
    const text = "const a = 1;\nconst b = 2;\nconst c = 3;\n";
    // Edits supplied in ASCENDING doc order (line 0 first) — applyTextEdits
    // must sort descending internally, same ordering principle as the
    // incremental didChange sync in T3, or the line-0 splice would shift
    // the string indices computed for line 2.
    const edits = [
      { range: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } }, newText: "renamedA" },
      { range: { start: { line: 2, character: 6 }, end: { line: 2, character: 7 } }, newText: "renamedC" },
    ];
    expect(applyTextEdits(text, edits)).toBe(
      "const renamedA = 1;\nconst b = 2;\nconst renamedC = 3;\n",
    );
  });

  it("applies adjacent (touching, non-overlapping) edits correctly regardless of input order", () => {
    const text = "abcdefghij";
    const edits = [
      // supplied out of order: the later-in-document edit comes first
      { range: { start: { line: 0, character: 6 }, end: { line: 0, character: 8 } }, newText: "Z" },
      { range: { start: { line: 0, character: 2 }, end: { line: 0, character: 4 } }, newText: "XY" },
    ];
    expect(applyTextEdits(text, edits)).toBe("abXYefZij");
  });

  it("handles a pure insertion (zero-width range)", () => {
    const text = "ab";
    const result = applyTextEdits(text, [
      { range: { start: { line: 0, character: 1 }, end: { line: 0, character: 1 } }, newText: "X" },
    ]);
    expect(result).toBe("aXb");
  });
});

describe("applyWorkspaceEdit", () => {
  it("dispatches edits for the active uri through the host and counts files/edits", async () => {
    const applied: unknown[] = [];
    const host: WorkspaceEditHost = {
      activeUri: () => "file:///a.rs",
      applyToActiveView: (edits) => applied.push(edits),
    };
    const edit: WorkspaceEdit = {
      changes: {
        "file:///a.rs": [
          { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "x" },
        ],
      },
    };
    const result = await applyWorkspaceEdit(edit, host);
    expect(result).toEqual({ files: 1, edits: 1 });
    expect(applied).toHaveLength(1);
  });

  it("reads, edits, and writes non-active files via structure(Read|Write)File", async () => {
    const api = await import("../api");
    const readMock = vi.mocked(api.structureReadFile);
    const writeMock = vi.mocked(api.structureWriteFile);
    readMock.mockResolvedValue({ kind: "text", content: "let old = 1;\n", size_bytes: 13 } as ReadResult);
    writeMock.mockResolvedValue(undefined);

    const host: WorkspaceEditHost = {
      activeUri: () => "file:///active.rs", // not the file being edited
      applyToActiveView: vi.fn(),
    };
    const edit: WorkspaceEdit = {
      changes: {
        "file:///other.rs": [
          { range: { start: { line: 0, character: 4 }, end: { line: 0, character: 7 } }, newText: "renamed" },
        ],
      },
    };
    const result = await applyWorkspaceEdit(edit, host);
    expect(readMock).toHaveBeenCalledWith("/other.rs");
    expect(writeMock).toHaveBeenCalledWith("/other.rs", "let renamed = 1;\n");
    expect(result).toEqual({ files: 1, edits: 1 });
  });

  it("normalizes documentChanges into per-uri edits when changes is absent", async () => {
    const applied: unknown[] = [];
    const host: WorkspaceEditHost = {
      activeUri: () => "file:///a.rs",
      applyToActiveView: (edits) => applied.push(edits),
    };
    const edit: WorkspaceEdit = {
      documentChanges: [
        {
          textDocument: { uri: "file:///a.rs" },
          edits: [
            { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "x" },
          ],
        },
      ],
    };
    const result = await applyWorkspaceEdit(edit, host);
    expect(result).toEqual({ files: 1, edits: 1 });
    expect(applied).toHaveLength(1);
  });

  it("splits a multi-file edit between the active view and disk writes", async () => {
    const api = await import("../api");
    const readMock = vi.mocked(api.structureReadFile);
    const writeMock = vi.mocked(api.structureWriteFile);
    readMock.mockResolvedValue({ kind: "text", content: "fn old() {}\n", size_bytes: 12 } as ReadResult);
    writeMock.mockResolvedValue(undefined);

    const applied: unknown[] = [];
    const host: WorkspaceEditHost = {
      activeUri: () => "file:///active.rs",
      applyToActiveView: (edits) => applied.push(edits),
    };
    const edit: WorkspaceEdit = {
      changes: {
        "file:///active.rs": [
          { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "x" },
        ],
        "file:///disk.rs": [
          { range: { start: { line: 0, character: 3 }, end: { line: 0, character: 6 } }, newText: "renamed" },
        ],
      },
    };
    const result = await applyWorkspaceEdit(edit, host);
    expect(result).toEqual({ files: 2, edits: 2 });
    expect(applied).toHaveLength(1);
    expect(writeMock).toHaveBeenCalledWith("/disk.rs", "fn renamed() {}\n");
  });

  it("refuses to write a non-text (binary/too_large) file instead of coercing content to empty string", async () => {
    const api = await import("../api");
    const readMock = vi.mocked(api.structureReadFile);
    const writeMock = vi.mocked(api.structureWriteFile);
    readMock.mockReset();
    writeMock.mockReset();
    readMock.mockResolvedValue({ kind: "binary", content: null, size_bytes: 4096 } as ReadResult);

    const host: WorkspaceEditHost = {
      activeUri: () => "file:///active.rs",
      applyToActiveView: vi.fn(),
    };
    const edit: WorkspaceEdit = {
      changes: {
        "file:///image.png": [
          { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "x" },
        ],
      },
    };
    await expect(applyWorkspaceEdit(edit, host)).rejects.toThrow(/non-text file/);
    expect(writeMock).not.toHaveBeenCalled();
  });

  it("does not touch the active view when a disk write for another file fails first", async () => {
    const api = await import("../api");
    const readMock = vi.mocked(api.structureReadFile);
    const writeMock = vi.mocked(api.structureWriteFile);
    readMock.mockReset();
    writeMock.mockReset();
    readMock.mockResolvedValue({ kind: "too_large", content: null, size_bytes: 10_000_000 } as ReadResult);

    const applyToActiveView = vi.fn();
    const host: WorkspaceEditHost = {
      activeUri: () => "file:///active.rs",
      applyToActiveView,
    };
    const edit: WorkspaceEdit = {
      changes: {
        "file:///active.rs": [
          { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "x" },
        ],
        "file:///huge.bin": [
          { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "x" },
        ],
      },
    };
    await expect(applyWorkspaceEdit(edit, host)).rejects.toThrow(/non-text file/);
    expect(applyToActiveView).not.toHaveBeenCalled();
    expect(writeMock).not.toHaveBeenCalled();
  });
});

describe("countFiles", () => {
  it("matches the number of files applyWorkspaceEdit actually touches", () => {
    const edit: WorkspaceEdit = {
      changes: {
        "file:///a.rs": [
          { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "x" },
        ],
        "file:///b.rs": [
          { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "y" },
        ],
        "file:///empty.rs": [],
      },
    };
    expect(countFiles(edit)).toBe(2);
  });
});
