import { describe, it, expect, vi } from "vitest";
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

  it("renders no hunk action button without a HunkAction", () => {
    const el = renderDiffBody(hunkFile);
    expect(el.querySelector(".cd-hunk-stage")).toBeNull();
  });

  it("renders a per-hunk action button that fires with the hunk index", () => {
    const onAct = vi.fn();
    const two: FileDiff = {
      path: "f.txt", oldPath: null,
      body: { kind: "hunks", hunks: [
        { oldStart: 1, newStart: 1, header: "@@ -1 +1 @@", lines: [] },
        { oldStart: 9, newStart: 9, header: "", lines: [] },
      ] },
    };
    const el = renderDiffBody(two, { label: "Stage hunk", onAct });
    const btns = [...el.querySelectorAll<HTMLButtonElement>(".cd-hunk-stage")];
    expect(btns.length).toBe(2);
    expect(btns[0].textContent).toBe("Stage hunk");
    btns[1].click();
    expect(onAct).toHaveBeenCalledWith(1);
    // Headerless hunk still gets a synthesized @@ label so the button has a row.
    const labels = [...el.querySelectorAll(".cd-hunk-label")].map((l) => l.textContent);
    expect(labels[1]).toBe("@@ -9 +9 @@");
  });
});
