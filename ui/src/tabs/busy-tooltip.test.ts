import { describe, expect, it } from "vitest";
import { busyTooltip, busyUrl } from "./busy-tooltip";

const NOW = 1_700_000_000_000;

function obj(c: ReturnType<typeof busyTooltip>) {
  if (typeof c === "string") throw new Error("expected structured content");
  return c;
}

describe("busyTooltip", () => {
  it("leads with the port — that is what tells two node tabs apart", () => {
    const c = obj(
      busyTooltip({
        proc: "vite",
        port: 1420,
        pid: 84213,
        since: NOW - 4 * 60_000,
        cwd: "/Users/karluiz/Sources/karlTerminal",
        nowMs: NOW,
      }),
    );
    expect(c.title).toBe("vite is serving on :1420");
    expect(c.meta).toBe("up 4m · pid 84213 · vite");
    expect(c.preview).toBe("~/Sources/karlTerminal");
    expect(c.hint).toBe("Click to open in a browser tab");
  });

  it("never advertises a click when no port was resolved", () => {
    const c = obj(
      busyTooltip({ proc: "node", port: null, pid: 84213, since: NOW - 90_000, cwd: null, nowMs: NOW }),
    );
    expect(c.title).toBe("node is running here");
    expect(c.hint).toBeUndefined();
    // Without a port the runtime name is all we have, so it stays in the
    // title instead of being repeated as a detail.
    expect(c.meta).toBe("up 1m · pid 84213");
  });

  it("drops uptime for a server that was already up when the tab was restored", () => {
    const c = obj(
      busyTooltip({ proc: "vite", port: 1420, pid: null, since: null, cwd: null, nowMs: NOW }),
    );
    expect(c.meta).toBe("vite");
    expect(c.preview).toBeUndefined();
  });

  it("scales the uptime unit with the age", () => {
    const at = (ms: number) =>
      obj(busyTooltip({ proc: "vite", port: 1, pid: null, since: NOW - ms, cwd: null, nowMs: NOW }))
        .meta;
    expect(at(12_000)).toContain("up 12s");
    expect(at(5 * 60_000)).toContain("up 5m");
    expect(at(3 * 3600_000)).toContain("up 3h");
  });

  it("builds the url the hint promised", () => {
    expect(busyUrl(1420)).toBe("http://localhost:1420");
  });
});
