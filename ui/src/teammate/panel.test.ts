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

  it("renders an avatar in the header", async () => {
    const host = document.createElement("div");
    const panel = new TeammatePanel(host, {
      listMessages:  vi.fn().mockResolvedValue([]),
      sendText:      vi.fn(),
      listOperators: vi.fn().mockResolvedValue([]),
    });
    await panel.openFor(makeOp());
    expect(host.querySelector(".teammate-panel-avatar")).not.toBeNull();
    expect(host.querySelector(".teammate-panel-title")?.textContent).toBe("Mibli");
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
    expect(send).toHaveBeenCalledWith("op-mibli", "hola");
    expect(host.querySelectorAll(".teammate-bubble").length).toBe(1);
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
});
