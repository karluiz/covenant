import { describe, it, expect, beforeEach, vi } from "vitest";
import { NotesTab } from "./notes-tab";

vi.mock("./api", () => {
  const state: any = { commands: [], notes: [], docs: "" };
  return {
    projectNotesApi: {
      snapshot: vi.fn(async () => ({ ...state, notes: [...state.notes] })),
      appendNote: vi.fn(async (groupId: string, body: string) => {
        const n = { id: `n-${state.notes.length}`, group_id: groupId, body, created_at_unix_ms: Date.now() };
        state.notes.unshift(n);
        return n;
      }),
      deleteNote: vi.fn(async (id: string) => {
        state.notes = state.notes.filter((n: any) => n.id !== id);
      }),
    },
    __state: state,
  };
});

describe("NotesTab", () => {
  let host: HTMLElement;
  beforeEach(async () => {
    document.body.innerHTML = "";
    host = document.createElement("div");
    document.body.appendChild(host);
    const mod = (await import("./api")) as any;
    mod.__state.notes = [];
    vi.clearAllMocks();
  });

  it("appends on ⌘↵ and prepends to list", async () => {
    const tab = new NotesTab({ groupId: "g1" }).mount(host);
    await tab.refresh();
    const input = host.querySelector(".pn-note-input") as HTMLTextAreaElement;
    input.value = "first";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true }));
    await new Promise((r) => setTimeout(r, 0));
    input.value = "second";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true }));
    await new Promise((r) => setTimeout(r, 0));
    const bodies = Array.from(host.querySelectorAll(".pn-note-body")).map((e) => e.textContent);
    expect(bodies).toEqual(["second", "first"]);
  });

  it("does not append empty notes", async () => {
    const apiMod = (await import("./api")) as any;
    const tab = new NotesTab({ groupId: "g1" }).mount(host);
    await tab.refresh();
    const input = host.querySelector(".pn-note-input") as HTMLTextAreaElement;
    input.value = "   ";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true }));
    await new Promise((r) => setTimeout(r, 0));
    expect(apiMod.projectNotesApi.appendNote).not.toHaveBeenCalled();
  });

  it("deletes a note via the delete button", async () => {
    const apiMod = (await import("./api")) as any;
    apiMod.__state.notes = [
      { id: "n1", group_id: "g1", body: "x", created_at_unix_ms: Date.now() },
    ];
    const tab = new NotesTab({ groupId: "g1" }).mount(host);
    await tab.refresh();
    (host.querySelector(".pn-note-del") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(host.querySelector(".pn-note-card")).toBeNull();
  });
});
