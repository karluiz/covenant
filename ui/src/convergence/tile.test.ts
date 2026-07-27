// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { renderAgentCard, type CardCallbacks } from "./tile";
import type { AgentCard, TileStatus } from "../api";

const agent = (over: Partial<AgentCard>): AgentCard => ({
  session_id: "s1", tab_title: "awareness", tab_color: null, lane: "pty",
  executor: "claude", status: "working" as TileStatus, phase_label: null,
  cwd: null, vendor: "claude", raw_command_label: null,
  last_command: "editing storage.rs", last_output_line: null,
  mission_name: null, operator_id: null, operator_name: null,
  operator_avatar: null, cost_usd: null, budget_usd: null, ...over,
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
      { ...cbs(), onStop },
    );
    expect(el.querySelector(".mc-oplabel")?.textContent).toContain("Raven");
    el.querySelector<HTMLButtonElement>(".mc-card__stop")!.click();
    expect(onStop).toHaveBeenCalledWith("s1");
  });

  it("blocked card is informational — no composer (the queue owns the interaction)", () => {
    const el = renderAgentCard(
      agent({ status: "blocked", phase_label: "waiting: permission" }),
      cbs(),
    );
    expect(el.querySelector(".mc-pill")?.textContent).toBe("NEEDS YOU");
    expect(el.querySelector(".mc-reply")).toBeNull();
    expect(el.querySelector(".mc-card__activity")?.textContent).toContain("waiting: permission");
  });

  it("clicking the tab link focuses the session", () => {
    const c = cbs();
    const el = renderAgentCard(agent({}), c);
    el.querySelector<HTMLElement>(".mc-card__tab")!.click();
    expect(c.onFocus).toHaveBeenCalledWith("s1", false);
  });

  it("shows a cost bar only when AOM-enrolled", () => {
    expect(renderAgentCard(agent({}), cbs()).querySelector(".mc-cost")).toBeNull();
    const withCost = renderAgentCard(agent({ cost_usd: 0.42, budget_usd: 1 }), cbs());
    expect(withCost.querySelector(".mc-cost")).not.toBeNull();
  });
});
