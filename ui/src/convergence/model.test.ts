// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  statusPriority,
  operatorStatus,
  escalationIndex,
  sortOperators,
} from "./model";
import type { EscalationCard, OperatorRosterEntry, SessionSummary, TileStatus } from "../api";

const session = (status: TileStatus, id = "s"): SessionSummary => ({
  session_id: id, tab_title: id, tab_color: null, status,
  vendor: "unknown", raw_command_label: null, last_command: null,
  last_output_line: null, last_decision_action: null,
  last_decision_rationale: null, mission_name: null,
  cost_usd: null, budget_usd: null,
});

const op = (
  operator_id: string, operator_name: string,
  sessions: SessionSummary[], has_escalation = false,
): OperatorRosterEntry => ({
  operator_id, operator_name, operator_avatar: null, sessions, has_escalation,
});

const esc = (operator_id: string, session_id: string, at: number): EscalationCard => ({
  session_id, tab_title: session_id, tab_color: null, operator_id,
  operator_name: operator_id, operator_avatar: null, vendor: "unknown",
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

describe("operatorStatus", () => {
  it("returns the highest-priority status across sessions", () => {
    expect(operatorStatus(op("o", "O", [session("idle"), session("blocked")]))).toBe("blocked");
    expect(operatorStatus(op("o", "O", [session("idle"), session("working")]))).toBe("working");
    expect(operatorStatus(op("o", "O", []))).toBe("idle");
  });
});

describe("escalationIndex", () => {
  it("maps session_id to its escalation card", () => {
    const idx = escalationIndex([esc("o", "s1", 10)]);
    expect(idx.get("s1")?.question).toBe("q?");
    expect(idx.get("nope")).toBeUndefined();
  });
});

describe("sortOperators", () => {
  it("puts escalating operators first, oldest escalation first", () => {
    const roster = [
      op("a", "alpha", [session("working")]),
      op("b", "bravo", [session("blocked", "sb")], true),
      op("c", "charlie", [session("blocked", "sc")], true),
    ];
    const escs = [esc("c", "sc", 100), esc("b", "sb", 500)];
    const out = sortOperators(roster, escs).map((o) => o.operator_id);
    expect(out).toEqual(["c", "b", "a"]);
  });

  it("breaks non-escalation ties by status then name", () => {
    const roster = [
      op("z", "zeta", [session("idle")]),
      op("a", "ana", [session("idle")]),
      op("w", "wade", [session("working")]),
    ];
    const out = sortOperators(roster, []).map((o) => o.operator_id);
    expect(out).toEqual(["w", "a", "z"]);
  });
});
