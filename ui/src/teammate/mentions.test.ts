import { describe, expect, it, vi } from "vitest";

import type { Operator, ReadResult } from "../api";
import { TeammatePanel } from "./panel";
import {
  activeMentionAt, collectMentionedPaths, expandMentions, MentionPopup,
} from "./mentions";

function makeOp(overrides: Partial<Operator> = {}): Operator {
  return {
    id: "op-mibli", name: "Mibli", emoji: "🤖", color: "#6B7280",
    tags: [], persona: "", escalate_threshold: 0.6,
    model: "claude-sonnet-4-6", hard_constraints: "", voice: "Terse",
    is_default: true, created_at_unix_ms: 0, updated_at_unix_ms: 0, xp: 0,
    ...overrides,
  };
}

const userMsg = (text = "hi") => ({
  id: "u1", operator_id: "op-mibli", task_id: null, role: "user" as const,
  content: { kind: "text" as const, data: text }, created_at_unix_ms: 1,
  confirmed_at_unix_ms: null, dismissed_at_unix_ms: null,
});

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

describe("collectMentionedPaths", () => {
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
    const m = new Map([["src/a.ts", "/abs/a.ts"]]);
    const reader = vi.fn().mockResolvedValue(readOk("/abs/a.ts", "export const x = 1;"));
    const out = await expandMentions("look at @src/a.ts please", m, reader);
    expect(reader).toHaveBeenCalledWith("/abs/a.ts", 256 * 1024);
    expect(out.attached).toEqual(["src/a.ts"]);
    expect(out.text).toContain("--- Mentioned files ---");
    expect(out.text).toContain("### src/a.ts");
    expect(out.text).toContain("```ts");
    expect(out.text).toContain("export const x = 1;");
  });

  it("skips too_large files with a notice", async () => {
    const m = new Map([["big.bin", "/abs/big.bin"]]);
    const reader = vi.fn().mockResolvedValue({ kind: "too_large", content: null, size_bytes: 999999 } as ReadResult);
    const out = await expandMentions("@big.bin", m, reader);
    expect(out.attached).toEqual([]);
    expect(out.skipped[0].path).toBe("big.bin");
    expect(out.text).toContain("skipped");
  });

  it("returns rawText unchanged when no mentions match", async () => {
    const out = await expandMentions("plain text", new Map(), vi.fn());
    expect(out.text).toBe("plain text");
    expect(out.attached).toEqual([]);
  });
});

describe("MentionPopup", () => {
  it("opens on @, fetches files, and inserts on Enter", async () => {
    const anchor = document.createElement("div");
    const input  = document.createElement("input");
    anchor.append(input);
    document.body.append(anchor);

    const findFiles = vi.fn().mockResolvedValue([
      { path: "/repo/src/foo.rs", rel_path: "src/foo.rs", match_indices: [] },
    ]);
    const picks: Array<[string, string]> = [];
    const popup = new MentionPopup({
      input, anchor,
      getCwd: () => "/repo",
      findFiles,
      onPick: (token, abs) => picks.push([token, abs]),
    });

    input.value = "@foo";
    input.setSelectionRange(4, 4);
    input.dispatchEvent(new Event("input"));
    await new Promise((r) => setTimeout(r, 180));

    expect(findFiles).toHaveBeenCalledWith("/repo", "foo", 20);
    expect(popup.isOpen()).toBe(true);
    expect(anchor.querySelector(".teammate-mention-row")).not.toBeNull();

    const enter = new KeyboardEvent("keydown", { key: "Enter", cancelable: true });
    input.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
    expect(input.value).toBe("@src/foo.rs ");
    expect(picks).toEqual([["src/foo.rs", "/repo/src/foo.rs"]]);
    expect(popup.isOpen()).toBe(false);
  });

  it("shows disabled notice when no cwd", () => {
    const anchor = document.createElement("div");
    const input  = document.createElement("input");
    anchor.append(input);
    const popup = new MentionPopup({
      input, anchor,
      getCwd: () => null,
      findFiles: vi.fn(),
      onPick: () => {},
    });
    input.value = "@x";
    input.setSelectionRange(2, 2);
    input.dispatchEvent(new Event("input"));
    expect(popup.isOpen()).toBe(true);
    expect(anchor.querySelector(".teammate-mention-empty")?.textContent)
      .toMatch(/No active session/);
  });
});

describe("TeammatePanel mention integration", () => {
  it("expands mentions in send() and passes payload to sendText", async () => {
    const host = document.createElement("div");
    const sendText = vi.fn().mockResolvedValue(userMsg());
    const findFiles = vi.fn().mockResolvedValue([
      { path: "/repo/src/foo.rs", rel_path: "src/foo.rs", match_indices: [] },
    ]);
    const readFile = vi.fn().mockResolvedValue(
      { kind: "text", content: "fn main(){}", size_bytes: 11 } as ReadResult,
    );
    const panel = new TeammatePanel(host, {
      listMessages:  vi.fn().mockResolvedValue([]),
      sendText,
      listOperators: vi.fn().mockResolvedValue([]),
      getActiveSessionId:  () => "s1",
      getActiveSessionCwd: () => "/repo",
      findFiles,
      readFile,
    });
    await panel.openFor(makeOp());

    const input = host.querySelector(".teammate-panel-input") as HTMLInputElement;
    input.focus();
    input.value = "@foo";
    input.setSelectionRange(4, 4);
    input.dispatchEvent(new Event("input"));
    await new Promise((r) => setTimeout(r, 180));

    // Pick the first row via mousedown (Enter would also work).
    const row = host.querySelector(".teammate-mention-row") as HTMLElement;
    row.dispatchEvent(new MouseEvent("mousedown", { cancelable: true, bubbles: true }));
    expect(input.value).toBe("@src/foo.rs ");

    await panel.send(input.value + "review please");

    expect(readFile).toHaveBeenCalledWith("/repo/src/foo.rs", 256 * 1024);
    const [, payload] = sendText.mock.calls[0];
    expect(payload).toContain("@src/foo.rs");
    expect(payload).toContain("review please");
    expect(payload).toContain("--- Mentioned files ---");
    expect(payload).toContain("fn main(){}");
  });
});
