import { describe, it, expect } from "vitest";
import { renderDiffBody } from "./diff-view";
import type { FileDiff } from "../api";

const hunkFile: FileDiff = {
  path: "f.txt", oldPath: null,
  body: { kind: "hunks", hunks: [{
    oldStart: 1, newStart: 1, header: "",
    lines: [
      { kind: "context", oldNo: 1, newNo: 1, text: "ctx" },
      { kind: "del", oldNo: 2, newNo: null, text: "old" },
      { kind: "add", oldNo: null, newNo: 2, text: "new" },
    ],
  }] },
};

describe("renderDiffBody", () => {
  it("renders one row per diff line with kind classes", () => {
    const el = renderDiffBody(hunkFile);
    expect(el.querySelectorAll(".cd-line").length).toBe(3);
    expect(el.querySelector(".cd-line--add")?.textContent).toContain("new");
    expect(el.querySelector(".cd-line--del")?.textContent).toContain("old");
  });

  it("shows old/new line numbers in the gutter", () => {
    const el = renderDiffBody(hunkFile);
    const ctx = el.querySelector(".cd-line--context")!;
    expect(ctx.querySelector(".cd-num-old")?.textContent).toBe("1");
    expect(ctx.querySelector(".cd-num-new")?.textContent).toBe("1");
  });

  it("renders a binary placeholder", () => {
    const el = renderDiffBody({ path: "x.bmp", oldPath: null, body: { kind: "binary", sizeBytes: 12000 } });
    expect(el.querySelector(".cd-binary")?.textContent).toMatch(/binary/i);
  });

  it("renders a too-large notice", () => {
    const el = renderDiffBody({ path: "big.txt", oldPath: null, body: { kind: "tooLarge", lineCount: 9000 } });
    expect(el.querySelector(".cd-toolarge")?.textContent).toMatch(/9000/);
  });
});
