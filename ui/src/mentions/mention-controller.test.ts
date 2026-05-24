import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachMentions } from "./mention-controller";

function typeInto(el: HTMLInputElement, text: string): void {
  el.value = text;
  el.setSelectionRange(text.length, text.length);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("attachMentions", () => {
  let input: HTMLInputElement;
  let search: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    input = document.createElement("input");
    document.body.append(input);
    search = vi.fn(async (_q: string, _n: number) => [
      { path: "src/api.ts" },
      { path: "src/main.ts" },
    ]);
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  it("opens popup on '@' and inserts selected path on Enter", async () => {
    const handle = attachMentions(input, { searchFiles: search });
    typeInto(input, "hey @ap");
    await vi.advanceTimersByTimeAsync(100);
    expect(search).toHaveBeenCalledWith("ap", 8);
    const popup = document.querySelector(".mention-popup")!;
    expect(popup.classList.contains("is-hidden")).toBe(false);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(input.value).toBe("hey @src/api.ts ");
    handle.detach();
  });

  it("ignores '@' that follows a non-whitespace char (e.g. email)", async () => {
    attachMentions(input, { searchFiles: search });
    typeInto(input, "foo@bar");
    await vi.advanceTimersByTimeAsync(100);
    expect(search).not.toHaveBeenCalled();
  });

  it("closes the popup on Escape", async () => {
    attachMentions(input, { searchFiles: search });
    typeInto(input, "hi @a");
    await vi.advanceTimersByTimeAsync(100);
    const popup = document.querySelector(".mention-popup")!;
    expect(popup.classList.contains("is-hidden")).toBe(false);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(popup.classList.contains("is-hidden")).toBe(true);
  });

  it("closes the popup when user types whitespace after @query", async () => {
    attachMentions(input, { searchFiles: search });
    typeInto(input, "hi @a");
    await vi.advanceTimersByTimeAsync(100);
    typeInto(input, "hi @a ");
    const popup = document.querySelector(".mention-popup")!;
    expect(popup.classList.contains("is-hidden")).toBe(true);
  });
});
