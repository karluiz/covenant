import { describe, it, expect } from "vitest";
import { looksLikePrompt, shouldHint } from "./prompt-detect";

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
