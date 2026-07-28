// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const getSnap = vi.fn();
const opList = vi.fn(async () => [] as unknown[]);
vi.mock("../api", () => ({
  getConvergenceSnapshot: (...a: unknown[]) => getSnap(...a),
  operatorList: () => opList(),
  submitConvergenceReply: vi.fn(),
  setOperatorEnabled: vi.fn(),
  acpRespondPermission: vi.fn(),
  writeToSession: vi.fn(),
}));

import { ConvergenceOverlay } from "./overlay";
import { clearGroupFindings, recordGroupFinding } from "./findings";
import type { AgentCard, AttentionItem } from "../api";

const bridge = {
  listTabs: () => [{ sessionId: "s1", title: "awareness", color: null, group: null }],
  activateBySessionId: vi.fn(() => true),
};

const agent = (over: Partial<AgentCard>): AgentCard => ({
  session_id: "s1", tab_title: "awareness", tab_color: null, lane: "pty",
  executor: "claude", status: "working", phase_label: null, cwd: null,
  vendor: "claude", raw_command_label: null, last_command: "x",
  last_output_line: null, excerpt: null, started_at_unix_ms: null, mission_name: null, operator_id: null,
  operator_name: null, operator_avatar: null, cost_usd: null, budget_usd: null,
  subagents: [], ...over,
});

/// One tab, one group, one supervisor attached with intervene on.
const supervisedBridge = () => ({
  listTabs: () => [
    {
      sessionId: "s1", title: "alpha", color: null,
      group: "growcity", groupId: "g1",
      supervisor: { operatorId: "op-7", intervene: true },
    },
  ],
  activateBySessionId: vi.fn(() => true),
  setGroupSupervisor: vi.fn(),
  setGroupIntervene: vi.fn(),
});

