import { describe, expect, it, vi } from "vitest";

import type { Operator, ReadResult } from "../api";
import {
  activeMentionAt, collectMentionedPaths, expandMentions, MentionPopup,
  type MentionRegistry,
} from "./mentions";
import { ComposerInput } from "./composer-input";
import type { MentionSourcesDeps } from "./mention-sources";

function fakeOp(name = "claude"): Operator {
  return {
    id: "op1", name, emoji: "", color: "", tags: [], persona: "",
    escalate_threshold: 0, model: "gpt-4o", hard_constraints: "",
    voice: "Terse", is_default: true,
    created_at_unix_ms: 0, updated_at_unix_ms: 0, xp: 0,
    github_access: "Off",
    acp_enabled: false,
    perception_enabled: false,
  };
}

function harness(over: Partial<MentionSourcesDeps> = {}, cwd: string | null = "/repo") {
  document.body.innerHTML = "";
  const host = document.createElement("div");
  document.body.appendChild(host);
  const input = new ComposerInput(host);
  const deps: MentionSourcesDeps = {
    findFiles:          async () => [],
    listOperators:      async () => [],
    listOpenSessions:   () => [],
    findRecentCommands: async () => [],
    findSpecs:          async () => [],
    ...over,
  };
  const onPick = vi.fn();
  const popup = new MentionPopup({
    input, anchor: host, getCwd: () => cwd, sources: deps, onPick,
  });
  return { popup, input, host, onPick };
}

function placeCaretAtEnd(el: HTMLElement): void {
  const last = el.lastChild;
  const r = document.createRange();
  if (last && last.nodeType === Node.TEXT_NODE) {
    const len = (last.textContent ?? "").length;
    r.setStart(last, len); r.setEnd(last, len);
  } else {
    r.selectNodeContents(el); r.collapse(false);
  }
  const s = window.getSelection()!; s.removeAllRanges(); s.addRange(r);
}
const flush = () => new Promise((r) => setTimeout(r, 200));

describe("activeMentionAt", () => {
  it("detects mention at start of input", () => {
    expect(activeMentionAt("@foo", 4)).toEqual({ start: 0, query: "foo" });
  });
  it("detects mention after whitespace", () => {
    expect(activeMentionAt("hi @bar", 7)).toEqual({ start: 3, query: "bar" });
  });
  it("returns null when @ is preceded by non-whitespace", () => {
    expect(activeMentionAt("user@ho", 7)).toBeNull();
  });
  it("returns null when caret is past a space", () => {
    expect(activeMentionAt("@foo bar", 8)).toBeNull();
  });
});

describe("collectMentionedPaths (legacy)", () => {
  it("returns absolute paths in first-seen order, deduped", () => {
    const m = new Map<string, string>([
      ["src/a.ts", "/abs/a.ts"],
      ["src/b.ts", "/abs/b.ts"],
    ]);
    expect(collectMentionedPaths("see @src/b.ts and @src/a.ts and @src/b.ts", m))
      .toEqual(["/abs/b.ts", "/abs/a.ts"]);
  });
  it("ignores unknown tokens", () => {
    expect(collectMentionedPaths("@nope here", new Map())).toEqual([]);
  });
});

