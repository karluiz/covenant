import { describe, it, expect, vi } from "vitest";
import { findMentions, type MentionSourcesDeps } from "./mention-sources";

const deps = (over: Partial<MentionSourcesDeps> = {}): MentionSourcesDeps => ({
  findFiles:          vi.fn().mockResolvedValue([]),
  listOperators:      vi.fn().mockResolvedValue([]),
  listOpenSessions:   vi.fn().mockReturnValue([]),
  findRecentCommands: vi.fn().mockResolvedValue([]),
  ...over,
});

describe("findMentions", () => {
  it("returns interleaved top-3-per-source on 'all' tab", async () => {
    const d = deps({
      findFiles: vi.fn().mockResolvedValue([
        { path: "/a/x.ts", rel_path: "x.ts", match_indices: [] },
        { path: "/a/y.ts", rel_path: "y.ts", match_indices: [] },
        { path: "/a/z.ts", rel_path: "z.ts", match_indices: [] },
        { path: "/a/w.ts", rel_path: "w.ts", match_indices: [] },
      ]),
      listOperators: vi.fn().mockResolvedValue([
        { id: "op1", name: "claude", emoji: "", color: "", tags: [], persona: "",
          escalate_threshold: 0, model: "", hard_constraints: "", voice: "neutral",
          is_default: true, created_at_unix_ms: 0, updated_at_unix_ms: 0, xp: 0 },
      ]),
    });
    const hits = await findMentions({ query: "", cwd: "/a", activeTab: "all", limit: 12, deps: d });
    expect(hits.filter(h => h.kind === "files").length).toBe(3);
    expect(hits.some(h => h.kind === "teammates")).toBe(true);
  });

  it("scoped tab returns only that source, up to limit", async () => {
    const d = deps({
      findFiles: vi.fn().mockResolvedValue(
        Array.from({ length: 10 }, (_, i) => ({ path: `/a/${i}.ts`, rel_path: `${i}.ts`, match_indices: [] })),
      ),
    });
    const hits = await findMentions({ query: "", cwd: "/a", activeTab: "files", limit: 12, deps: d });
    expect(hits.length).toBe(10);
    expect(hits.every(h => h.kind === "files")).toBe(true);
  });

  it("a failing source doesn't break the whole picker", async () => {
    const d = deps({
      findFiles: vi.fn().mockRejectedValue(new Error("boom")),
      listOperators: vi.fn().mockResolvedValue([
        { id: "op1", name: "claude", emoji: "", color: "", tags: [], persona: "",
          escalate_threshold: 0, model: "", hard_constraints: "", voice: "neutral",
          is_default: true, created_at_unix_ms: 0, updated_at_unix_ms: 0, xp: 0 },
      ]),
    });
    const hits = await findMentions({ query: "", cwd: "/a", activeTab: "all", limit: 12, deps: d });
    expect(hits.some(h => h.kind === "teammates")).toBe(true);
  });

  it("null cwd skips files but other sources still run", async () => {
    const findFilesMock = vi.fn();
    const d = deps({
      findFiles: findFilesMock,
      listOperators: vi.fn().mockResolvedValue([
        { id: "op1", name: "claude", emoji: "", color: "", tags: [], persona: "",
          escalate_threshold: 0, model: "", hard_constraints: "", voice: "neutral",
          is_default: true, created_at_unix_ms: 0, updated_at_unix_ms: 0, xp: 0 },
      ]),
    });
    const hits = await findMentions({ query: "", cwd: null, activeTab: "all", limit: 12, deps: d });
    expect(findFilesMock).not.toHaveBeenCalled();
    expect(hits.some(h => h.kind === "teammates")).toBe(true);
  });
});
