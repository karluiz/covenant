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

import { TaskStorage } from "./storage";
import {
  startBoardAutoPush,
  shareProjectBoard,
  isBoardShared,
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
});
