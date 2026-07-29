// @vitest-environment node
import { describe, it, expect } from "vitest";
import { statusPriority, attentionIndex, sortAgents, groupAgents } from "./model";
import type { AgentCard, AttentionItem, TileStatus } from "../api";

const agent = (sid: string, status: TileStatus, title = sid): AgentCard => ({
  session_id: sid, tab_title: title, tab_color: null, lane: "pty",
  executor: "claude", status, phase_label: null, cwd: null,
  vendor: "unknown", raw_command_label: null, last_command: null,
  last_output_line: null, excerpt: null, started_at_unix_ms: null, mission_name: null, operator_id: null,
  operator_name: null, operator_avatar: null, cost_usd: null, budget_usd: null,
  subagents: [],
});

const att = (sid: string, at: number | null): AttentionItem => ({
  session_id: sid, tab_title: sid, tab_color: null, lane: "pty",
  executor: "claude", kind: "operator-escalation", question: "q?",
  permission: null, operator_name: "o",
  operator_avatar: null, mission_name: null, since_unix_ms: at,
});

describe("statusPriority", () => {
  it("orders blocked < thinking < working < awaiting < idle", () => {
    const order: TileStatus[] = [
      "blocked", "operator-thinking", "working", "awaiting-input", "idle",
    ];
    const ranks = order.map(statusPriority);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });
});

describe("attentionIndex", () => {
  it("maps session_id to its attention item", () => {
    const idx = attentionIndex([att("s1", 10)]);
    expect(idx.get("s1")?.question).toBe("q?");
    expect(idx.get("nope")).toBeUndefined();
  });
});

describe("sortAgents", () => {
  it("blocked first, oldest attention leading, then status priority, then title", () => {
    const cards = [
      agent("idle1", "idle"),
      agent("work1", "working"),
      agent("blockNew", "blocked"),
      agent("blockOld", "blocked"),
      agent("blockNoAtt", "blocked"),
      agent("wait1", "awaiting-input"),
    ];
    const atts = [att("blockNew", 200), att("blockOld", 100)];
    const out = sortAgents(cards, atts).map((c) => c.session_id);
    expect(out).toEqual(["blockOld", "blockNew", "blockNoAtt", "work1", "wait1", "idle1"]);
  });

  it("attention items without a timestamp sort with the untimestamped blocked", () => {
    const cards = [agent("a", "blocked"), agent("b", "blocked")];
    const atts = [att("b", null)];
    // neither has a timestamp → title tiebreak
    expect(sortAgents(cards, atts).map((c) => c.session_id)).toEqual(["a", "b"]);
  });

  it("does not mutate the input array", () => {
    const cards = [agent("b", "idle"), agent("a", "working")];
    const copy = [...cards];
    sortAgents(cards, []);
    expect(cards).toEqual(copy);
  });
});

describe("groupAgents", () => {
  const groupOf = (sid: string): string | null =>
    sid.startsWith("a") ? "alpha" : sid.startsWith("b") ? "beta" : null;

  it("buckets by group, bubbles the bucket holding blocked, keeps in-bucket order", () => {
    const list = [
      agent("a1", "working"),
      agent("b1", "blocked"),
      agent("a2", "idle"),
      agent("n1", "idle"),
    ];
    const groups = groupAgents(list, groupOf);
    expect(groups.map((g) => g.key)).toEqual(["beta", "alpha", null]);
    expect(groups[1].cards.map((c) => c.session_id)).toEqual(["a1", "a2"]);
    expect(groups[0].cards.map((c) => c.session_id)).toEqual(["b1"]);
  });

  it("single distinct group collapses to one bucket", () => {
    const list = [agent("a1", "working"), agent("a2", "idle")];
    const groups = groupAgents(list, groupOf);
    expect(groups.length).toBe(1);
    expect(groups[0].key).toBe("alpha");
  });
});

describe("groupAgents — foreign workspaces", () => {
  const groupOf = (sid: string): string | null =>
    sid.startsWith("f") ? "ws:other" : "mine";
  const isForeign = (key: string | null): boolean => key === "ws:other";

  it("sinks another workspace's bucket below your own", () => {
    // The foreign agents come FIRST in the flat list (they're older), so
    // first-appearance order alone would have put them on top — which is
    // exactly how another workspace's untitled rows ended up above yours.
    const list = [agent("f1", "working"), agent("m1", "idle")];
    const groups = groupAgents(list, groupOf, isForeign);
    expect(groups.map((g) => g.key)).toEqual(["mine", "ws:other"]);
  });

  it("but blocked still outranks foreign — that's why you opened it", () => {
    const list = [agent("f1", "blocked"), agent("m1", "working")];
    const groups = groupAgents(list, groupOf, isForeign);
    expect(groups.map((g) => g.key)).toEqual(["ws:other", "mine"]);
  });
});
