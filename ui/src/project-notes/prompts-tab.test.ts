import { describe, it, expect, beforeEach, vi } from "vitest";
import { PromptsTab } from "./prompts-tab";

vi.mock("./api", () => {
  const state: any = { prompts: [] };
  return {
    promptsApi: {
      list: vi.fn(async () => [...state.prompts]),
      create: vi.fn(async (title: string, body: string) => {
        const p = {
          id: `id-${state.prompts.length}`,
          title,
          body,
          sort_order: state.prompts.length,
          created_at_unix_ms: 0,
          updated_at_unix_ms: 0,
        };
        state.prompts.push(p);
        return p;
      }),
      update: vi.fn(async (id: string, title: string, body: string) => {
        const p = state.prompts.find((x: any) => x.id === id);
        if (p) {
          p.title = title;
          p.body = body;
        }
        return p ?? null;
      }),
      delete: vi.fn(async (id: string) => {
        state.prompts = state.prompts.filter((x: any) => x.id !== id);
      }),
      reorder: vi.fn(async () => {}),
    },
    __state: state,
  };
});

vi.mock("./paste", () => ({
  sendToActiveTabInGroup: vi.fn(async () => {}),
}));

describe("PromptsTab", () => {
  let host: HTMLElement;
  beforeEach(async () => {
    document.body.innerHTML = "";
    host = document.createElement("div");
    document.body.appendChild(host);
    const mod = (await import("./api")) as any;
    mod.__state.prompts = [];
  });

  it("creates and renders a prompt", async () => {
    const tab = new PromptsTab({ groupId: "g1" }).mount(host);
    await tab.refresh();
    (host.querySelector(".pn-prompt-new") as HTMLButtonElement).click();
    (host.querySelector(".pn-prompt-title-input") as HTMLInputElement).value =
      "Review";
    (host.querySelector(".pn-prompt-body-input") as HTMLTextAreaElement).value =
      "review the diff";
    (host.querySelector(".pn-prompt-save") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(host.querySelector(".pn-prompt-title")?.textContent).toBe("Review");
    expect(host.querySelector(".rail-row .rail-name.pn-prompt-title")).not.toBeNull();
    expect(host.querySelector(".rail-new.pn-prompt-new")).not.toBeNull();
  });

  it("send calls sendToActiveTabInGroup with the body", async () => {
    const apiMod = (await import("./api")) as any;
    apiMod.__state.prompts = [
      {
        id: "p1",
        title: "Review",
        body: "review the diff",
        sort_order: 0,
        created_at_unix_ms: 0,
        updated_at_unix_ms: 0,
      },
    ];
    const pasteMod = await import("./paste");
    const tab = new PromptsTab({ groupId: "g1" }).mount(host);
    await tab.refresh();
    (host.querySelector(".pn-prompt-send") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(pasteMod.sendToActiveTabInGroup).toHaveBeenCalledWith(
      "g1",
      "review the diff",
    );
  });

  it("reorders prompts and persists the new order", async () => {
    const apiMod = (await import("./api")) as any;
    apiMod.__state.prompts = ["a", "b", "c"].map((t, i) => ({
      id: `p${i}`,
      title: t,
      body: t,
      sort_order: i,
      created_at_unix_ms: 0,
      updated_at_unix_ms: 0,
    }));
    const tab = new PromptsTab({ groupId: "g1" }).mount(host);
    await tab.refresh();
    // Move "a" (p0) to where "c" (p2) is.
    tab.applyReorder("p0", "p2");
    await new Promise((r) => setTimeout(r, 0));
    expect(apiMod.promptsApi.reorder).toHaveBeenCalledWith(["p1", "p2", "p0"]);
  });
});
