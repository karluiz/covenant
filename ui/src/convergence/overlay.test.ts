// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const getSnap = vi.fn();
vi.mock("../api", () => ({
  getConvergenceSnapshot: (...a: unknown[]) => getSnap(...a),
  submitConvergenceReply: vi.fn(),
  setOperatorEnabled: vi.fn(),
  acpRespondPermission: vi.fn(),
  writeToSession: vi.fn(),
}));

import { ConvergenceOverlay } from "./overlay";
import type { AgentCard, AttentionItem } from "../api";

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
  subagents: [], ...over,
});

const attItem = (over: Partial<AttentionItem>): AttentionItem => ({
  session_id: "s1", tab_title: "deploy", tab_color: null, lane: "pty",
  executor: "claude", kind: "operator-escalation", question: "OK?",
  excerpt: null, permission: null, operator_name: "Zeta",
  operator_avatar: null, mission_name: null, since_unix_ms: 100, ...over,
});

describe("ConvergenceOverlay.refresh", () => {
  let ov: ConvergenceOverlay;
  beforeEach(() => { getSnap.mockReset(); ov = new ConvergenceOverlay(bridge); });
  afterEach(() => ov.close());

  it("renders the attention queue above the grid and excludes queued sessions from it", async () => {
    getSnap.mockResolvedValue({
      agents: [
        agent({ session_id: "s1", tab_title: "alpha" }),
        agent({ session_id: "s2", tab_title: "beta", status: "blocked" }),
      ],
      attention: [attItem({ session_id: "s2" })],
    });
    ov.open();
    // open() fires one unawaited refresh; first call flushes it, second is the asserted one.
    await ov.refreshForTest();
    await ov.refreshForTest();
    expect(document.querySelectorAll(".mc-attention .mc-attention-card").length).toBe(1);
    const gridCards = [...document.querySelectorAll<HTMLElement>(".mc-grid .mc-card")];
    expect(gridCards.map((c) => c.dataset.sessionId)).toEqual(["s1"]);
    const summary = document.querySelector(".mc-strip__summary")?.textContent ?? "";
    expect(summary).toContain("2");
    expect(summary).toContain("agents");
    expect(summary).toContain("1 needs you");
  });

  it("keeps the last-good render when a later snapshot rejects (no blank)", async () => {
    getSnap.mockResolvedValue({ agents: [agent({ executor: "codex" })], attention: [] });
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

  it("shows the empty state when there are no agents and no attention", async () => {
    getSnap.mockResolvedValue({ agents: [], attention: [] });
    ov.open();
    await ov.refreshForTest();
    await ov.refreshForTest();
    expect(document.querySelector(".convergence-overlay__empty")?.hasAttribute("hidden")).toBe(false);
  });
});
