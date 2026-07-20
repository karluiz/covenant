import { describe, it, expect } from "vitest";
import { toSnapshot, DONE_LIMIT } from "./snapshot";
import type { Project, Task } from "./types";

function task(over: Partial<Task> = {}): Task {
  return {
    id: over.id ?? "t1",
    title: "Ship the thing",
    status: "pending",
    priority: "normal",
    createdAt: 1000,
    updatedAt: 1000,
    ...over,
  };
}

function project(tasks: Task[]): Project {
  return { id: "p1", name: "Covenant", createdAt: 1, updatedAt: 2, tasks };
}

describe("toSnapshot", () => {
  it("never leaks a task description", () => {
    const secret = "sk-ant-do-not-publish-me";
    const snap = toSnapshot(project([task({ description: secret })]), 5000);
    expect(JSON.stringify(snap)).not.toContain(secret);
  });

  it("carries the fields a viewer needs", () => {
    const snap = toSnapshot(
      project([
        task({
          title: "Fix the parser",
          priority: "urgent",
          dueDate: 4000,
          dueTime: "09:30",
          tags: ["rust"],
          estimatedMinutes: 60,
          spentMinutes: 15,
          subtasks: [{ id: "s1", title: "repro", completed: true, createdAt: 1 }],
        }),
      ]),
      5000,
    );
    const t = snap.columns[0].tasks[0];
    expect(snap.title).toBe("Covenant");
    expect(snap.v).toBe(1);
    expect(snap.updatedAt).toBe(5000);
    expect(t.title).toBe("Fix the parser");
    expect(t.priority).toBe("urgent");
    expect(t.dueDate).toBe(4000);
    expect(t.dueTime).toBe("09:30");
    expect(t.tags).toEqual(["rust"]);
    expect(t.estimatedMinutes).toBe(60);
    expect(t.spentMinutes).toBe(15);
    expect(t.subtasks).toEqual([{ title: "repro", completed: true }]);
  });

  it("lays out the three board columns in order", () => {
    const snap = toSnapshot(
      project([
        task({ id: "a", status: "pending" }),
        task({ id: "b", status: "active" }),
        task({ id: "c", status: "done", completedAt: 3000 }),
      ]),
      5000,
    );
    expect(snap.columns.map((c) => c.status)).toEqual(["pending", "active", "done"]);
    expect(snap.columns.map((c) => c.label)).toEqual(["To Do", "In Progress", "Done"]);
    expect(snap.columns.map((c) => c.tasks.length)).toEqual([1, 1, 1]);
  });

  it("drops cancelled tasks entirely", () => {
    const snap = toSnapshot(project([task({ id: "x", status: "cancelled" })]), 5000);
    expect(snap.columns.flatMap((c) => c.tasks)).toHaveLength(0);
  });

  it("caps done at the newest DONE_LIMIT by completedAt", () => {
    const done = Array.from({ length: DONE_LIMIT + 5 }, (_, i) =>
      task({ id: `d${i}`, status: "done", completedAt: i }),
    );
    const snap = toSnapshot(project(done), 5000);
    const col = snap.columns[2];
    expect(col.tasks).toHaveLength(DONE_LIMIT);
    expect(col.tasks[0].id).toBe(`d${DONE_LIMIT + 4}`); // newest first
  });

  it("sorts done tasks by updatedAt when completedAt is absent", () => {
    const done = [
      task({ id: "early", status: "done", updatedAt: 1000 }),
      task({ id: "late", status: "done", updatedAt: 3000 }),
      task({ id: "middle", status: "done", updatedAt: 2000 }),
    ];
    const snap = toSnapshot(project(done), 5000);
    const col = snap.columns[2];
    expect(col.tasks.map((t) => t.id)).toEqual(["late", "middle", "early"]);
  });

  it("omits absent optional fields rather than emitting undefined keys", () => {
    const snap = toSnapshot(project([task()]), 5000);
    expect(Object.keys(snap.columns[0].tasks[0]).sort()).toEqual(
      ["createdAt", "id", "priority", "title", "updatedAt"].sort(),
    );
  });
});
