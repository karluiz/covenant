// @vitest-environment node
import { describe, it, expect } from "vitest";
import { sessionHintsFromTabs, type HintTab } from "./hints";

const tab = (over: Partial<HintTab>): HintTab => ({
  panes: [{ sessionId: "s1" }],
  defaultTitle: "zsh 1",
  customName: null,
  color: null,
  groupId: null,
  ...over,
});

const bare = { group: null, groupId: null, supervisor: null };

describe("sessionHintsFromTabs", () => {
  it("emits one hint per shell tab using defaultTitle", () => {
    expect(sessionHintsFromTabs([tab({})])).toEqual([
      { sessionId: "s1", title: "zsh 1", color: null, ...bare },
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

  it("resolves the tab's group via the group map; unknown ids stay ungrouped", () => {
    const out = sessionHintsFromTabs(
      [
        tab({ groupId: "g1" }),
        tab({ panes: [{ sessionId: "s2" }], groupId: "gX" }),
        tab({ panes: [{ sessionId: "s3" }] }),
      ],
      new Map([["g1", { name: "covenant", supervisorId: null, supervisorIntervene: false }]]),
    );
    expect(out.map((h) => h.group)).toEqual(["covenant", null, null]);
    // An unresolvable id must not become a bucket key — it would render a
    // header with no name.
    expect(out.map((h) => h.groupId)).toEqual(["g1", null, null]);
  });

  it("carries the group's attached supervisor onto every member hint", () => {
    const out = sessionHintsFromTabs(
      [tab({ panes: [{ sessionId: "a" }, { sessionId: "b" }], groupId: "g1" })],
      new Map([["g1", { name: "covenant", supervisorId: "op-7", supervisorIntervene: true }]]),
    );
    expect(out.map((h) => h.supervisor)).toEqual([
      { operatorId: "op-7", intervene: true },
      { operatorId: "op-7", intervene: true },
    ]);
  });

  it("leaves supervisor null for a group with no supervisor attached", () => {
    const out = sessionHintsFromTabs(
      [tab({ groupId: "g1" })],
      new Map([["g1", { name: "covenant", supervisorId: null, supervisorIntervene: true }]]),
    );
    expect(out[0].supervisor).toBeNull();
  });

  it("emits a hint for acp panes using acpSessionId", () => {
    const out = sessionHintsFromTabs([
      tab({
        panes: [{ sessionId: null, acpSessionId: "acp-1" }],
        defaultTitle: "copilot chat",
        color: "#123456",
      }),
    ]);
    expect(out).toEqual([
      { sessionId: "acp-1", title: "copilot chat", color: "#123456", ...bare },
    ]);
  });
});
