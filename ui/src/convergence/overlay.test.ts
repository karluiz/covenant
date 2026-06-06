// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const getSnap = vi.fn();
vi.mock("../api", () => ({
  getConvergenceSnapshot: (...a: unknown[]) => getSnap(...a),
  submitConvergenceReply: vi.fn(),
}));

import { ConvergenceOverlay } from "./overlay";

const bridge = {
  listTabs: () => [{ sessionId: "s1", title: "awareness", color: null }],
  activateBySessionId: vi.fn(() => true),
};

const snapWith = (name: string) => ({
  roster: [{
    operator_id: "o", operator_name: name, operator_avatar: "🦊",
    has_escalation: false,
    sessions: [{
      session_id: "s1", tab_title: "awareness", tab_color: null, status: "working",
      vendor: "claude", raw_command_label: null, last_command: "x",
      last_output_line: null, last_decision_action: null, last_decision_rationale: null,
      mission_name: null, cost_usd: null, budget_usd: null,
    }],
  }],
  escalations: [],
});

describe("ConvergenceOverlay.refresh", () => {
  let ov: ConvergenceOverlay;
  beforeEach(() => { getSnap.mockReset(); ov = new ConvergenceOverlay(bridge); });
  afterEach(() => ov.close());

  it("renders a card grid on success", async () => {
    getSnap.mockResolvedValue(snapWith("Zeta"));
    ov.open();
    // open() fires one unawaited refresh; first call flushes it, second is the asserted one.
    await ov.refreshForTest();
    await ov.refreshForTest();
    expect(document.querySelector(".mc-card__name")?.textContent).toBe("Zeta");
  });

  it("keeps the last-good render when a later snapshot rejects (no blank)", async () => {
    getSnap.mockResolvedValue(snapWith("Zeta"));
    ov.open();
    await ov.refreshForTest();
    await ov.refreshForTest();
    getSnap.mockRejectedValue(new Error("deserialize fail"));
    await ov.refreshForTest();
    expect(document.querySelector(".mc-card__name")?.textContent).toBe("Zeta");
    const rc = document.querySelector(".mc-reconnecting");
    expect(rc).not.toBeNull();
    expect(rc?.hasAttribute("hidden")).toBe(false);
  });

  it("shows the empty state when there are no operators", async () => {
    getSnap.mockResolvedValue({ roster: [], escalations: [] });
    ov.open();
    await ov.refreshForTest();
    await ov.refreshForTest();
    expect(document.querySelector(".convergence-overlay__empty")?.hasAttribute("hidden")).toBe(false);
  });
});
