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
  last_output_line: null, excerpt: null, mission_name: null, operator_id: null,
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

  it("renders every session as a rail row, blocked first, and details the blocked one", async () => {
    getSnap.mockResolvedValue({
      agents: [
        agent({ session_id: "s1", tab_title: "alpha" }),
        agent({ session_id: "s2", tab_title: "beta", status: "blocked" }),
      ],
      attention: [attItem({ session_id: "s2", question: "Ship?" })],
    });
    ov.open();
    await ov.refreshForTest();
    await ov.refreshForTest();
    const rows = [...document.querySelectorAll<HTMLElement>(".mc-rail .mc-row")];
    expect(rows.map((r) => r.dataset.sessionId)).toEqual(["s2", "s1"]);
    // blocked auto-selected → detail shows its interaction
    const detail = document.querySelector<HTMLElement>(".mc-detail")!;
    expect(detail.dataset.sessionId).toBe("s2");
    expect(detail.querySelector(".mc-detail__question")?.textContent).toBe("Ship?");
    expect(detail.querySelector(".mc-reply")).not.toBeNull();
    const summary = document.querySelector(".mc-strip__summary")?.textContent ?? "";
    expect(summary).toContain("1 needs you");
  });

  it("clicking a row moves the detail pane to it", async () => {
    getSnap.mockResolvedValue({
      agents: [agent({ session_id: "s1", tab_title: "alpha" }), agent({ session_id: "s2", tab_title: "beta" })],
      attention: [],
    });
    ov.open();
    await ov.refreshForTest();
    await ov.refreshForTest();
    document.querySelector<HTMLElement>('.mc-row[data-session-id="s2"]')!.click();
    expect(document.querySelector<HTMLElement>(".mc-detail")?.dataset.sessionId).toBe("s2");
  });

  it("a poll refresh never clobbers a composer draft", async () => {
    getSnap.mockResolvedValue({
      agents: [agent({ session_id: "s2", status: "blocked" })],
      attention: [attItem({ session_id: "s2" })],
    });
    ov.open();
    await ov.refreshForTest();
    await ov.refreshForTest();
    const ta = document.querySelector<HTMLTextAreaElement>(".mc-detail .mc-reply__textarea")!;
    ta.focus();
    ta.value = "draft in progress";
    await ov.refreshForTest();
    const after = document.querySelector<HTMLTextAreaElement>(".mc-detail .mc-reply__textarea")!;
    expect(after).toBe(ta);
    expect(after.value).toBe("draft in progress");
  });

  it("draft survives when the active session drops out of the filtered rail list mid-focus", async () => {
    getSnap.mockResolvedValue({
      agents: [agent({ session_id: "s2", status: "blocked" })],
      attention: [attItem({ session_id: "s2" })],
    });
    ov.open();
    await ov.refreshForTest();
    await ov.refreshForTest();
    // Narrow to "needs you" so the next poll's status change empties the list.
    document.querySelector<HTMLElement>('.mc-fchip[data-filter="needs you"]')!.click();
    const ta = document.querySelector<HTMLTextAreaElement>(".mc-detail .mc-reply__textarea")!;
    ta.focus();
    ta.value = "draft in progress";
    // s2 un-blocks concurrently: it drops off "needs you", activeSessionId
    // gets reassigned (list is empty → null), and no card matches this render.
    getSnap.mockResolvedValue({
      agents: [agent({ session_id: "s2", status: "working" })],
      attention: [],
    });
    await ov.refreshForTest();
    const after = document.querySelector<HTMLTextAreaElement>(".mc-detail .mc-reply__textarea")!;
    expect(after).toBe(ta);
    expect(after.value).toBe("draft in progress");
  });

  it("keeps the last-good render when a later snapshot rejects (no blank)", async () => {
    getSnap.mockResolvedValue({ agents: [agent({ executor: "codex" })], attention: [] });
    ov.open();
    await ov.refreshForTest();
    await ov.refreshForTest();
    getSnap.mockRejectedValue(new Error("deserialize fail"));
    await ov.refreshForTest();
    expect(document.querySelector(".mc-row__sub")?.textContent).toBe("codex");
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