describe("expandMentions", () => {
  const readOk = (_path: string, content: string): ReadResult =>
    ({ kind: "text", content, size_bytes: content.length });

  it("inlines mentioned file contents with a fenced block per file", async () => {
    const reg: MentionRegistry = new Map([
      ["src/a.ts", { kind: "files", abs: "/abs/a.ts", rel: "src/a.ts" }],
    ]);
    const reader = vi.fn().mockResolvedValue(readOk("/abs/a.ts", "export const x = 1;"));
    const out = await expandMentions("look at @src/a.ts please", reg, reader);
    expect(reader).toHaveBeenCalledWith("/abs/a.ts", 256 * 1024);
    expect(out.attached).toEqual(["src/a.ts"]);
    expect(out.text).toContain("--- Mentioned ---");
    expect(out.text).toContain("### src/a.ts");
    expect(out.text).toContain("```ts");
    expect(out.text).toContain("export const x = 1;");
  });

  it("skips too_large files with a notice", async () => {
    const reg: MentionRegistry = new Map([
      ["big.bin", { kind: "files", abs: "/abs/big.bin", rel: "big.bin" }],
    ]);
    const reader = vi.fn().mockResolvedValue({ kind: "too_large", content: null, size_bytes: 999999 } as ReadResult);
    const out = await expandMentions("@big.bin", reg, reader);
    expect(out.attached).toEqual([]);
    expect(out.skipped[0].path).toBe("big.bin");
    expect(out.text).toContain("skipped");
  });

  it("returns rawText unchanged when no mentions match", async () => {
    const out = await expandMentions("plain text", new Map(), vi.fn());
    expect(out.text).toBe("plain text");
    expect(out.attached).toEqual([]);
  });

  it("expands a command chip into a fenced block", async () => {
    const reg: MentionRegistry = new Map([
      ["cmd:01H", { kind: "commands", block_id: "01H", session_id: "S1" }],
    ]);
    const res = await expandMentions("look at @cmd:01H", reg, undefined, {
      readBlock: async () => ({ command: "cargo test", exit_code: 1, cwd: "/r", plain_output: "FAIL\n" }),
    });
    expect(res.text).toMatch(/cargo test/);
    expect(res.text).toMatch(/exit/);
    expect(res.text).toMatch(/FAIL/);
  });

  it("expands a session chip with recent blocks", async () => {
    const reg: MentionRegistry = new Map([
      ["session:01H", { kind: "sessions", session_id: "S1", cwd: "/r", shell: "zsh", tab_index: 2, block_count: 2, last_command: "cargo test" }],
    ]);
    const res = await expandMentions("diff @session:01H", reg, undefined, {
      readSession: async () => ({
        cwd: "/r", shell: "zsh", tab_index: 2,
        recent: [
          { command: "ls", exit_code: 0, tail: "a\nb\n" },
          { command: "cargo test", exit_code: 1, tail: "FAIL\n" },
        ],
      }),
    });
    expect(res.text).toMatch(/cargo test/);
    expect(res.text).toMatch(/FAIL/);
  });

  it("inlines a spec chip as a fenced markdown section with id+title header", async () => {
    const reg: MentionRegistry = new Map([
      ["spec:3.23", {
        kind: "specs", abs: "/abs/docs/superpowers/specs/3.23.md",
        id: "3.23", title: "Achievements", goal: "Operators earn XP.",
      }],
    ]);
    const reader = vi.fn().mockResolvedValue(readOk("/abs/docs/superpowers/specs/3.23.md", "# Heading\n\nbody"));
    const out = await expandMentions("review @spec:3.23", reg, reader);
    expect(reader).toHaveBeenCalledWith("/abs/docs/superpowers/specs/3.23.md", 256 * 1024);
    expect(out.attached).toEqual(["spec:3.23"]);
    expect(out.text).toContain("### spec 3.23: Achievements");
    expect(out.text).toContain("> Operators earn XP.");
    expect(out.text).toContain("```md");
    expect(out.text).toContain("# Heading");
  });

  it("teammate chip becomes a one-line reference", async () => {
    const reg: MentionRegistry = new Map([
      ["teammate:claude", { kind: "teammates", operator_id: "op1", name: "claude" }],
    ]);
    const res = await expandMentions("hey @teammate:claude", reg);
    expect(res.text).toMatch(/teammate @claude.*op1/);
  });
});

describe("MentionPopup v2", () => {
  it("opens on @ even when no source returns hits", async () => {
    const { popup, input } = harness();
    input.element().textContent = "@";
    placeCaretAtEnd(input.element());
    input.element().dispatchEvent(new InputEvent("input"));
    await flush();
    expect(popup.isOpen()).toBe(true);
    expect(popup.currentEl()?.querySelector(".tmt-mp-foot")).toBeTruthy();
  });

  it("renders 6 rail categories and shows footer key hints", async () => {
    const { popup, input } = harness({ listOperators: async () => [fakeOp()] });
    input.element().textContent = "@";
    placeCaretAtEnd(input.element());
    input.element().dispatchEvent(new InputEvent("input"));
    await flush();
    expect(popup.currentEl()!.querySelectorAll(".tmt-mp-rail-item").length).toBe(6);
    expect(popup.currentEl()!.textContent).toMatch(/nav/);
  });

  it("null cwd does not silently kill the picker — other sources still render", async () => {
    const { popup, input } = harness({ listOperators: async () => [fakeOp()] }, null);
    input.element().textContent = "@";
    placeCaretAtEnd(input.element());
    input.element().dispatchEvent(new InputEvent("input"));
    await flush();
    expect(popup.isOpen()).toBe(true);
    const txt = popup.currentEl()!.textContent ?? "";
    expect(txt).toMatch(/claude|teammate|no active session/i);
  });

  it("Esc closes", async () => {
    const { popup, input } = harness();
    input.element().textContent = "@";
    placeCaretAtEnd(input.element());
    input.element().dispatchEvent(new InputEvent("input"));
    await flush();
    expect(popup.isOpen()).toBe(true);
    input.element().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(popup.isOpen()).toBe(false);
  });
});
