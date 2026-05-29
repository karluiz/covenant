import { describe, it, expect } from "vitest";
import { wrapForSend } from "./paste";

describe("wrapForSend", () => {
  it("wraps text in bracketed-paste markers and appends a carriage return", () => {
    expect(wrapForSend("hello")).toBe("\x1b[200~hello\x1b[201~\r");
  });

  it("keeps multi-line bodies inside a single paste block", () => {
    const body = "line one\nline two";
    expect(wrapForSend(body)).toBe(`\x1b[200~${body}\x1b[201~\r`);
  });
});
