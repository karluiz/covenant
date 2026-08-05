import { describe, expect, it } from "vitest";
import { _collabState, getDriver, getGuestCount } from "./collab";

describe("collab share state", () => {
  it("tracks driver per session", () => {
    _collabState.onDriver({ sessionId: "S1", login: "nico" });
    expect(getDriver("S1")).toBe("nico");
    _collabState.onDriver({ sessionId: "S1", login: null });
    expect(getDriver("S1")).toBeNull();
  });
  it("tracks roster count per session", () => {
    _collabState.onRoster({ sessionId: "S1", guests: [{ connId: 1, login: "a", avatar: "" }] });
    expect(getGuestCount("S1")).toBe(1);
    _collabState.onRoster({ sessionId: "S1", guests: [] });
    expect(getGuestCount("S1")).toBe(0);
  });
});
