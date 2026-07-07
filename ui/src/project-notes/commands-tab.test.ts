import { describe, it, expect, beforeEach, vi } from "vitest";
import { CommandsTab } from "./commands-tab";

vi.mock("./api", () => {
  const state: any = { commands: [], notes: [], docs: "" };
  return {
    projectNotesApi: {
      snapshot: vi.fn(async () => ({ ...state, commands: [...state.commands] })),
      createCommand: vi.fn(async (groupId: string, title: string, command: string) => {
        const c = {
          id: `id-${state.commands.length}`,
          group_id: groupId,
          title,
          command,
          sort_order: state.commands.length,
          created_at_unix_ms: 0,
          updated_at_unix_ms: 0,
        };
        state.commands.push(c);
        return c;
      }),
      updateCommand: vi.fn(async (id: string, title: string, command: string) => {
        const c = state.commands.find((x: any) => x.id === id);
        if (c) {
          c.title = title;
          c.command = command;
        }
        return c ?? null;
      }),
      deleteCommand: vi.fn(async (id: string) => {
        state.commands = state.commands.filter((x: any) => x.id !== id);
      }),
    },
    __state: state,
  };
});

vi.mock("./paste", () => ({
  writeToActiveTabInGroup: vi.fn(async () => {}),
}));

describe("CommandsTab", () => {
  let host: HTMLElement;
  beforeEach(async () => {
    document.body.innerHTML = "";
    host = document.createElement("div");
    document.body.appendChild(host);
    const mod = (await import("./api")) as any;
    mod.__state.commands = [];
  });

  it("creates and renders a command", async () => {
    const tab = new CommandsTab({ groupId: "g1" }).mount(host);
    await tab.refresh();
    (host.querySelector(".pn-cmd-new") as HTMLButtonElement).click();
    (host.querySelector(".pn-cmd-title-input") as HTMLInputElement).value = "Run";
    (host.querySelector(".pn-cmd-cmd-input") as HTMLTextAreaElement).value = "npm run dev";
    (host.querySelector(".pn-cmd-save") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(host.querySelector(".pn-cmd-title")?.textContent).toBe("Run");
    expect(host.querySelector(".pn-cmd-code")?.textContent).toBe("npm run dev");
    expect(host.querySelector(".rail-row .rail-name.pn-cmd-title")).not.toBeNull();
    expect(host.querySelector(".rail-new.pn-cmd-new")).not.toBeNull();
  });

  it("paste calls writeToActiveTabInGroup with no newline", async () => {
    const apiMod = (await import("./api")) as any;
    apiMod.__state.commands = [
      {
        id: "c1",
        group_id: "g1",
        title: "X",
        command: "ls -la",
        sort_order: 0,
        created_at_unix_ms: 0,
        updated_at_unix_ms: 0,
      },
    ];
    const pasteMod = await import("./paste");
    const tab = new CommandsTab({ groupId: "g1" }).mount(host);
    await tab.refresh();
    (host.querySelector(".pn-cmd-paste") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(pasteMod.writeToActiveTabInGroup).toHaveBeenCalledWith("g1", "ls -la");
  });
});
