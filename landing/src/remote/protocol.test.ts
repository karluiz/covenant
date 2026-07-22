import { describe, it, expect } from "vitest";
import { parseFrame, wsUrl, reduce, initialState, sendInputFrame, closeTabFrame, focusTabFrame, openTabFrame } from "./protocol";

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
  it("starts offline with no tabs", () => { expect(initialState()).toEqual({ desktopOnline: false, tabs: [], rejections: {} }); });
  it("applies presence", () => { expect(reduce(initialState(), { t: "presence", desktop_online: true }).desktopOnline).toBe(true); });
  it("replaces tabs on a tabs frame", () => {
    const tabs = [{ session_id: "s1", title: "x", cwd: "~/p", executor: null, phase: "idle", armed: false }];
    expect(reduce(initialState(), { t: "tabs", device_id: "d", tabs }).tabs).toEqual(tabs);
  });
});
describe("rejected frame", () => {
  it("parses a rejected frame", () => {
    const f = parseFrame(JSON.stringify({ t: "rejected", session_id: "s1", reason: "tab_not_armed", message: "tab not armed" }));
    expect(f).toEqual({ t: "rejected", session_id: "s1", reason: "tab_not_armed", message: "tab not armed" });
  });
  it("reduce records a rejection by session", () => {
    const s = reduce(initialState(), { t: "rejected", session_id: "s1", reason: "blocklisted", message: "rm -rf blocked" });
    expect(s.rejections["s1"]).toBe("rm -rf blocked");
  });
  it("a tabs frame clears stale rejections", () => {
    let s = reduce(initialState(), { t: "rejected", session_id: "s1", reason: "blocklisted", message: "x" });
    s = reduce(s, { t: "tabs", device_id: "d", tabs: [] });
    expect(s.rejections).toEqual({});
  });
  it("a tabs frame keeps rejections for sessions still present", () => {
    let s = reduce(initialState(), { t: "rejected", session_id: "s1", reason: "blocklisted", message: "x" });
    s = reduce(s, { t: "tabs", device_id: "d", tabs: [
      { session_id: "s1", title: "t", cwd: "~", executor: null, phase: "idle", armed: true },
    ] });
    expect(s.rejections["s1"]).toBe("x");
  });
});
describe("sendInputFrame", () => {
  it("builds a send_input frame and appends a newline (submit)", () => {
    expect(sendInputFrame("s1", "git status")).toBe(JSON.stringify({ t: "send_input", session_id: "s1", data: "git status\n" }));
  });
  it("does not double-append if the text already ends in newline", () => {
    expect(sendInputFrame("s1", "echo hi\n")).toBe(JSON.stringify({ t: "send_input", session_id: "s1", data: "echo hi\n" }));
  });
});
describe("lifecycle frames", () => {
  it("builds close_tab", () => { expect(closeTabFrame("s1")).toBe(JSON.stringify({ t: "close_tab", session_id: "s1" })); });
  it("builds focus_tab", () => { expect(focusTabFrame("s1")).toBe(JSON.stringify({ t: "focus_tab", session_id: "s1" })); });
});
describe("open_tab frame", () => {
  it("builds open_tab with no cwd", () => { expect(openTabFrame()).toBe(JSON.stringify({ t: "open_tab" })); });
  it("builds open_tab with cwd", () => { expect(openTabFrame("~/p")).toBe(JSON.stringify({ t: "open_tab", cwd: "~/p" })); });
});
import { mirrorStartFrame, mirrorStopFrame, parseMirrorFrame } from "./protocol";
describe("mirror frames", () => {
  it("builds mirror_start/stop", () => {
    expect(mirrorStartFrame("s1")).toBe(JSON.stringify({ t: "mirror_start", session_id: "s1" }));
    expect(mirrorStopFrame("s1")).toBe(JSON.stringify({ t: "mirror_stop", session_id: "s1" }));
  });
  it("parses a mirror_screen frame", () => {
    expect(parseMirrorFrame(JSON.stringify({ t: "mirror_screen", session_id: "s1", screen: "hello" })))
      .toEqual({ kind: "screen", sessionId: "s1", text: "hello" });
  });
  it("parses a mirror_data frame, decoding base64", () => {
    const m = parseMirrorFrame(JSON.stringify({ t: "mirror_data", session_id: "s1", b64: btoa("hi") }));
    expect(m?.kind).toBe("data");
    if (m?.kind === "data") { expect(m.sessionId).toBe("s1"); expect(Array.from(m.bytes)).toEqual([104,105]); }
  });
  it("returns null for non-mirror frames", () => {
    expect(parseMirrorFrame(JSON.stringify({ t: "presence", desktop_online: true }))).toBeNull();
    expect(parseMirrorFrame("garbage")).toBeNull();
  });
});

describe("mirror_screen carries the source grid", () => {
  it("keeps cols/rows so the viewer can match the source instead of re-wrapping", () => {
    expect(parseMirrorFrame(JSON.stringify({ t: "mirror_screen", session_id: "s1", screen: "hi", cols: 213, rows: 47 })))
      .toEqual({ kind: "screen", sessionId: "s1", text: "hi", cols: 213, rows: 47 });
  });
  it("drops a nonsense grid rather than resizing the viewer to nothing", () => {
    const m = parseMirrorFrame(JSON.stringify({ t: "mirror_screen", session_id: "s1", screen: "hi", cols: 0, rows: 0 }));
    expect(m).toEqual({ kind: "screen", sessionId: "s1", text: "hi" });
  });
});
