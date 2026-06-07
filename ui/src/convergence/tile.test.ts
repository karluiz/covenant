// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { renderOperatorCard } from "./tile";
import { escalationIndex } from "./model";
import type { EscalationCard, OperatorRosterEntry, SessionSummary, TileStatus } from "../api";

const session = (over: Partial<SessionSummary>): SessionSummary => ({
  session_id: "s1", tab_title: "awareness", tab_color: null, status: "working",
  vendor: "claude", raw_command_label: null, last_command: "editing storage.rs",
  last_output_line: null, last_decision_action: null, last_decision_rationale: null,
  mission_name: null, cost_usd: null, budget_usd: null, ...over,
});

const op = (sessions: SessionSummary[], has_escalation = false): OperatorRosterEntry => ({
  operator_id: "op-zeta", operator_name: "Zeta", operator_avatar: "🦊",
  sessions, has_escalation,
});

const cb = () => ({ onFocus: vi.fn(), onToggleExpand: vi.fn(), onSubmit: vi.fn(), onStop: vi.fn() });

describe("renderOperatorCard", () => {
  it("renders a working single-session card with name, status, activity", () => {
    const el = renderOperatorCard(op([session({})]), escalationIndex([]), cb(), new Set());
    expect(el.querySelector(".mc-card__name")?.textContent).toBe("Zeta");
    expect(el.classList.contains("mc-card--working")).toBe(true);
    expect(el.textContent).toContain("editing storage.rs");
  });

  it("shows a cost bar only when AOM-enrolled", () => {
    const noCost = renderOperatorCard(op([session({})]), escalationIndex([]), cb(), new Set());
    expect(noCost.querySelector(".mc-cost")).toBeNull();
    const withCost = renderOperatorCard(
      op([session({ cost_usd: 0.42, budget_usd: 1 })]), escalationIndex([]), cb(), new Set());
    expect(withCost.querySelector(".mc-cost")).not.toBeNull();
  });

  it("blocked card glows, shows the question, tail, and a reply composer", () => {
    const esc: EscalationCard = {
      session_id: "s1", tab_title: "deploy", tab_color: null, operator_id: "op-zeta",
      operator_name: "Zeta", operator_avatar: "🦊", vendor: "claude",
      raw_command_label: null, question: "OK to force-push?",
      executor_excerpt: "! [rejected] main -> main", mission_name: null,
      escalated_at_unix_ms: 0,
    };
    const el = renderOperatorCard(
      op([session({ status: "blocked" as TileStatus })], true),
      escalationIndex([esc]), cb(), new Set());
    expect(el.classList.contains("mc-card--blocked")).toBe(true);
    expect(el.textContent).toContain("OK to force-push?");
    expect(el.querySelector(".mc-card__tail")?.textContent).toContain("! [rejected]");
    expect(el.querySelector(".mc-reply")).not.toBeNull();
  });

  it("clicking the tab link focuses the session", () => {
    const c = cb();
    const el = renderOperatorCard(op([session({})]), escalationIndex([]), c, new Set());
    el.querySelector<HTMLElement>(".mc-card__tab")!.click();
    expect(c.onFocus).toHaveBeenCalledWith("s1", false);
  });

  it("clicking Stop disables the operator on its single session", () => {
    const c = cb();
    const el = renderOperatorCard(op([session({})]), escalationIndex([]), c, new Set());
    el.querySelector<HTMLElement>(".mc-card__stop")!.click();
    expect(c.onStop).toHaveBeenCalledWith("op-zeta", ["s1"]);
  });

  it("Stop on a multi-session operator disables every session at once", () => {
    const c = cb();
    const entry = op([session({ session_id: "s1" }), session({ session_id: "s2", tab_title: "api" })]);
    const el = renderOperatorCard(entry, escalationIndex([]), c, new Set());
    el.querySelector<HTMLElement>(".mc-card__stop")!.click();
    expect(c.onStop).toHaveBeenCalledWith("op-zeta", ["s1", "s2"]);
  });

  it("multi-session operator shows an aggregate count and sub-rows when expanded", () => {
    const entry = op([session({ session_id: "s1" }), session({ session_id: "s2", tab_title: "api" })]);
    const collapsed = renderOperatorCard(entry, escalationIndex([]), cb(), new Set());
    expect(collapsed.querySelector(".mc-card__count")?.textContent).toContain("2");
    expect(collapsed.querySelectorAll(".mc-subrow").length).toBe(0);
    const expanded = renderOperatorCard(entry, escalationIndex([]), cb(), new Set(["op-zeta"]));
    expect(expanded.querySelectorAll(".mc-subrow").length).toBe(2);
  });

  it("send button submits the trimmed reply text with the selected scope", async () => {
    const c = cb();
    const esc: EscalationCard = {
      session_id: "s1", tab_title: "deploy", tab_color: null, operator_id: "op-zeta",
      operator_name: "Zeta", operator_avatar: "🦊", vendor: "claude",
      raw_command_label: null, question: "OK?", executor_excerpt: null,
      mission_name: null, escalated_at_unix_ms: 0,
    };
    const el = renderOperatorCard(
      op([session({ status: "blocked" })], true),
      escalationIndex([esc]), c, new Set());
    const ta = el.querySelector<HTMLTextAreaElement>(".mc-reply__textarea")!;
    ta.value = "  go ahead  ";
    el.querySelector<HTMLButtonElement>(".mc-reply__send")!.click();
    await Promise.resolve();
    expect(c.onSubmit).toHaveBeenCalledWith("s1", "go ahead", "one-shot");
  });
});
