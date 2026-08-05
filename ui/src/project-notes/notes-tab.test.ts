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
      setPinned: vi.fn(async (id: string, pinned: boolean) => {
        const n = state.notes.find((n: any) => n.id === id);
        if (n) n.pinned = pinned;
        return n ?? null;
      }),
    },
    __state: state,
  };
});

/** Both modifier bits set, so the assertion holds on macOS (Command) and on
 *  the Ctrl platforms `modHeld`/`appModHeld` fall back to. */
function chord(key: string, shift = false): KeyboardEvent {
  return new KeyboardEvent("keydown", {
    key,
    metaKey: true,
    ctrlKey: true,
    shiftKey: shift,
    bubbles: true,
    cancelable: true,
  });
}

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
      { id: "a", group_id: "g1", body: "title line\nl2\nl3\nl4\nl5\nl6", source: null, created_at_unix_ms: Date.now() },
    ];
    const tab = new NotesTab({ groupId: "g1" }).mount(host);
    await tab.refresh();
    const fold = () => host.querySelector(".pn-note-fold") as HTMLButtonElement;
    // Line 1 became the title, so the fold counts the 5 lines under it.
    expect(host.querySelector(".pn-note-title")?.textContent).toBe("title line");
    expect(host.querySelector(".pn-note-card")!.classList).toContain("is-folded");
    expect(fold().textContent).toBe("+2 lines");

    fold().click();
    expect(host.querySelector(".pn-note-card")!.classList).not.toContain("is-folded");
    expect(fold().textContent).toBe("Show less");
    expect(host.querySelector(".pn-note-editor")).toBeNull();
  });

  it("derives a title from a markdown heading and drops the marker", async () => {
    const apiMod = (await import("./api")) as any;
    apiMod.__state.notes = [
      { id: "a", group_id: "g1", body: "## Tenant model\n\nla jerarquía es plana", source: null, created_at_unix_ms: Date.now() },
    ];
    const tab = new NotesTab({ groupId: "g1" }).mount(host);
    await tab.refresh();
    expect(host.querySelector(".pn-note-title")?.textContent).toBe("Tenant model");
    expect(host.querySelector(".pn-note-body")?.textContent).toContain("jerarquía");
    expect(host.querySelector(".pn-note-body")?.textContent).not.toContain("Tenant model");
  });

  it("gives no title to a one-liner or to a note that opens with a list", async () => {
    const apiMod = (await import("./api")) as any;
    apiMod.__state.notes = [
      { id: "a", group_id: "g1", body: "just one line", source: null, created_at_unix_ms: Date.now() },
      { id: "b", group_id: "g1", body: "- uno\n- dos", source: null, created_at_unix_ms: Date.now() },
    ];
    const tab = new NotesTab({ groupId: "g1" }).mount(host);
    await tab.refresh();
    expect(host.querySelectorAll(".pn-note-title").length).toBe(0);
    // The list note keeps every item in the body.
    expect(host.querySelectorAll(".pn-note-card")[1].querySelectorAll("li").length).toBe(2);
  });

  it("pins a note to the top under a PINNED divider, and unpins it", async () => {
    const apiMod = (await import("./api")) as any;
    const now = Date.now();
    apiMod.__state.notes = [
      { id: "new", group_id: "g1", body: "newest", source: null, created_at_unix_ms: now, pinned: false },
      { id: "old", group_id: "g1", body: "oldest", source: null, created_at_unix_ms: now - 5 * 86_400_000, pinned: false },
    ];
    const tab = new NotesTab({ groupId: "g1" }).mount(host);
    await tab.refresh();
    const rowFor = (id: string) => host.querySelector(`.pn-note-card[data-id="${id}"]`) as HTMLElement;

    (rowFor("old").querySelector(".pn-note-pin") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(apiMod.projectNotesApi.setPinned).toHaveBeenCalledWith("old", true);
    expect(host.querySelector(".pn-note-day")?.textContent).toBe("pinned");
    // The old note now leads, ahead of the newer one.
    const order = Array.from(host.querySelectorAll(".pn-note-card")).map((e) => (e as HTMLElement).dataset.id);
    expect(order).toEqual(["old", "new"]);
    expect(rowFor("old").classList).toContain("is-pinned");

    (rowFor("old").querySelector(".pn-note-pin") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(apiMod.projectNotesApi.setPinned).toHaveBeenLastCalledWith("old", false);
    expect(host.querySelector(".pn-note-day")?.textContent).not.toBe("pinned");
  });

  it("row grammar: arrows move the cursor, ⌘E edits it, ⌘⌫ deletes it", async () => {
    const apiMod = (await import("./api")) as any;
    const now = Date.now();
    apiMod.__state.notes = [
      { id: "a", group_id: "g1", body: "first", source: null, created_at_unix_ms: now },
      { id: "b", group_id: "g1", body: "second", source: null, created_at_unix_ms: now - 1000 },
    ];
    const tab = new NotesTab({ groupId: "g1" }).mount(host);
    await tab.refresh();
    const list = host.querySelector(".pn-note-list") as HTMLElement;
    const down = () => list.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));

    down();
    expect((host.querySelector(".is-cursor") as HTMLElement).dataset.id).toBe("a");
    down();
    expect((host.querySelector(".is-cursor") as HTMLElement).dataset.id).toBe("b");

    list.dispatchEvent(chord("e"));
    const editor = host.querySelector(".pn-note-editor-input") as HTMLTextAreaElement;
    expect(editor).not.toBeNull();
    expect(editor.value).toBe("second"); // the cursor row, not the first row
    (host.querySelector(".pn-note-cancel") as HTMLButtonElement).click();

    list.dispatchEvent(chord("Backspace", true));
    expect(host.querySelector('.pn-note-card[data-id="b"]')).toBeNull();
    expect(host.querySelector(".pn-note-undo")).not.toBeNull();
  });

  it("row grammar does not fire while typing in the composer", async () => {
    const apiMod = (await import("./api")) as any;
    apiMod.__state.notes = [
      { id: "a", group_id: "g1", body: "keep", source: null, created_at_unix_ms: Date.now() },
    ];
    const tab = new NotesTab({ groupId: "g1" }).mount(host);
    await tab.refresh();
    const list = host.querySelector(".pn-note-list") as HTMLElement;
    list.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(host.querySelector(".is-cursor")).not.toBeNull();

    // Same chord, dispatched from the textarea: the field keeps it.
    const input = host.querySelector(".pn-note-input") as HTMLTextAreaElement;
    input.dispatchEvent(chord("Backspace", true));
    expect(host.querySelector('.pn-note-card[data-id="a"]')).not.toBeNull();
    expect(apiMod.projectNotesApi.deleteNote).not.toHaveBeenCalled();
  });

  it("⌘F jumps to the filter", async () => {
    const apiMod = (await import("./api")) as any;
    apiMod.__state.notes = [
      { id: "a", group_id: "g1", body: "one", source: null, created_at_unix_ms: Date.now() },
      { id: "b", group_id: "g1", body: "two", source: null, created_at_unix_ms: Date.now() },
    ];
    const tab = new NotesTab({ groupId: "g1" }).mount(host);
    await tab.refresh();
    const filter = host.querySelector(".rail-search input") as HTMLInputElement;
    (host.querySelector(".pn-note-list") as HTMLElement).dispatchEvent(chord("f"));
    expect(document.activeElement).toBe(filter);
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
