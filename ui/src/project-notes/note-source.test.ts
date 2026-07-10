import { describe, it, expect } from "vitest";
import { noteSource } from "./note-source";

describe("noteSource", () => {
  it("labels the executor when one is running", () => {
    expect(noteSource("claude", "tab 2")).toBe("from Claude · tab 2");
    expect(noteSource("copilot", "api")).toBe("from Copilot · api");
  });
  it("falls back to the raw id for unknown executors", () => {
    expect(noteSource("mystery", "x")).toBe("from mystery · x");
  });
  it("uses just the tab name when idle", () => {
    expect(noteSource(null, "tab 2")).toBe("tab 2");
  });
});
