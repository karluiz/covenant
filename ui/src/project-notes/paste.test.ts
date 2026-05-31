import { describe, it, expect, vi, beforeEach } from "vitest";

const writeToSession = vi.fn(async (_id: unknown, _bytes: Uint8Array) => {});
vi.mock("../api", () => ({
  writeToSession: (id: unknown, bytes: Uint8Array) => writeToSession(id, bytes),
}));

import { pasteBlock, sendPromptToSession } from "./paste";

describe("pasteBlock", () => {
  it("wraps text in bracketed-paste markers WITHOUT a carriage return", () => {
    expect(pasteBlock("hello")).toBe("\x1b[200~hello\x1b[201~");
  });

  it("keeps multi-line bodies inside a single paste block", () => {
    const body = "line one\nline two";
    expect(pasteBlock(body)).toBe(`\x1b[200~${body}\x1b[201~`);
  });
});

describe("sendPromptToSession", () => {
  beforeEach(() => writeToSession.mockClear());

  // Regression: gluing `\r` onto the paste-end marker in one write races
  // zsh-autosuggestions' async paste hook → duplicated line. The submit must
  // be a SEPARATE write delivered after the paste block.
  it("sends the paste block and the carriage return as two separate writes", async () => {
    await sendPromptToSession("sess-1" as never, "do the thing", 0);

    expect(writeToSession).toHaveBeenCalledTimes(2);
    const dec = new TextDecoder();
    const first = dec.decode(writeToSession.mock.calls[0][1] as Uint8Array);
    const second = dec.decode(writeToSession.mock.calls[1][1] as Uint8Array);
    expect(first).toBe("\x1b[200~do the thing\x1b[201~");
    expect(second).toBe("\r");
    // The paste block carries no submit — the bug was the combined write.
    expect(first).not.toContain("\r");
  });
});
