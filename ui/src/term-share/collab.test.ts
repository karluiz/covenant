import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("../notifications/toast", () => ({
  pushConfirmToast: vi.fn(),
  pushInfoToast: vi.fn(),
}));

import { pushConfirmToast } from "../notifications/toast";
import { _collabState, _requestQueue, getDriver, getGuestCount } from "./collab";

describe("collab share state", () => {
  beforeEach(() => _requestQueue._resetForTest());

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

describe("collab guest-request queue", () => {
  const mockConfirm = vi.mocked(pushConfirmToast);
  const tabTitle = () => "some-tab";

  beforeEach(() => {
    mockConfirm.mockReset();
    _requestQueue._resetForTest();
  });

  it("shows the first request immediately and queues a second one; confirming the first shows the second", () => {
    _requestQueue.enqueue({ sessionId: "Q1", connId: 1, login: "nico", avatar: "" }, tabTitle);
    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(_requestQueue.inFlight).toEqual({ sessionId: "Q1", connId: 1, login: "nico", avatar: "" });
    expect(_requestQueue.pendingCount).toBe(0);

    _requestQueue.enqueue({ sessionId: "Q2", connId: 2, login: "ana", avatar: "" }, tabTitle);
    // Still only the first toast has been shown — the second is queued.
    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(_requestQueue.pendingCount).toBe(1);

    // Confirming the first request advances the queue to the second.
    const firstToast = mockConfirm.mock.calls[0]![0];
    firstToast.onConfirm();
    expect(mockConfirm).toHaveBeenCalledTimes(2);
    expect(_requestQueue.inFlight).toEqual({ sessionId: "Q2", connId: 2, login: "ana", avatar: "" });
    expect(_requestQueue.pendingCount).toBe(0);
  });

  it("drops a duplicate (sessionId, connId) request while the original is queued", () => {
    _requestQueue.enqueue({ sessionId: "Q1", connId: 1, login: "nico", avatar: "" }, tabTitle);
    _requestQueue.enqueue({ sessionId: "Q2", connId: 2, login: "ana", avatar: "" }, tabTitle);
    expect(_requestQueue.pendingCount).toBe(1);

    // Guest re-clicks "request control" while still queued behind Q1.
    _requestQueue.enqueue({ sessionId: "Q2", connId: 2, login: "ana", avatar: "" }, tabTitle);
    expect(_requestQueue.pendingCount).toBe(1);
    expect(mockConfirm).toHaveBeenCalledTimes(1);
  });

  it("drops a duplicate request while its original is the in-flight toast", () => {
    _requestQueue.enqueue({ sessionId: "Q1", connId: 1, login: "nico", avatar: "" }, tabTitle);
    expect(mockConfirm).toHaveBeenCalledTimes(1);

    _requestQueue.enqueue({ sessionId: "Q1", connId: 1, login: "nico", avatar: "" }, tabTitle);
    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(_requestQueue.pendingCount).toBe(0);
  });

  it("skips a queued request whose connId vanished from the roster by the time it's dequeued", () => {
    _requestQueue.enqueue({ sessionId: "Q1", connId: 1, login: "nico", avatar: "" }, tabTitle);
    _requestQueue.enqueue({ sessionId: "Q2", connId: 2, login: "ana", avatar: "" }, tabTitle);
    _requestQueue.enqueue({ sessionId: "Q3", connId: 3, login: "kai", avatar: "" }, tabTitle);
    expect(_requestQueue.pendingCount).toBe(2);

    // Q2's guest disconnects while queued — the roster no longer lists connId 2.
    _collabState.onRoster({ sessionId: "Q2", guests: [] });

    // Confirming Q1 dequeues past Q2 (skipped) straight to Q3.
    const firstToast = mockConfirm.mock.calls[0]![0];
    firstToast.onConfirm();
    expect(mockConfirm).toHaveBeenCalledTimes(2);
    expect(_requestQueue.inFlight).toEqual({ sessionId: "Q3", connId: 3, login: "kai", avatar: "" });
    expect(_requestQueue.pendingCount).toBe(0);
  });

  it("declining also advances the queue", () => {
    _requestQueue.enqueue({ sessionId: "Q1", connId: 1, login: "nico", avatar: "" }, tabTitle);
    _requestQueue.enqueue({ sessionId: "Q2", connId: 2, login: "ana", avatar: "" }, tabTitle);

    const firstToast = mockConfirm.mock.calls[0]![0];
    firstToast.onCancel?.();
    expect(mockConfirm).toHaveBeenCalledTimes(2);
    expect(_requestQueue.inFlight).toEqual({ sessionId: "Q2", connId: 2, login: "ana", avatar: "" });
  });
});
