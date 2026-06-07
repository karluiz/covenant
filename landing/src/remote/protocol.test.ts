import { describe, it, expect } from "vitest";
import { parseFrame, wsUrl, reduce, initialState } from "./protocol";

describe("parseFrame", () => {
  it("parses a tabs frame", () => {
    const f = parseFrame(JSON.stringify({ t: "tabs", device_id: "mac-1",
      tabs: [{ session_id: "s1", title: "build", cwd: "~/p", executor: "claude", phase: "running", armed: false }] }));
    expect(f?.t).toBe("tabs");
    if (f?.t === "tabs") expect(f.tabs[0].title).toBe("build");
  });
  it("parses a presence frame", () => {
    expect(parseFrame(JSON.stringify({ t: "presence", desktop_online: true })))
      .toEqual({ t: "presence", desktop_online: true });
  });
  it("returns null on garbage", () => {
    expect(parseFrame("not json")).toBeNull();
    expect(parseFrame(JSON.stringify({ t: "mystery" }))).toBeNull();
  });
});
describe("wsUrl", () => {
  it("builds the web relay url", () => {
    expect(wsUrl("https://forge.covenant.uno", "T")).toBe("wss://forge.covenant.uno/rc/web?token=T");
  });
  it("encodes the token", () => {
    expect(wsUrl("https://forge.covenant.uno", "a b/c")).toBe("wss://forge.covenant.uno/rc/web?token=a%20b%2Fc");
  });
});
describe("reduce", () => {
  it("starts offline with no tabs", () => { expect(initialState()).toEqual({ desktopOnline: false, tabs: [] }); });
  it("applies presence", () => { expect(reduce(initialState(), { t: "presence", desktop_online: true }).desktopOnline).toBe(true); });
  it("replaces tabs on a tabs frame", () => {
    const tabs = [{ session_id: "s1", title: "x", cwd: "~/p", executor: null, phase: "idle", armed: false }];
    expect(reduce(initialState(), { t: "tabs", device_id: "d", tabs }).tabs).toEqual(tabs);
  });
});
