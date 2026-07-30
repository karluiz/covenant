import { describe, it, expect, vi } from "vitest";
import { TerminalFinder } from "./finder";

function mount() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const findNext = vi.fn();
  const addon = {
    findNext,
    findPrevious: vi.fn(),
    clearDecorations: vi.fn(),
    onDidChangeResults: vi.fn(),
  };
  const term = { getSelection: () => "", focus: vi.fn() };
  const finder = new TerminalFinder(host, term as never, addon as never);
  const input = host.querySelector(".term-finder__input") as HTMLInputElement;
  const exact = host.querySelector('[data-act="exact"]') as HTMLButtonElement;
  const regex = host.querySelector('[data-act="regex"]') as HTMLButtonElement;
  return { finder, input, exact, regex, findNext, root: host };
}

describe("TerminalFinder exact toggle", () => {
  it("defaults to partial and flips to whole-word + case-sensitive", () => {
    const { input, exact, findNext } = mount();
    input.value = "1234";
    input.dispatchEvent(new Event("input"));
    expect(findNext).toHaveBeenLastCalledWith(
      "1234",
      expect.objectContaining({ wholeWord: false, caseSensitive: false }),
    );

    exact.click();
    expect(exact.getAttribute("aria-pressed")).toBe("true");
    expect(findNext).toHaveBeenLastCalledWith(
      "1234",
      expect.objectContaining({ wholeWord: true, caseSensitive: true }),
    );

    exact.click();
    expect(findNext).toHaveBeenLastCalledWith(
      "1234",
      expect.objectContaining({ wholeWord: false, caseSensitive: false }),
    );
  });

  it("toggles regex independently", () => {
    const { input, regex, findNext } = mount();
    input.value = "err(or)?";
    input.dispatchEvent(new Event("input"));
    expect(findNext).toHaveBeenLastCalledWith("err(or)?", expect.objectContaining({ regex: false }));

    regex.click();
    expect(regex.getAttribute("aria-pressed")).toBe("true");
    expect(findNext).toHaveBeenLastCalledWith("err(or)?", expect.objectContaining({ regex: true }));
  });

  it("shows a half-typed regex as no-match instead of throwing", () => {
    const { input, regex, findNext, root } = mount();
    regex.click();
    findNext.mockImplementation(() => {
      throw new SyntaxError("Invalid regular expression");
    });
    input.value = "foo(";
    expect(() => input.dispatchEvent(new Event("input"))).not.toThrow();
    expect(root.querySelector(".term-finder")!.classList).toContain("term-finder--nomatch");
  });
});
