import { describe, it, expect, vi, afterEach } from "vitest";
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
