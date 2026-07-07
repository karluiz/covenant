import { describe, expect, it } from "vitest";
import { fmtDuration, fmtSize, prettyBody, relTimeMs, statusSpine } from "./panel";

describe("statusSpine", () => {
  it("maps outcomes to rail spines", () => {
    expect(statusSpine(200, null)).toBe("ok");
    expect(statusSpine(304, null)).toBe("ok");
    expect(statusSpine(404, null)).toBe("fail");
    expect(statusSpine(500, null)).toBe("fail");
    expect(statusSpine(null, "somnus: connection failed")).toBe("fail");
    expect(statusSpine(null, null)).toBe("fail");
  });
});

describe("fmtSize", () => {
  it("formats byte counts", () => {
    expect(fmtSize(0)).toBe("0 B");
    expect(fmtSize(512)).toBe("512 B");
    expect(fmtSize(2048)).toBe("2.0 KB");
    expect(fmtSize(3.5 * 1024 * 1024)).toBe("3.5 MB");
    expect(fmtSize(null)).toBe("");
  });
});

describe("fmtDuration", () => {
  it("formats milliseconds", () => {
    expect(fmtDuration(850)).toBe("850 ms");
    expect(fmtDuration(1500)).toBe("1.50 s");
    expect(fmtDuration(null)).toBe("");
  });
});

describe("relTimeMs", () => {
  it("formats relative times and clamps future timestamps", () => {
    const now = Date.now();
    expect(relTimeMs(now - 5_000)).toBe("5s ago");
    expect(relTimeMs(now - 5 * 60_000)).toBe("5m ago");
    expect(relTimeMs(now - 3 * 3_600_000)).toBe("3h ago");
    expect(relTimeMs(now - 2 * 86_400_000)).toBe("2d ago");
    expect(relTimeMs(now + 60_000)).toBe("0s ago");
  });
});

describe("prettyBody", () => {
  it("pretty-prints JSON and passes through everything else", () => {
    expect(prettyBody('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(prettyBody("[1,2]")).toBe("[\n  1,\n  2\n]");
    expect(prettyBody("<html></html>")).toBe("<html></html>");
    expect(prettyBody("not { json")).toBe("not { json");
    expect(prettyBody("")).toBe("");
  });
});
