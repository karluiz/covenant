import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const publish = vi.fn();
const revoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: unknown) => {
    if (cmd === "board_publish") return publish(args);
    if (cmd === "board_list_shares") return Promise.resolve([]);
    if (cmd === "board_revoke") return revoke(args);
    return Promise.resolve(null);
  },
}));
vi.mock("../notifications/toast", () => ({ pushInfoToast: vi.fn() }));
vi.mock("../ui/clipboard", () => ({ copyText: vi.fn().mockResolvedValue(undefined) }));

import { TaskStorage, TASKER_SAVED_EVENT } from "./storage";
import {
  startBoardAutoPush,
  shareProjectBoard,
  revokeBoardShare,
  isBoardShared,
  resetBoardShareStateForTests,
  PUSH_DEBOUNCE_MS,
} from "./share";

describe("board auto-push", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    publish.mockReset();
    publish.mockResolvedValue({ boardId: 1, token: "tok", url: "https://f/b/tok" });
    revoke.mockReset();
    revoke.mockResolvedValue(undefined);
    localStorage.clear();
    // Finding 4: sharedProjects/pushState/sharesLoaded are module singletons
    // that outlive any one test — without this, a project id left behind by
    // an earlier test leaks into this test's retraction pass and fires a
    // spurious revoke against unrelated storage.
    resetBoardShareStateForTests();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces a burst of saves into one publish", async () => {
    const storage = new TaskStorage();
    const p = storage.createProject("Covenant");
    await shareProjectBoard(p);
    expect(publish).toHaveBeenCalledTimes(1); // the initial share
    expect(isBoardShared(p.id)).toBe(true);

    const stop = startBoardAutoPush(storage);
    storage.createTask(p.id, "a");
    storage.createTask(p.id, "b");
    storage.createTask(p.id, "c");
    expect(publish).toHaveBeenCalledTimes(1); // still debouncing

    await vi.advanceTimersByTimeAsync(PUSH_DEBOUNCE_MS + 10);
    expect(publish).toHaveBeenCalledTimes(2); // one push for the burst
    stop();
  });

  it("ignores saves for projects that were never shared", async () => {
    const storage = new TaskStorage();
    const p = storage.createProject("Private");
    const stop = startBoardAutoPush(storage);
    storage.createTask(p.id, "secret");
    await vi.advanceTimersByTimeAsync(PUSH_DEBOUNCE_MS + 10);
    expect(publish).not.toHaveBeenCalled();
    stop();
  });

  it("sends a redacted payload — no descriptions", async () => {
    const storage = new TaskStorage();
    const p = storage.createProject("Covenant");
    await shareProjectBoard(p);
    const stop = startBoardAutoPush(storage);
    storage.createTask(p.id, "task", { description: "sk-ant-secret" });
    await vi.advanceTimersByTimeAsync(PUSH_DEBOUNCE_MS + 10);
    const lastArgs = publish.mock.calls[publish.mock.calls.length - 1]?.[0] as {
      projectId: string;
      title: string;
    };
    expect(JSON.stringify(lastArgs)).not.toContain("sk-ant-secret");
    expect(lastArgs.projectId).toBe(p.id);
    expect(lastArgs.title).toBe("Covenant");
    stop();
  });

  // A project that stops appearing in TASKER_SAVED_EVENT's projectIds either
  // got deleted or merely archived — the live snapshot can't tell those
  // apart, only storage.getProject() can. Deletion must revoke the share so
  // the forge link dies with the project; archiving must NOT, because
  // archiving is reversible and the board should survive an
  // archive/unarchive round trip.
  it("revokes the share when a shared project is deleted", async () => {
    const storage = new TaskStorage();
    const p = storage.createProject("Gone");
    await shareProjectBoard(p);
    expect(isBoardShared(p.id)).toBe(true);

    const stop = startBoardAutoPush(storage);
    storage.deleteProject(p.id);
    await vi.advanceTimersByTimeAsync(0);

    expect(revoke).toHaveBeenCalledWith({ projectId: p.id });
    expect(isBoardShared(p.id)).toBe(false);
    stop();
  });

  it("leaves an archived shared project's board alone", async () => {
    const storage = new TaskStorage();
    const p = storage.createProject("Archived");
    await shareProjectBoard(p);
    expect(isBoardShared(p.id)).toBe(true);

    const stop = startBoardAutoPush(storage);
    storage.archiveProject(p.id);
    await vi.advanceTimersByTimeAsync(PUSH_DEBOUNCE_MS + 10);

    expect(revoke).not.toHaveBeenCalled();
    expect(isBoardShared(p.id)).toBe(true);
    stop();
  });

  // Finding 1: revokeBoardShare cannot reach into startBoardAutoPush's
  // `timers` closure to cancel a pending debounce, so the timer callback is
  // the only place that can notice a share died mid-window. Without the
  // `sharedProjects.has(projectId)` guard, this timer fires `boardApi.publish`
  // for a project the Rust side no longer has a share record for, which
  // takes the first-publish path and mints a brand new, unrevokable board.
  it("does not resurrect a revoked board when a pending push timer fires", async () => {
    const storage = new TaskStorage();
    const p = storage.createProject("Covenant");
    await shareProjectBoard(p);
    expect(publish).toHaveBeenCalledTimes(1); // the initial share

    const stop = startBoardAutoPush(storage);
    storage.createTask(p.id, "a"); // schedules a push PUSH_DEBOUNCE_MS out
    expect(publish).toHaveBeenCalledTimes(1); // still debouncing

    await revokeBoardShare(p.id); // revoke lands inside the debounce window
    expect(isBoardShared(p.id)).toBe(false);
    expect(revoke).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(PUSH_DEBOUNCE_MS + 10);
    // The pending timer must bail instead of re-publishing a board for a
    // project that is no longer shared.
    expect(publish).toHaveBeenCalledTimes(1);
    stop();
  });

  // Finding 3: `sharedProjects` isn't touched until after `await
  // boardApi.revoke(...)` resolves inside revokeBoardShare, so a second
  // TASKER_SAVED_EVENT for the same deleted project — arriving while the
  // first revoke is still in flight — must not fire a second concurrent
  // revoke for the same id.
  it("does not fire a second concurrent revoke for the same deleted project", async () => {
    const storage = new TaskStorage();
    const p = storage.createProject("Gone");
    await shareProjectBoard(p);

    let resolveRevoke: (() => void) | undefined;
    revoke.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveRevoke = resolve;
        }),
    );

    const stop = startBoardAutoPush(storage);
    storage.deleteProject(p.id); // first TASKER_SAVED_EVENT — revoke in flight
    // Second event referencing the same now-deleted project, before the
    // first revoke has resolved.
    window.dispatchEvent(
      new CustomEvent(TASKER_SAVED_EVENT, { detail: { projectIds: [] } }),
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(revoke).toHaveBeenCalledTimes(1);

    resolveRevoke?.();
    await vi.advanceTimersByTimeAsync(0);
    stop();
  });
});
