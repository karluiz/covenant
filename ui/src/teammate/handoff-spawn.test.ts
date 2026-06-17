import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleHandoffRouted, type HandoffRoutedEvent, type HandoffSpawnDeps } from "./handoff-spawn";

function ev(over: Partial<HandoffRoutedEvent> = {}): HandoffRoutedEvent {
  return {
    handoff_id: "h1",
    chain_id: "c1",
    from_operator: "op-from",
    to_operator: "op-to",
    task_id: "task-1",
    executor: "codex",
    brief: "migrate auth",
    deliverable: "tests green",
    ...over,
  };
}

function mkDeps(over: Partial<HandoffSpawnDeps> = {}): HandoffSpawnDeps {
  return {
    placementForOperator: vi.fn().mockReturnValue(null),
    spawnTab: vi.fn().mockResolvedValue({ sessionId: "sess-1" }),
    attachSessionToTask: vi.fn().mockResolvedValue(undefined),
    bindOperatorToTab: vi.fn().mockResolvedValue(undefined),
    injectLater: vi.fn(),
    buildInjection: vi.fn().mockReturnValue("codex 'migrate auth — tests green'\n"),
    alreadySpawned: vi.fn().mockReturnValue(false),
    recordSpawn: vi.fn(),
    ...over,
  };
}

describe("handleHandoffRouted", () => {
  let seen: Set<string>;
  beforeEach(() => { seen = new Set(); });

  it("spawns, attaches, binds, and injects in order on the happy path", async () => {
    const d = mkDeps();
    await handleHandoffRouted(ev(), d, seen);
    expect(d.spawnTab).toHaveBeenCalledWith("migrate auth", null);
    expect(d.attachSessionToTask).toHaveBeenCalledWith("op-to", "task-1", "sess-1");
    expect(d.bindOperatorToTab).toHaveBeenCalledWith("sess-1", "op-to");
    expect(d.buildInjection).toHaveBeenCalledWith("migrate auth", "tests green", "codex");
    expect(d.injectLater).toHaveBeenCalledWith("sess-1", "codex 'migrate auth — tests green'\n", 1500);
  });

  it("spawns into the delegator's tab placement when resolvable", async () => {
    const placement = { cwd: "/work/b", groupId: "g2", color: "#222" };
    const d = mkDeps({ placementForOperator: vi.fn().mockReturnValue(placement) });
    await handleHandoffRouted(ev(), d, seen);
    expect(d.placementForOperator).toHaveBeenCalledWith("op-from");
    expect(d.spawnTab).toHaveBeenCalledWith("migrate auth", placement);
  });

  it("falls back to active placement (null) when the delegator has no tab, without throwing", async () => {
    const d = mkDeps({ placementForOperator: vi.fn().mockReturnValue(null) });
    await expect(handleHandoffRouted(ev(), d, seen)).resolves.toBeUndefined();
    expect(d.spawnTab).toHaveBeenCalledWith("migrate auth", null);
  });

  it("records the spawn meta for the task", async () => {
    const d = mkDeps();
    await handleHandoffRouted(ev(), d, seen);
    expect(d.recordSpawn).toHaveBeenCalledWith("task-1", "sess-1", null);
  });

  it("is idempotent on a duplicate handoff_id (spawns once)", async () => {
    const d = mkDeps();
    await handleHandoffRouted(ev(), d, seen);
    await handleHandoffRouted(ev(), d, seen);
    expect(d.spawnTab).toHaveBeenCalledTimes(1);
  });

  it("skips when the task was already spawned", async () => {
    const d = mkDeps({ alreadySpawned: vi.fn().mockReturnValue(true) });
    await handleHandoffRouted(ev(), d, seen);
    expect(d.spawnTab).not.toHaveBeenCalled();
  });

  it("aborts (no attach/bind/inject) when spawn yields no sessionId", async () => {
    const d = mkDeps({ spawnTab: vi.fn().mockResolvedValue({ sessionId: "" }) });
    await handleHandoffRouted(ev(), d, seen);
    expect(d.attachSessionToTask).not.toHaveBeenCalled();
    expect(d.bindOperatorToTab).not.toHaveBeenCalled();
    expect(d.injectLater).not.toHaveBeenCalled();
  });

  it("aborts and does not throw when spawnTab rejects", async () => {
    const d = mkDeps({ spawnTab: vi.fn().mockRejectedValue(new Error("createTab failed")) });
    await expect(handleHandoffRouted(ev(), d, seen)).resolves.toBeUndefined();
    expect(d.attachSessionToTask).not.toHaveBeenCalled();
    expect(d.injectLater).not.toHaveBeenCalled();
  });

  it("ignores events with no task_id", async () => {
    const d = mkDeps();
    await handleHandoffRouted(ev({ task_id: "" }), d, seen);
    expect(d.spawnTab).not.toHaveBeenCalled();
  });

  it("aborts before bind/inject when attachSessionToTask throws", async () => {
    const d = mkDeps({ attachSessionToTask: vi.fn().mockRejectedValue(new Error("attach failed")) });
    await expect(handleHandoffRouted(ev(), d, seen)).resolves.toBeUndefined();
    expect(d.bindOperatorToTab).not.toHaveBeenCalled();
    expect(d.injectLater).not.toHaveBeenCalled();
  });
});
