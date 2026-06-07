// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TaskerPanel } from "./panel";

function mount(): { panel: TaskerPanel; host: HTMLElement } {
  document.body.innerHTML = `<div id="tasker-panel"></div>`;
  const host = document.getElementById("tasker-panel")!;
  const panel = new TaskerPanel(host);
  panel.render();
  return { panel, host };
}

function storageOf(panel: TaskerPanel): any {
  return (panel as unknown as { storage: any }).storage;
}

function inbox(panel: TaskerPanel): string {
  return storageOf(panel).getProjects()[0].id;
}

function addTask(panel: TaskerPanel, projectId: string, title: string): string {
  const t = storageOf(panel).createTask(projectId, title, { priority: "normal" });
  return t.id;
}

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = "";
});

describe("TaskerPanel status lifecycle", () => {
  it("start affordance flips a pending task to active", () => {
    const { panel, host } = mount();
    const pid = inbox(panel);
    const tid = addTask(panel, pid, "Deploy API");
    panel.render();

    const startBtn = host.querySelector<HTMLButtonElement>(
      `.tasker-task[data-task-id="${tid}"] .tasker-task-start`,
    );
    expect(startBtn).toBeTruthy();
    startBtn!.click();

    expect(storageOf(panel).getTask(pid, tid).status).toBe("active");
  });

  it("checkbox completes an active task and sets completedAt", () => {
    const { panel, host } = mount();
    const pid = inbox(panel);
    const tid = addTask(panel, pid, "Deploy API");
    storageOf(panel).updateTask(pid, tid, { status: "active" });
    panel.render();

    host
      .querySelector<HTMLButtonElement>(`.tasker-task[data-task-id="${tid}"] .tasker-task-checkbox`)!
      .click();

    const t = storageOf(panel).getTask(pid, tid);
    expect(t.status).toBe("done");
    expect(typeof t.completedAt).toBe("number");
  });

  it("checkbox on a done task reopens it to pending and clears completedAt", () => {
    const { panel, host } = mount();
    const pid = inbox(panel);
    const tid = addTask(panel, pid, "Deploy API");
    storageOf(panel).updateTask(pid, tid, { status: "done", completedAt: Date.now() });
    panel.render();

    host
      .querySelector<HTMLButtonElement>(`.tasker-task[data-task-id="${tid}"] .tasker-task-checkbox`)!
      .click();

    const t = storageOf(panel).getTask(pid, tid);
    expect(t.status).toBe("pending");
    expect(t.completedAt).toBeUndefined();
  });
});
