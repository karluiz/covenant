import { describe, expect, it, vi } from "vitest";

import { TeammatePanel } from "./panel";

describe("TeammatePanel", () => {
  it("renders the placeholder when there are no messages", async () => {
    const host = document.createElement("div");
    const panel = new TeammatePanel(host, {
      listMessages: vi.fn().mockResolvedValue([]),
      sendText:     vi.fn(),
    });
    await panel.openFor("op-mibli", "Mibli");
    expect(host.textContent ?? "").toMatch(/Sin conversación aún/);
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
      listMessages: vi.fn().mockResolvedValue([]),
      sendText:     send,
    });
    await panel.openFor("op-mibli", "Mibli");
    await panel.send("hola");
    expect(send).toHaveBeenCalledWith("op-mibli", "hola");
    expect(host.querySelectorAll(".teammate-bubble").length).toBe(1);
  });
});
