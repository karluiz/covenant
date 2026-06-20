import { describe, it, expect } from "vitest";
import { looksLikePrompt, shouldHint, mountPromptHint } from "./prompt-detect";
import type { Terminal } from "@xterm/xterm";

// Minimal Terminal stub: only the fields mountPromptHint reads for anchoring.
const fakeTerm = (): Terminal =>
  ({
    buffer: { active: { cursorY: 0 } },
    _core: { _renderService: { dimensions: { css: { cell: { width: 9, height: 17 } } } } },
  } as unknown as Terminal);

describe("looksLikePrompt", () => {
  it("detects natural-language / question lines", () => {
    for (const s of [
      "how to reload env",
      "what is this?",
      "why did it fail",
      "how do i undo this",
      "can you explain the error",
      "tell me the current branch",
    ]) {
      expect(looksLikePrompt(s), s).toBe(true);
    }
  });

  it("ignores real commands and shell syntax", () => {
    for (const s of [
      "git status",
      "npm run dev",
      "ls -la",
      "./build.sh",
      "make",
      "FOO=bar cmd",
      "htop",
      "cd ~/src",
      "cat a | grep b",
      "echo $HOME",
      "",
    ]) {
      expect(looksLikePrompt(s), s).toBe(false);
    }
  });
});

describe("shouldHint", () => {
  it("is true only on a bare shell, with Recall hidden, for prose", () => {
    expect(shouldHint({ bareShell: true, recallVisible: false, line: "how to x" })).toBe(true);
    expect(shouldHint({ bareShell: false, recallVisible: false, line: "how to x" })).toBe(false);
    expect(shouldHint({ bareShell: true, recallVisible: true, line: "how to x" })).toBe(false);
    expect(shouldHint({ bareShell: true, recallVisible: false, line: "git status" })).toBe(false);
  });
});

describe("mountPromptHint", () => {
  it("starts hidden, shows on update(true,...), hides on update(false,...)", () => {
    const host = document.createElement("div");
    const hint = mountPromptHint(host, fakeTerm());
    const el = host.querySelector(".prompt-hint") as HTMLElement;
    expect(el).toBeTruthy();
    expect(el.hidden).toBe(true);
    expect(hint.shown).toBe(false);

    hint.update(true, "how to reload env");
    expect(hint.shown).toBe(true);
    expect(hint.line).toBe("how to reload env");
    expect(el.hidden).toBe(false);
    expect(el.textContent).toContain("super-agent");

    hint.update(false, "");
    expect(hint.shown).toBe(false);
    expect(el.hidden).toBe(true);

    hint.dispose();
    expect(host.querySelector(".prompt-hint")).toBeNull();
  });

  it("override() hides and sets overridden; reset() clears it", () => {
    const host = document.createElement("div");
    const hint = mountPromptHint(host, fakeTerm());
    hint.update(true, "what is this");
    hint.override();
    expect(hint.overridden).toBe(true);
    expect(hint.shown).toBe(false);
    hint.reset();
    expect(hint.overridden).toBe(false);
  });

  it("stays hidden when update(true,...) is called after override()", () => {
    const host = document.createElement("div");
    const hint = mountPromptHint(host, fakeTerm());
    const el = host.querySelector(".prompt-hint") as HTMLElement;
    hint.update(true, "what is this");
    hint.override();
    hint.update(true, "still the same line"); // overridden → must NOT show
    expect(hint.shown).toBe(false);
    expect(el.hidden).toBe(true);
  });
});
