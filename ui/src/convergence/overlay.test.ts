// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const getSnap = vi.fn();
vi.mock("../api", () => ({
  getConvergenceSnapshot: (...a: unknown[]) => getSnap(...a),
  submitConvergenceReply: vi.fn(),
  setOperatorEnabled: vi.fn(),
}));

import { ConvergenceOverlay } from "./overlay";
import type { AgentCard } from "../api";

const bridge = {
  listTabs: () => [{ sessionId: "s1", title: "awareness", color: null }],
  activateBySessionId: vi.fn(() => true),
};

const agent = (over: Partial<AgentCard>): AgentCard => ({
  session_id: "s1", tab_title: "awareness", tab_color: null, lane: "pty",
  executor: "claude", status: "working", phase_label: null, cwd: null,
  vendor: "claude", raw_command_label: null, last_command: "x",
  last_output_line: null, mission_name: null, operator_id: null,
  operator_name: null, operator_avatar: null, cost_usd: null, budget_usd: null,
  ...over,
});

describe("ConvergenceOverlay.refresh", () => {
  let ov: ConvergenceOverlay;
  beforeEach(() => { getSnap.mockReset(); ov = new ConvergenceOverlay(bridge); });
  afterEach(() => ov.close());

  it("renders a flat card grid, blocked first, with agent summary", async () => {
    getSnap.mockResolvedValue({
      agents: [
        agent({ session_id: "s1", tab_title: "alpha", executor: "codex" }),
        agent({ session_id: "s2", tab_title: "beta", status: "blocked" }),
      ],
      escalations: [],
    });
    ov.open();
    // open() fires one unawaited refresh; first call flushes it, second is the asserted one.
    await ov.refreshForTest();
    await ov.refreshForTest();
    const cards = [...document.querySelectorAll<HTMLElement>(".mc-card")];
    expect(cards.length).toBe(2);
    expect(cards[0].dataset.sessionId).toBe("s2"); // blocked leads
    const summary = document.querySelector(".mc-strip__summary")?.textContent ?? "";
    expect(summary).toContain("2");
    expect(summary).toContain("agents");
    expect(summary).toContain("1 needs you");
  });

  it("keeps the last-good render when a later snapshot rejects (no blank)", async () => {
    getSnap.mockResolvedValue({ agents: [agent({ executor: "codex" })], escalations: [] });
    ov.open();
    await ov.refreshForTest();
    await ov.refreshForTest();
    getSnap.mockRejectedValue(new Error("deserialize fail"));
    await ov.refreshForTest();
    expect(document.querySelector(".mc-card__exec")?.textContent).toBe("codex");
    const rc = document.querySelector(".mc-reconnecting");
    expect(rc).not.toBeNull();
    expect(rc?.hasAttribute("hidden")).toBe(false);
  });

  it("shows the empty state when there are no agents", async () => {
    getSnap.mockResolvedValue({ agents: [], escalations: [] });
    ov.open();
    await ov.refreshForTest();
    await ov.refreshForTest();
    expect(document.querySelector(".convergence-overlay__empty")?.hasAttribute("hidden")).toBe(false);
  });
});
