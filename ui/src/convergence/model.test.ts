// @vitest-environment node
import { describe, it, expect } from "vitest";
import { statusPriority, escalationIndex, sortAgents } from "./model";
import type { AgentCard, EscalationCard, TileStatus } from "../api";

const agent = (sid: string, status: TileStatus, title = sid): AgentCard => ({
  session_id: sid, tab_title: title, tab_color: null, lane: "pty",
  executor: "claude", status, phase_label: null, cwd: null,
  vendor: "unknown", raw_command_label: null, last_command: null,
  last_output_line: null, mission_name: null, operator_id: null,
  operator_name: null, operator_avatar: null, cost_usd: null, budget_usd: null,
});

const esc = (sid: string, at: number): EscalationCard => ({
  session_id: sid, tab_title: sid, tab_color: null, operator_id: "o",
  operator_name: "o", operator_avatar: null, vendor: "unknown",
  raw_command_label: null, question: "q?", executor_excerpt: null,
  mission_name: null, escalated_at_unix_ms: at,
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

describe("escalationIndex", () => {
  it("maps session_id to its escalation card", () => {
    const idx = escalationIndex([esc("s1", 10)]);
    expect(idx.get("s1")?.question).toBe("q?");
    expect(idx.get("nope")).toBeUndefined();
  });
});

describe("sortAgents", () => {
  it("blocked first, oldest escalation leading, then status priority, then title", () => {
    const cards = [
      agent("idle1", "idle"),
      agent("work1", "working"),
      agent("blockNew", "blocked"),
      agent("blockOld", "blocked"),
      agent("blockNoEsc", "blocked"),
      agent("wait1", "awaiting-input"),
    ];
    const escs = [esc("blockNew", 200), esc("blockOld", 100)];
    const out = sortAgents(cards, escs).map((c) => c.session_id);
    expect(out).toEqual(["blockOld", "blockNew", "blockNoEsc", "work1", "wait1", "idle1"]);
  });

  it("does not mutate the input array", () => {
    const cards = [agent("b", "idle"), agent("a", "working")];
    const copy = [...cards];
    sortAgents(cards, []);
    expect(cards).toEqual(copy);
  });
});
