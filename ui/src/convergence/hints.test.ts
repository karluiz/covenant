// @vitest-environment node
import { describe, it, expect } from "vitest";
import { sessionHintsFromTabs, type HintTab } from "./hints";

const tab = (over: Partial<HintTab>): HintTab => ({
  panes: [{ sessionId: "s1" }],
  defaultTitle: "zsh 1",
  customName: null,
  color: null,
  ...over,
});

describe("sessionHintsFromTabs", () => {
  it("emits one hint per shell tab using defaultTitle", () => {
    expect(sessionHintsFromTabs([tab({})])).toEqual([
      { sessionId: "s1", title: "zsh 1", color: null },
    ]);
  });

  it("prefers a trimmed customName over defaultTitle", () => {
    const out = sessionHintsFromTabs([tab({ customName: "  awareness  " })]);
    expect(out[0].title).toBe("awareness");
  });

  it("falls back to defaultTitle when customName is blank", () => {
    const out = sessionHintsFromTabs([tab({ customName: "   " })]);
    expect(out[0].title).toBe("zsh 1");
  });

  it("emits a hint for EACH pane of a split tab", () => {
    const out = sessionHintsFromTabs([
      tab({ panes: [{ sessionId: "a" }, { sessionId: "b" }], color: "#f00" }),
    ]);
    expect(out.map((h) => h.sessionId)).toEqual(["a", "b"]);
    expect(out.every((h) => h.color === "#f00")).toBe(true);
  });

  it("skips panes without a live session (e.g. browser panes)", () => {
    const out = sessionHintsFromTabs([
      tab({ panes: [{ sessionId: null }, { sessionId: "x" }] }),
    ]);
    expect(out.map((h) => h.sessionId)).toEqual(["x"]);
  });

  it("never yields an undefined session_id (the Phase-C regression)", () => {
    const out = sessionHintsFromTabs([tab({ panes: [{ sessionId: null }] })]);
    expect(out).toEqual([]);
  });
});
