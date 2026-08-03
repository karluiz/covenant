import { describe, it, expect, afterEach, vi } from "vitest";
import { TaskStorage, TASKER_SAVED_EVENT } from "./storage";

describe("TASKER_SAVED_EVENT", () => {
  afterEach(() => {
    localStorage.clear();
  });

  it("fires on every write, carrying the live project ids", () => {
    const seen: string[][] = [];
    const onSave = (e: Event) => {
      seen.push([...(e as CustomEvent<{ projectIds: string[] }>).detail.projectIds]);
    };
    window.addEventListener(TASKER_SAVED_EVENT, onSave);

    const storage = new TaskStorage();
    const p = storage.createProject("Covenant");
    storage.createTask(p.id, "Ship it");

    window.removeEventListener(TASKER_SAVED_EVENT, onSave);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toEqual([p.id]);
  });
});

describe("work timer", () => {
  afterEach(() => {
    localStorage.clear();
    vi.useRealTimers();
  });

  it("banks elapsed minutes into spentMinutes on stop", () => {
    vi.useFakeTimers();
    const storage = new TaskStorage();
    const p = storage.createProject("Covenant");
    const t = storage.createTask(p.id, "Track me")!;

    storage.startTimer(p.id, t.id);
    expect(storage.getTask(p.id, t.id)!.timerStartedAt).toBeTruthy();

    vi.advanceTimersByTime(25 * 60_000);
    storage.stopTimer(p.id, t.id);

    const after = storage.getTask(p.id, t.id)!;
    expect(after.timerStartedAt).toBeUndefined();
    expect(after.spentMinutes).toBe(25);
  });

  it("starting a timer banks and stops any other running timer", () => {
    vi.useFakeTimers();
    const storage = new TaskStorage();
    const p = storage.createProject("Covenant");
    const a = storage.createTask(p.id, "A")!;
    const b = storage.createTask(p.id, "B")!;

    storage.startTimer(p.id, a.id);
    vi.advanceTimersByTime(10 * 60_000);
    storage.startTimer(p.id, b.id);

    expect(storage.getTask(p.id, a.id)!.timerStartedAt).toBeUndefined();
    expect(storage.getTask(p.id, a.id)!.spentMinutes).toBe(10);
    expect(storage.getTask(p.id, b.id)!.timerStartedAt).toBeTruthy();
  });

  it("marking a task done stops its timer and banks the time", () => {
    vi.useFakeTimers();
    const storage = new TaskStorage();
    const p = storage.createProject("Covenant");
    const t = storage.createTask(p.id, "Finish me")!;

    storage.startTimer(p.id, t.id);
    vi.advanceTimersByTime(30 * 60_000);
    storage.updateTask(p.id, t.id, { status: "done", completedAt: Date.now() });

    const after = storage.getTask(p.id, t.id)!;
    expect(after.timerStartedAt).toBeUndefined();
    expect(after.spentMinutes).toBe(30);
  });
});
