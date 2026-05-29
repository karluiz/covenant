import { describe, it, expect, beforeEach } from "vitest";
import { ComposerInput } from "./composer-input";

let host: HTMLElement;
let ci: ComposerInput;

beforeEach(() => {
  document.body.innerHTML = "";
  host = document.createElement("div");
  document.body.appendChild(host);
  ci = new ComposerInput(host, { placeholder: "x" });
});

describe("ComposerInput", () => {
  it("emits input event on text change", () => {
    let count = 0;
    ci.onInput(() => count++);
    ci.element().textContent = "hi";
    ci.element().dispatchEvent(new InputEvent("input"));
    expect(count).toBe(1);
  });

  it("getValue serializes text + chip tokens", () => {
    ci.element().textContent = "see ";
    const range = document.createRange();
    range.selectNodeContents(ci.element());
    range.collapse(false);
    ci.replaceQueryWithChip(range, { kind: "files", token: "a/b.ts", label: "b.ts" }, "");
    ci.element().append(document.createTextNode(" please"));
    expect(ci.getValue()).toBe("see @a/b.ts  please");
  });

  it("setValue clears chips and writes plain text", () => {
    ci.setValue("hello");
    expect(ci.getValue()).toBe("hello");
    expect(ci.element().querySelectorAll(".tmt-chip").length).toBe(0);
  });

  it("chip nodes are contenteditable=false and carry kind+token data", () => {
    const r = document.createRange();
    ci.element().textContent = "";
    r.selectNodeContents(ci.element()); r.collapse(false);
    ci.replaceQueryWithChip(r, { kind: "sessions", token: "session:abc", label: "tab 2" }, "");
    const chip = ci.element().querySelector(".tmt-chip")!;
    expect(chip.getAttribute("contenteditable")).toBe("false");
    expect((chip as HTMLElement).dataset.kind).toBe("sessions");
    expect((chip as HTMLElement).dataset.token).toBe("session:abc");
  });

  it("starts marked empty so the placeholder shows", () => {
    expect(ci.element().classList.contains("is-empty")).toBe(true);
  });

  it("drops is-empty once real text is present", () => {
    ci.element().textContent = "hi";
    ci.element().dispatchEvent(new InputEvent("input"));
    expect(ci.element().classList.contains("is-empty")).toBe(false);
  });

  it("restores is-empty when a leftover <br> is all that remains after delete", () => {
    // WebKit leaves a bogus <br> behind after you type then delete the
    // last character, so the div is no longer CSS :empty. Material
    // emptiness must still be detected so the placeholder returns.
    ci.element().textContent = "x";
    ci.element().dispatchEvent(new InputEvent("input"));
    expect(ci.element().classList.contains("is-empty")).toBe(false);
    ci.element().innerHTML = "<br>";
    ci.element().dispatchEvent(new InputEvent("input"));
    expect(ci.element().classList.contains("is-empty")).toBe(true);
  });

  it("clear() marks the composer empty", () => {
    ci.setValue("hello");
    ci.clear();
    expect(ci.element().classList.contains("is-empty")).toBe(true);
  });

  it("chips() returns kind+token pairs in DOM order", () => {
    ci.element().textContent = "";
    const r1 = document.createRange(); r1.selectNodeContents(ci.element()); r1.collapse(false);
    ci.replaceQueryWithChip(r1, { kind: "files", token: "a.ts", label: "a.ts" }, "");
    const r2 = document.createRange(); r2.selectNodeContents(ci.element()); r2.collapse(false);
    ci.replaceQueryWithChip(r2, { kind: "commands", token: "cmd:01H", label: "ls" }, "");
    expect(ci.chips()).toEqual([
      { kind: "files", token: "a.ts" },
      { kind: "commands", token: "cmd:01H" },
    ]);
  });
});
