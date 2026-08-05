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
      updateNote: vi.fn(async (id: string, body: string) => {
        const n = state.notes.find((n: any) => n.id === id);
        if (n) n.body = body;
        return n ?? null;
      }),
      listNotes: vi.fn(async () => []),
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
    expect(host.querySelector(".rail-row.pn-note-card")).not.toBeNull();
    (host.querySelector(".pn-note-del") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(host.querySelector(".pn-note-card")).toBeNull();
  });

  it("renders a source line when present, omits it when absent", async () => {
    const apiMod = (await import("./api")) as any;
    apiMod.__state.notes = [
      { id: "a", group_id: "g1", body: "hello", source: "from Claude · tab 2", created_at_unix_ms: Date.now() },
      { id: "b", group_id: "g1", body: "hello", source: null, created_at_unix_ms: Date.now() },
    ];
    const tab = new NotesTab({ groupId: "g1" }).mount(host);
    await tab.refresh();
    const cards = host.querySelectorAll(".pn-note-card");
    expect(cards[0].querySelector(".pn-note-source")?.textContent).toBe("from Claude · tab 2");
    expect(cards[1].querySelector(".pn-note-source")).toBeNull();
  });

  it("saves an edit via updateNote", async () => {
    const apiMod = (await import("./api")) as any;
    apiMod.__state.notes = [
      { id: "n1", group_id: "g1", body: "hello", source: null, created_at_unix_ms: Date.now() },
    ];
    const tab = new NotesTab({ groupId: "g1" }).mount(host);
    await tab.refresh();
    (host.querySelector(".pn-note-edit") as HTMLButtonElement).click();
    const ta = host.querySelector(".pn-note-editor-input") as HTMLTextAreaElement;
    ta.value = "edited";
    (host.querySelector(".pn-note-save") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(apiMod.projectNotesApi.updateNote).toHaveBeenCalledWith("n1", "edited");
    expect(host.querySelector(".pn-note-body")?.textContent).toBe("edited");
  });

  it("cancels an edit without touching the note", async () => {
    const apiMod = (await import("./api")) as any;
    apiMod.__state.notes = [
      { id: "n1", group_id: "g1", body: "hello", source: null, created_at_unix_ms: Date.now() },
    ];
    const tab = new NotesTab({ groupId: "g1" }).mount(host);
    await tab.refresh();
    (host.querySelector(".pn-note-edit") as HTMLButtonElement).click();
    const card = host.querySelector(".pn-note-card") as HTMLElement;
    expect(card.classList).toContain("is-editing");
    (host.querySelector(".pn-note-editor-input") as HTMLTextAreaElement).value = "throwaway";
    (host.querySelector(".pn-note-cancel") as HTMLButtonElement).click();
    expect(host.querySelector(".pn-note-editor")).toBeNull();
    expect(card.classList).not.toContain("is-editing");
    expect(apiMod.projectNotesApi.updateNote).not.toHaveBeenCalled();
    expect(host.querySelector(".pn-note-body")?.textContent).toBe("hello");
  });

  it("delete is recoverable — undo restores the note and never hits the backend", async () => {
    const apiMod = (await import("./api")) as any;
    apiMod.__state.notes = [
      { id: "n1", group_id: "g1", body: "keep me", created_at_unix_ms: Date.now() },
    ];
    const tab = new NotesTab({ groupId: "g1" }).mount(host);
    await tab.refresh();
    (host.querySelector(".pn-note-del") as HTMLButtonElement).click();
    expect(host.querySelector(".pn-note-card")).toBeNull();
    expect(host.querySelector(".pn-note-undo")).not.toBeNull();

    (host.querySelector(".pn-note-undo-btn") as HTMLButtonElement).click();
    expect(host.querySelector(".pn-note-undo")).toBeNull();
    expect(host.querySelector(".pn-note-body")?.textContent).toBe("keep me");
    expect(apiMod.projectNotesApi.deleteNote).not.toHaveBeenCalled();
  });

  it("commits the delete once the undo window expires", async () => {
    vi.useFakeTimers();
    try {
      const apiMod = (await import("./api")) as any;
      apiMod.__state.notes = [
        { id: "n1", group_id: "g1", body: "bye", created_at_unix_ms: Date.now() },
      ];
      const tab = new NotesTab({ groupId: "g1" }).mount(host);
      await tab.refresh();
      (host.querySelector(".pn-note-del") as HTMLButtonElement).click();
      expect(apiMod.projectNotesApi.deleteNote).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(6000);
      expect(apiMod.projectNotesApi.deleteNote).toHaveBeenCalledWith("n1");
      expect(host.querySelector(".pn-note-undo")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("filters by body and by source", async () => {
    const apiMod = (await import("./api")) as any;
    apiMod.__state.notes = [
      { id: "a", group_id: "g1", body: "tenant hierarchy", source: null, created_at_unix_ms: Date.now() },
      { id: "b", group_id: "g1", body: "unrelated", source: "from Claude · tab 2", created_at_unix_ms: Date.now() },
    ];
    const tab = new NotesTab({ groupId: "g1" }).mount(host);
    await tab.refresh();
    const filter = host.querySelector(".rail-search input") as HTMLInputElement;

    filter.value = "TENANT";
    filter.dispatchEvent(new Event("input"));
    expect(host.querySelectorAll(".pn-note-card").length).toBe(1);
    expect(host.querySelector(".pn-note-body")?.textContent).toContain("tenant");

    filter.value = "claude";
    filter.dispatchEvent(new Event("input"));
    expect(host.querySelectorAll(".pn-note-card").length).toBe(1);
    expect(host.querySelector(".pn-note-body")?.textContent).toContain("unrelated");

    filter.value = "nothing matches this";
    filter.dispatchEvent(new Event("input"));
    expect(host.querySelectorAll(".pn-note-card").length).toBe(0);
    expect(host.querySelector(".rail-empty")).not.toBeNull();
  });

  it("renders the body as markdown", async () => {
    const apiMod = (await import("./api")) as any;
    apiMod.__state.notes = [
      { id: "a", group_id: "g1", body: "- one\n- two", source: null, created_at_unix_ms: Date.now() },
    ];
    const tab = new NotesTab({ groupId: "g1" }).mount(host);
    await tab.refresh();
    const body = host.querySelector(".pn-note-body") as HTMLElement;
    expect(body.classList).toContain("markdown-doc");
    expect(body.querySelectorAll("li").length).toBe(2);
  });

  it("folds a long note and unfolds it in place, without opening the editor", async () => {
    const apiMod = (await import("./api")) as any;
    apiMod.__state.notes = [
      { id: "a", group_id: "g1", body: "l1\nl2\nl3\nl4\nl5", source: null, created_at_unix_ms: Date.now() },
    ];
    const tab = new NotesTab({ groupId: "g1" }).mount(host);
    await tab.refresh();
    const fold = () => host.querySelector(".pn-note-fold") as HTMLButtonElement;
    expect(host.querySelector(".pn-note-card")!.classList).toContain("is-folded");
    expect(fold().textContent).toBe("+2 lines");

    fold().click();
    expect(host.querySelector(".pn-note-card")!.classList).not.toContain("is-folded");
    expect(fold().textContent).toBe("Show less");
    expect(host.querySelector(".pn-note-editor")).toBeNull();
  });

  it("leaves a short note unfolded with no affordance", async () => {
    const apiMod = (await import("./api")) as any;
    apiMod.__state.notes = [
      { id: "a", group_id: "g1", body: "one liner", source: null, created_at_unix_ms: Date.now() },
    ];
    const tab = new NotesTab({ groupId: "g1" }).mount(host);
    await tab.refresh();
    expect(host.querySelector(".pn-note-card")!.classList).not.toContain("is-folded");
    expect(host.querySelector(".pn-note-fold")).toBeNull();
  });

  it("groups rows under day dividers", async () => {
    const apiMod = (await import("./api")) as any;
    const now = Date.now();
    apiMod.__state.notes = [
      { id: "a", group_id: "g1", body: "today", source: null, created_at_unix_ms: now },
      { id: "b", group_id: "g1", body: "older", source: null, created_at_unix_ms: now - 3 * 86_400_000 },
    ];
    const tab = new NotesTab({ groupId: "g1" }).mount(host);
    await tab.refresh();
    const dividers = Array.from(host.querySelectorAll(".pn-note-day")).map((d) => d.textContent);
    expect(dividers.length).toBe(2);
    expect(dividers[0]).toBe("today");
    expect(dividers[1]).not.toBe("today");
  });

  it("keeps the draft when Escape is pressed in the composer", async () => {
    const tab = new NotesTab({ groupId: "g1" }).mount(host);
    await tab.refresh();
    const input = host.querySelector(".pn-note-input") as HTMLTextAreaElement;
    input.value = "half-written thought";
    const ev = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    const stop = vi.spyOn(ev, "stopPropagation");
    input.dispatchEvent(ev);
    expect(stop).toHaveBeenCalled();
    expect(input.value).toBe("half-written thought");
  });
});
