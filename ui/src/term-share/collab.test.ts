import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("../notifications/toast", () => ({
  pushConfirmToast: vi.fn(),
  pushInfoToast: vi.fn(),
}));
vi.mock("./share", () => ({ isCollabShared: vi.fn(() => true) }));

import { pushConfirmToast } from "../notifications/toast";
import { isCollabShared } from "./share";
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
  const mockIsCollabShared = vi.mocked(isCollabShared);
  const tabTitle = () => "some-tab";

  beforeEach(() => {
    mockConfirm.mockReset();
    mockIsCollabShared.mockReset();
    mockIsCollabShared.mockReturnValue(true);
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

  // I1: the UI-side half of the relay-compromise defense — a request naming
  // a session that isn't (or is no longer) collab-shared must never surface
  // a grant-control toast, regardless of what a (possibly forged/stale)
  // relay frame claims.
  it("never shows a toast for a request whose session isn't collab-shared", () => {
    mockIsCollabShared.mockReturnValue(false);
    _requestQueue.enqueue(
      { sessionId: "NOTSHARED", connId: 1, login: "nico", avatar: "" },
      tabTitle,
    );
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(_requestQueue.inFlight).toBeNull();
    expect(_requestQueue.pendingCount).toBe(0);
  });
});

// I2: the swallowed-toast self-heal. `pushConfirmToast` is a singleton
// (toast.ts) that silently drops a second confirm card while one is already
// showing (e.g. the quit guard) — with no return signal. Left unguarded,
// `inFlightRequest` would stay set forever with callbacks nobody can ever
// invoke, deadlocking every future collab request.
describe("collab guest-request queue self-heal (swallowed toast)", () => {
  const mockConfirm = vi.mocked(pushConfirmToast);
  const mockIsCollabShared = vi.mocked(isCollabShared);
  const tabTitle = () => "some-tab";

  beforeEach(() => {
    vi.useFakeTimers();
    mockConfirm.mockReset();
    mockIsCollabShared.mockReset();
    mockIsCollabShared.mockReturnValue(true);
    _requestQueue._resetForTest();
    document.body.innerHTML = "";
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("retries and eventually shows the request when the first push was swallowed", () => {
    // Simulate the swallow: the very first pushConfirmToast call is a
    // no-op (as the singleton behaves when another confirm card already
    // owns the slot) — it does not append anything to the DOM.
    mockConfirm.mockImplementationOnce(() => {});

    _requestQueue.enqueue({ sessionId: "S1", connId: 1, login: "nico", avatar: "" }, tabTitle);
    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(_requestQueue.inFlight).toEqual({ sessionId: "S1", connId: 1, login: "nico", avatar: "" });

    // Nothing rendered for that first call — advancing past the retry
    // delay must detect the swallow and re-push.
    vi.advanceTimersByTime(1500);
    expect(mockConfirm).toHaveBeenCalledTimes(2);
    expect(_requestQueue.inFlight).toEqual({ sessionId: "S1", connId: 1, login: "nico", avatar: "" });
  });

  it("does not retry when the toast actually rendered", () => {
    mockConfirm.mockImplementation((toast) => {
      const card = document.createElement("div");
      card.className = "toast-confirm";
      const msg = document.createElement("span");
      msg.className = "toast-msg";
      msg.textContent = toast.message;
      card.appendChild(msg);
      document.body.appendChild(card);
    });

    _requestQueue.enqueue({ sessionId: "S1", connId: 1, login: "nico", avatar: "" }, tabTitle);
    expect(mockConfirm).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1500);
    // The card is present with the matching message — no retry.
    expect(mockConfirm).toHaveBeenCalledTimes(1);
  });

  it("does not double-fire the retry once the request already settled via onConfirm", () => {
    // Never renders a real card — every push looks "swallowed" from the
    // retry's point of view, so if the double-fire guard were missing the
    // stale timer would push S1 again after it was already confirmed.
    mockConfirm.mockImplementation(() => {});

    _requestQueue.enqueue({ sessionId: "S1", connId: 1, login: "nico", avatar: "" }, tabTitle);
    expect(mockConfirm).toHaveBeenCalledTimes(1);

    // Confirm immediately, well before the retry delay elapses.
    mockConfirm.mock.calls[0]![0].onConfirm();
    expect(_requestQueue.inFlight).toBeNull(); // queue was empty behind it

    // The stale retry timer for the already-settled request must not fire
    // a second push.
    vi.advanceTimersByTime(5000);
    expect(mockConfirm).toHaveBeenCalledTimes(1);
  });
});
