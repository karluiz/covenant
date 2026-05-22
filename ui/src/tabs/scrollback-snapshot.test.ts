import { describe, it, expect } from "vitest";
import { Terminal } from "@xterm/xterm";
import { serializeTab, restoreSnapshot } from "./scrollback-snapshot";

describe("scrollback-snapshot", () => {
  it("round-trips printable text", () => {
    const a = new Terminal({ rows: 10, cols: 40, allowProposedApi: true });
    a.write("hello\r\nworld\r\n");
    return new Promise<void>((resolve) => {
      a.write("", () => {
        const snap = serializeTab(a);
        const b = new Terminal({ rows: 10, cols: 40, allowProposedApi: true });
        restoreSnapshot(b, snap);
        b.write("", () => {
          expect(snap).toContain("hello");
          expect(snap).toContain("world");
          resolve();
        });
      });
    });
  });

  it("returns empty string when terminal is blank", () => {
    const t = new Terminal({ rows: 10, cols: 40, allowProposedApi: true });
    return new Promise<void>((resolve) => {
      t.write("", () => {
        expect(serializeTab(t).trim()).toBe("");
        resolve();
      });
    });
  });
});
