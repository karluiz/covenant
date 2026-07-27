// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { renderAgentCard, type CardCallbacks } from "./tile";
import type { AgentCard, EscalationCard, TileStatus } from "../api";

const agent = (over: Partial<AgentCard>): AgentCard => ({
  session_id: "s1", tab_title: "awareness", tab_color: null, lane: "pty",
  executor: "claude", status: "working" as TileStatus, phase_label: null,
  cwd: null, vendor: "claude", raw_command_label: null,
  last_command: "editing storage.rs", last_output_line: null,
  mission_name: null, operator_id: null, operator_name: null,
  operator_avatar: null, cost_usd: null, budget_usd: null, ...over,
});

const esc = (over: Partial<EscalationCard>): EscalationCard => ({
  session_id: "s1", tab_title: "deploy", tab_color: null, operator_id: "op-zeta",
  operator_name: "Zeta", operator_avatar: "🦊", vendor: "claude",
  raw_command_label: null, question: "OK to force-push?",
  executor_excerpt: null, mission_name: null, escalated_at_unix_ms: 0, ...over,
});

const cbs = (): CardCallbacks => ({
  onFocus: vi.fn(),
  onSubmit: vi.fn(async () => {}),
  onStop: vi.fn(),
});

describe("renderAgentCard", () => {
  it("renders executor, title, status pill and phase label", () => {
    const el = renderAgentCard(
      agent({ executor: "codex", phase_label: "writing a.rs", tab_title: "fix parser" }),
      undefined,
      cbs(),
    );
    expect(el.querySelector(".mc-card__exec")?.textContent).toBe("codex");
    expect(el.textContent).toContain("fix parser");
    expect(el.querySelector(".mc-pill")?.textContent).toBe("working");
    expect(el.querySelector(".mc-card__activity")?.textContent).toContain("writing a.rs");
    expect(el.querySelector(".mc-card__stop")).toBeNull(); // no operator → no Stop
  });

  it("shows operator badge + Stop when an operator is enabled", () => {
    const onStop = vi.fn();
    const el = renderAgentCard(
      agent({ operator_id: "o1", operator_name: "Raven", operator_avatar: "🦅" }),
      undefined,
      { ...cbs(), onStop },
    );
    expect(el.querySelector(".mc-oplabel")?.textContent).toContain("Raven");
    el.querySelector<HTMLButtonElement>(".mc-card__stop")!.click();
    expect(onStop).toHaveBeenCalledWith("s1");
  });

  it("blocked operator card shows question, tail and reply composer", () => {
    const el = renderAgentCard(
      agent({ status: "blocked", operator_id: "o1", operator_name: "Raven" }),
      esc({ question: "Deploy?", executor_excerpt: "the tail" }),
      cbs(),
    );
    expect(el.classList.contains("mc-card--blocked")).toBe(true);
    expect(el.querySelector(".mc-card__question")?.textContent).toBe("Deploy?");
    expect(el.querySelector(".mc-card__tail")?.textContent).toBe("the tail");
    expect(el.querySelector(".mc-reply")).not.toBeNull();
  });

  it("blocked agent card (no escalation) shows phase label, no composer", () => {
    const el = renderAgentCard(
      agent({ status: "blocked", phase_label: "waiting: permission" }),
      undefined,
      cbs(),
    );
    expect(el.querySelector(".mc-pill")?.textContent).toBe("NEEDS YOU");
    expect(el.querySelector(".mc-reply")).toBeNull();
    expect(el.querySelector(".mc-card__activity")?.textContent).toContain("waiting: permission");
  });

  it("clicking the tab link focuses the session", () => {
    const c = cbs();
    const el = renderAgentCard(agent({}), undefined, c);
    el.querySelector<HTMLElement>(".mc-card__tab")!.click();
    expect(c.onFocus).toHaveBeenCalledWith("s1", false);
  });

  it("shows a cost bar only when AOM-enrolled", () => {
    expect(renderAgentCard(agent({}), undefined, cbs()).querySelector(".mc-cost")).toBeNull();
    const withCost = renderAgentCard(agent({ cost_usd: 0.42, budget_usd: 1 }), undefined, cbs());
    expect(withCost.querySelector(".mc-cost")).not.toBeNull();
  });

  it("send button submits the trimmed reply text with the selected scope", async () => {
    const c = cbs();
    const el = renderAgentCard(
      agent({ status: "blocked", operator_id: "o1", operator_name: "Zeta" }),
      esc({ question: "OK?" }),
      c,
    );
    const ta = el.querySelector<HTMLTextAreaElement>(".mc-reply__textarea")!;
    ta.value = "  go ahead  ";
    el.querySelector<HTMLButtonElement>(".mc-reply__send")!.click();
    await Promise.resolve();
    expect(c.onSubmit).toHaveBeenCalledWith("s1", "go ahead", "one-shot");
  });
});
