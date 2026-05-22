import { describe, expect, it, vi } from "vitest";

import type { Operator } from "../api";
import { TeammatePanel } from "./panel";

function makeOp(overrides: Partial<Operator> = {}): Operator {
  return {
    id: "op-mibli",
    name: "Mibli",
    emoji: "🤖",
    color: "#6B7280",
    tags: [],
    persona: "",
    escalate_threshold: 0.6,
    model: "claude-sonnet-4-6",
    hard_constraints: "",
    voice: "Terse",
    is_default: true,
    created_at_unix_ms: 0,
    updated_at_unix_ms: 0,
    xp: 0,
    ...overrides,
  };
}

describe("TeammatePanel", () => {
  it("renders the placeholder when there are no messages", async () => {
    const host = document.createElement("div");
    const panel = new TeammatePanel(host, {
      listMessages:  vi.fn().mockResolvedValue([]),
      sendText:      vi.fn(),
      listOperators: vi.fn().mockResolvedValue([]),
    });
    await panel.openFor(makeOp());
    expect(host.textContent ?? "").toMatch(/Sin conversación aún/);
  });

  it("renders avatar + name + model subtitle in the header", async () => {
    const host = document.createElement("div");
    const panel = new TeammatePanel(host, {
      listMessages:  vi.fn().mockResolvedValue([]),
      sendText:      vi.fn(),
      listOperators: vi.fn().mockResolvedValue([]),
    });
    await panel.openFor(makeOp());
    expect(host.querySelector(".teammate-panel-avatar")).not.toBeNull();
    expect(host.querySelector(".teammate-panel-title-name")?.textContent).toBe("Mibli");
    expect(host.querySelector(".teammate-panel-subtitle")?.textContent).toBe("claude-sonnet-4-6");
  });

  it("renders operator bubbles in an avatar row, user bubbles solo", async () => {
    const host = document.createElement("div");
    let captured: ((m: import("../api").TeammateMessage) => void) | null = null;
    const panel = new TeammatePanel(host, {
      listMessages:  vi.fn().mockResolvedValue([]),
      sendText:      vi.fn().mockResolvedValue({
        id: "u1", operator_id: "op-mibli", task_id: null, role: "user",
        content: { kind: "text", data: "hola" }, created_at_unix_ms: 1,
      }),
      listOperators: vi.fn().mockResolvedValue([]),
      onMessage: vi.fn(async (h) => { captured = h; return () => {}; }),
    });
    await panel.openFor(makeOp());
    await panel.send("hola");
    captured!({
      id: "m1", operator_id: "op-mibli", task_id: null, role: "operator",
      content: { kind: "text", data: "hola, ¿en qué te ayudo?" }, created_at_unix_ms: 2,
    });
    // User bubble: no row wrapper
    expect(host.querySelectorAll(".teammate-bubble-user").length).toBe(1);
    // Operator bubble: wrapped in a row with an avatar slot
    const opRows = host.querySelectorAll(".teammate-bubble-row[data-role='operator']:not(.teammate-typing)");
    expect(opRows.length).toBe(1);
    expect(opRows[0].querySelector(".teammate-bubble-avatar")).not.toBeNull();
  });

  it("renders backtick spans as <code> in bubbles", async () => {
    const host = document.createElement("div");
    let captured: ((m: import("../api").TeammateMessage) => void) | null = null;
    const panel = new TeammatePanel(host, {
      listMessages:  vi.fn().mockResolvedValue([]),
      sendText:      vi.fn(),
      listOperators: vi.fn().mockResolvedValue([]),
      onMessage: vi.fn(async (h) => { captured = h; return () => {}; }),
    });
    await panel.openFor(makeOp());
    captured!({
      id: "m1", operator_id: "op-mibli", task_id: null, role: "operator",
      content: { kind: "text", data: "the file is `src/main.rs`" }, created_at_unix_ms: 2,
    });
    const code = host.querySelector(".teammate-bubble code");
    expect(code).not.toBeNull();
    expect(code?.textContent).toBe("src/main.rs");
  });

  it("appends a bubble after sendText resolves", async () => {
    const host = document.createElement("div");
    const send = vi.fn().mockResolvedValue({
      id: "m1",
      operator_id: "op-mibli",
      task_id: null,
      role: "user",
      content: { kind: "text", data: "hola" },
      created_at_unix_ms: 1,
    });
    const panel = new TeammatePanel(host, {
      listMessages:  vi.fn().mockResolvedValue([]),
      sendText:      send,
      listOperators: vi.fn().mockResolvedValue([]),
    });
    await panel.openFor(makeOp());
    await panel.send("hola");
    expect(send).toHaveBeenCalledWith("op-mibli", "hola", null);
    expect(host.querySelectorAll(".teammate-bubble:not(.teammate-typing)").length).toBe(1);
  });

  it("shows typing indicator after send and replaces it on incoming reply", async () => {
    let captured: ((m: import("../api").TeammateMessage) => void) | null = null;
    const host = document.createElement("div");
    const panel = new TeammatePanel(host, {
      listMessages:  vi.fn().mockResolvedValue([]),
      sendText:      vi.fn().mockResolvedValue({
        id: "u1", operator_id: "op-mibli", task_id: null, role: "user",
        content: { kind: "text", data: "hola" }, created_at_unix_ms: 1,
      }),
      listOperators: vi.fn().mockResolvedValue([]),
      onMessage: vi.fn(async (h) => { captured = h; return () => {}; }),
    });
    await panel.openFor(makeOp());
    await panel.send("hola");
    expect(host.querySelector(".teammate-typing")).not.toBeNull();
    captured!({
      id: "m1", operator_id: "op-mibli", task_id: null, role: "operator",
      content: { kind: "text", data: "hola, ¿en qué te ayudo?" }, created_at_unix_ms: 2,
    });
    expect(host.querySelector(".teammate-typing")).toBeNull();
    const bubbles = host.querySelectorAll(".teammate-bubble:not(.teammate-typing)");
    expect(bubbles.length).toBe(2);
  });

  it("opens a switcher with all operators on header click", async () => {
    const host = document.createElement("div");
    const ops = [makeOp(), makeOp({ id: "op-k", name: "Karluiz", is_default: false })];
    const panel = new TeammatePanel(host, {
      listMessages:  vi.fn().mockResolvedValue([]),
      sendText:      vi.fn(),
      listOperators: vi.fn().mockResolvedValue(ops),
    });
    await panel.openFor(makeOp());
    (host.querySelector(".teammate-panel-header") as HTMLElement).click();
    const rows = host.querySelectorAll(".teammate-panel-switcher-row");
    expect(rows.length).toBe(2);
    expect(host.textContent).toMatch(/Karluiz/);
  });

  it("passes active session id from resolver to sendText", async () => {
    const host = document.createElement("div");
    const send = vi.fn().mockResolvedValue({
      id: "u1", operator_id: "op-mibli", task_id: null, role: "user",
      content: { kind: "text", data: "hola" }, created_at_unix_ms: 1,
    });
    const panel = new TeammatePanel(host, {
      listMessages:  vi.fn().mockResolvedValue([]),
      sendText:      send,
      listOperators: vi.fn().mockResolvedValue([]),
      getActiveSessionId: () => "session-abc",
    });
    await panel.openFor(makeOp());
    await panel.send("hola");
    expect(send).toHaveBeenCalledWith("op-mibli", "hola", "session-abc");
  });
});