const attItem = (over: Partial<AttentionItem>): AttentionItem => ({
  session_id: "s1", tab_title: "deploy", tab_color: null, lane: "pty",
  executor: "claude", kind: "operator-escalation", question: "OK?",
  permission: null, operator_name: "Zeta",
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

  it("clicking a different row moves the pane even while the composer is focused with a draft", async () => {
    // The app's webview doesn't blur a focused textarea on a button/row
    // click, so the draft-guard in `renderDetail` would otherwise freeze
    // the pane forever. Explicit navigation (row click) must override it.
    getSnap.mockResolvedValue({
      agents: [
        agent({ session_id: "s1", tab_title: "alpha", status: "blocked" }),
        agent({ session_id: "s2", tab_title: "beta", status: "working" }),
      ],
      attention: [attItem({ session_id: "s1" })],
    });
    ov.open();
    await ov.refreshForTest();
    await ov.refreshForTest();
    expect(document.querySelector<HTMLElement>(".mc-detail")?.dataset.sessionId).toBe("s1");
    const ta = document.querySelector<HTMLTextAreaElement>(".mc-detail .mc-reply__textarea")!;
    ta.focus();
    ta.value = "draft in progress";
    document.querySelector<HTMLElement>('.mc-row[data-session-id="s2"]')!.click();
    expect(document.querySelector<HTMLElement>(".mc-detail")?.dataset.sessionId).toBe("s2");
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

  it("non-blocked rows show elapsed-since-start; blocked rows keep attention age", async () => {
    getSnap.mockResolvedValue({
      agents: [
        agent({ session_id: "s1", started_at_unix_ms: Date.now() - 65_000 }),
        agent({ session_id: "s2", status: "blocked", started_at_unix_ms: Date.now() - 300_000 }),
      ],
      attention: [attItem({ session_id: "s2", since_unix_ms: Date.now() - 120_000 })],
    });
    ov.open();
    await ov.refreshForTest();
    await ov.refreshForTest();
    const age = (sid: string) =>
      document.querySelector(`.mc-row[data-session-id="${sid}"] .mc-row__age`)?.textContent;
    expect(age("s1")).toBe("1m 05s");
    expect(age("s2")).toBe("2m ago");
  });

  it("answering a blocked session advances the pane to the next blocked one", async () => {
    getSnap.mockResolvedValue({
      agents: [
        agent({ session_id: "s1", tab_title: "alpha", status: "blocked" }),
        agent({ session_id: "s2", tab_title: "beta", status: "blocked" }),
        agent({ session_id: "s3", tab_title: "gamma" }),
      ],
      attention: [
        attItem({ session_id: "s1", since_unix_ms: 100 }),
        attItem({ session_id: "s2", since_unix_ms: 200 }),
      ],
    });
    ov.open();
    await ov.refreshForTest();
    await ov.refreshForTest();
    expect(document.querySelector<HTMLElement>(".mc-detail")?.dataset.sessionId).toBe("s1");
    const ta = document.querySelector<HTMLTextAreaElement>(".mc-detail .mc-reply__textarea")!;
    ta.value = "ship it";
    document.querySelector<HTMLButtonElement>(".mc-detail .mc-reply__send")!.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(document.querySelector<HTMLElement>(".mc-detail")?.dataset.sessionId).toBe("s2");
  });

  it("rail groups rows under workspace headers, blocked group first", async () => {
    const b2 = {
      listTabs: () => [
        { sessionId: "s1", title: "alpha", color: null, group: "covenant", groupId: "g1" },
        { sessionId: "s2", title: "beta", color: null, group: "banco", groupId: "g2" },
      ],
      activateBySessionId: vi.fn(() => true),
    };
    const ov2 = new ConvergenceOverlay(b2);
    getSnap.mockResolvedValue({
      agents: [
        agent({ session_id: "s1", tab_title: "alpha" }),
        agent({ session_id: "s2", tab_title: "beta", status: "blocked" }),
      ],
      attention: [attItem({ session_id: "s2" })],
    });
    ov2.open();
    await ov2.refreshForTest();
    await ov2.refreshForTest();
    const entries = [...document.querySelectorAll<HTMLElement>(".mc-rail > *")].map((el) =>
      el.classList.contains("mc-rail__group")
        ? `#${el.querySelector(".mc-gband__name")?.textContent}`
        : (el.dataset.sessionId ?? "?"),
    );
    expect(entries).toEqual(["#banco", "s2", "#covenant", "s1"]);
    ov2.close();
  });

  it("buckets by group ID, so two groups sharing a name stay apart", async () => {
    const b2 = {
      listTabs: () => [
        { sessionId: "s1", title: "alpha", color: null, group: "api", groupId: "g1" },
        { sessionId: "s2", title: "beta", color: null, group: "api", groupId: "g2" },
      ],
      activateBySessionId: vi.fn(() => true),
    };
    const ov2 = new ConvergenceOverlay(b2);
    getSnap.mockResolvedValue({
      agents: [agent({ session_id: "s1" }), agent({ session_id: "s2" })],
      attention: [],
    });
    ov2.open();
    await ov2.refreshForTest();
    await ov2.refreshForTest();
    expect(document.querySelectorAll(".mc-rail__group")).toHaveLength(2);
    ov2.close();
  });

  it("rail with a single group shows no headers", async () => {
    getSnap.mockResolvedValue({
      agents: [agent({ session_id: "s1" })],
      attention: [],
    });
    ov.open();
    await ov.refreshForTest();
    await ov.refreshForTest();
    expect(document.querySelector(".mc-rail__group")).toBeNull();
  });

  it("shows the supervision band for a single supervised group, and names the operator", async () => {
    const b2 = supervisedBridge();
    const ov2 = new ConvergenceOverlay(b2);
    opList.mockResolvedValue([{ id: "op-7", name: "Warden", emoji: "🛡️" }]);
    getSnap.mockResolvedValue({ agents: [agent({ session_id: "s1" })], attention: [] });
    ov2.open();
    await ov2.refreshForTest();
    await ov2.refreshForTest();
    const band = document.querySelector<HTMLElement>(".mc-rail__group")!;
    expect(band.classList.contains("mc-gband--supervised")).toBe(true);
    expect(band.querySelector(".mc-gband__who")?.textContent).toBe("Warden");
    expect(band.querySelector(".mc-gband__mode")?.textContent).toContain("intervenes");
    expect(document.querySelector(".mc-strip__sup")?.textContent).toBe("1 supervised");
    ov2.close();
  });

  it("selecting the band swaps the detail host to the group, with its retained findings", async () => {
    clearGroupFindings();
    recordGroupFinding({
      groupId: "g1", operatorName: "Warden",
      message: "tab 2 fails on the file tab 1 just wrote", atUnixMs: Date.now() - 60_000,
    });
    const b2 = supervisedBridge();
    const ov2 = new ConvergenceOverlay(b2);
    opList.mockResolvedValue([{ id: "op-7", name: "Warden", emoji: "🛡️" }]);
    getSnap.mockResolvedValue({ agents: [agent({ session_id: "s1" })], attention: [] });
    ov2.open();
    await ov2.refreshForTest();
    await ov2.refreshForTest();
    document.querySelector<HTMLElement>(".mc-rail__group")!.click();
    const pane = document.querySelector<HTMLElement>(".mc-gdetail")!;
    expect(pane.dataset.groupId).toBe("g1");
    expect(pane.querySelector(".mc-gdetail__find p")?.textContent).toContain("tab 2 fails");
    expect(pane.querySelector(".mc-gdetail__find time")?.textContent).toBe("1m ago");
    // …and clicking an agent row takes it back.
    document.querySelector<HTMLElement>('.mc-row[data-session-id="s1"]')!.click();
    expect(document.querySelector(".mc-gdetail")).toBeNull();
    expect(document.querySelector<HTMLElement>(".mc-detail")?.dataset.sessionId).toBe("s1");
    ov2.close();
    clearGroupFindings();
  });

  it("the group pane drives detach and the intervene toggle through the bridge", async () => {
    const b2 = supervisedBridge();
    const ov2 = new ConvergenceOverlay(b2);
    opList.mockResolvedValue([{ id: "op-7", name: "Warden", emoji: "🛡️" }]);
    getSnap.mockResolvedValue({ agents: [agent({ session_id: "s1" })], attention: [] });
    ov2.open();
    await ov2.refreshForTest();
    await ov2.refreshForTest();
    document.querySelector<HTMLElement>(".mc-rail__group")!.click();
    document.querySelector<HTMLButtonElement>(".mc-gdetail__intervene")!.click();
    expect(b2.setGroupIntervene).toHaveBeenCalledWith("g1", false);
    document.querySelector<HTMLButtonElement>(".mc-gdetail .mc-stop")!.click();
    expect(b2.setGroupSupervisor).toHaveBeenCalledWith("g1", null);
    ov2.close();
  });

  it("identical polls reuse the rail rows and detail pane (hover survives)", async () => {
    getSnap.mockResolvedValue({
      agents: [agent({ session_id: "s1", status: "blocked" }), agent({ session_id: "s2", tab_title: "beta" })],
      attention: [attItem({ session_id: "s1" })],
    });
    ov.open();
    await ov.refreshForTest();
    await ov.refreshForTest();
    const row = document.querySelector(".mc-row");
    const pane = document.querySelector(".mc-detail");
    await ov.refreshForTest();
    expect(document.querySelector(".mc-row")).toBe(row);
    expect(document.querySelector(".mc-detail")).toBe(pane);
    // A data change still rebuilds.
    getSnap.mockResolvedValue({
      agents: [agent({ session_id: "s1", status: "blocked", phase_label: "new phase" }), agent({ session_id: "s2", tab_title: "beta" })],
      attention: [attItem({ session_id: "s1" })],
    });
    await ov.refreshForTest();
    expect(document.querySelector(".mc-row")).not.toBe(row);
  });

  it("number keys jump the pane to the Nth rail row", async () => {
    getSnap.mockResolvedValue({
      agents: [
        agent({ session_id: "s1", tab_title: "alpha" }),
        agent({ session_id: "s2", tab_title: "beta" }),
      ],
      attention: [],
    });
    ov.open();
    await ov.refreshForTest();
    await ov.refreshForTest();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "2" }));
    expect(document.querySelector<HTMLElement>(".mc-detail")?.dataset.sessionId).toBe("s2");
  });
});
