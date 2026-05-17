import { describe, it, expect, beforeEach, vi } from "vitest";
import { StackStore } from "./store";

describe("StackStore", () => {
  const now = 1_000_000;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });

  const tab = (sid: string) => ({
    sessionId: sid,
    tabLabel: `tab ${sid}`,
    tabColor: "#7c5cff",
  });

  it("adds a pill on first event", () => {
    const s = new StackStore();
    s.apply({ ...tab("a"), phase: { kind: "thinking" } });
    expect(s.pills().length).toBe(1);
    expect(s.pills()[0].phase.kind).toBe("thinking");
  });

  it("expanded by default with <4 pills and recent state", () => {
    const s = new StackStore();
    s.apply({ ...tab("a"), phase: { kind: "thinking" } });
    expect(s.pills()[0].compact).toBe(false);
  });

  it("compacts when pills.length >= 4", () => {
    const s = new StackStore();
    ["a", "b", "c", "d"].forEach((id) =>
      s.apply({ ...tab(id), phase: { kind: "thinking" } }),
    );
    expect(s.pills().every((p) => p.compact)).toBe(true);
  });

  it("compacts when phase age > 5s", () => {
    const s = new StackStore();
    s.apply({ ...tab("a"), phase: { kind: "running", cmd: "ls" } });
    vi.setSystemTime(now + 6000);
    // recompute happens on apply/expandSticky/gc; trigger via gc.
    s.gc();
    expect(s.pills()[0].compact).toBe(true);
  });

  it("Waiting is always expanded", () => {
    const s = new StackStore();
    ["a", "b", "c", "d"].forEach((id) =>
      s.apply({ ...tab(id), phase: { kind: "thinking" } }),
    );
    s.apply({ ...tab("e"), phase: { kind: "waiting", reason: "y/N" } });
    const w = s.pills().find((p) => p.phase.kind === "waiting")!;
    expect(w.compact).toBe(false);
  });

  it("removes Done pill after 2.5s", () => {
    const s = new StackStore();
    s.apply({ ...tab("a"), phase: { kind: "done" } });
    vi.setSystemTime(now + 2600);
    s.gc();
    expect(s.pills().length).toBe(0);
  });
});
