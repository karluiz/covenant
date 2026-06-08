import { describe, it, expect, vi } from "vitest";

// Stub the Milkdown kit so boot() never touches real ProseMirror in jsdom.
vi.mock("@milkdown/kit/core", () => ({
  Editor: { make: () => { throw new Error("boot-disabled-in-test"); } },
  rootCtx: Symbol("rootCtx"),
  defaultValueCtx: Symbol("defaultValueCtx"),
  editorViewOptionsCtx: Symbol("editorViewOptionsCtx"),
}));
vi.mock("@milkdown/kit/preset/commonmark", () => ({ commonmark: {} }));
vi.mock("@milkdown/kit/plugin/listener", () => ({ listener: {}, listenerCtx: Symbol("listenerCtx") }));
vi.mock("@milkdown/kit/utils", () => ({ getMarkdown: () => () => "", replaceAll: () => () => {} }));

import { MarkdownEditor } from "./markdown-editor";

describe("MarkdownEditor wrapper contract", () => {
  it("creates a mountable element with mode + className", () => {
    const ed = new MarkdownEditor({ value: "hi", mode: "inline", className: "x" });
    expect(ed.element.tagName).toBe("DIV");
    expect(ed.element.classList.contains("md-editor")).toBe(true);
    expect(ed.element.classList.contains("md-editor--inline")).toBe(true);
    expect(ed.element.classList.contains("x")).toBe(true);
  });

  it("defaults to full mode and stores placeholder", () => {
    const ed = new MarkdownEditor({ placeholder: "Write…" });
    expect(ed.element.classList.contains("md-editor--full")).toBe(true);
    expect(ed.element.dataset.placeholder).toBe("Write…");
  });

  it("returns the buffered value before the editor boots", () => {
    const ed = new MarkdownEditor({ value: "## seed" });
    expect(ed.value).toBe("## seed");
  });

  it("buffers value writes made before boot", () => {
    const ed = new MarkdownEditor({ value: "a" });
    ed.value = "b";
    expect(ed.value).toBe("b");
  });

  it("destroy before boot is safe and idempotent", () => {
    const ed = new MarkdownEditor({ value: "a" });
    expect(() => { ed.destroy(); ed.destroy(); }).not.toThrow();
  });
});
