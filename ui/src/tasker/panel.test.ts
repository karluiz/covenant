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

describe("TaskerPanel filters", () => {
  function setupThree(panel: TaskerPanel): string {
    const pid = inbox(panel);
    addTask(panel, pid, "pending one");
    const b = addTask(panel, pid, "active one");
    const c = addTask(panel, pid, "done one");
    storageOf(panel).updateTask(pid, b, { status: "active" });
    storageOf(panel).updateTask(pid, c, { status: "done", completedAt: Date.now() });
    return pid;
  }

  function visibleTitles(host: HTMLElement): string[] {
    return Array.from(host.querySelectorAll(".tasker-task-title")).map(
      (el) => el.textContent ?? "",
    );
  }

  it("Active filter shows only active tasks", () => {
    const { panel, host } = mount();
    setupThree(panel);
    host.querySelector<HTMLButtonElement>('.tasker-filter-btn[data-filter="active"]')!.click();
    expect(visibleTitles(host)).toEqual(["active one"]);
  });

  it("Pending filter shows only pending tasks", () => {
    const { panel, host } = mount();
    setupThree(panel);
    host.querySelector<HTMLButtonElement>('.tasker-filter-btn[data-filter="pending"]')!.click();
    expect(visibleTitles(host)).toEqual(["pending one"]);
  });

  it("All filter shows every task", () => {
    const { panel, host } = mount();
    setupThree(panel);
    host.querySelector<HTMLButtonElement>('.tasker-filter-btn[data-filter="all"]')!.click();
    expect(visibleTitles(host).sort()).toEqual(["active one", "done one", "pending one"]);
  });
});

describe("TaskerPanel inline edit", () => {
  function openTask(host: HTMLElement, tid: string): void {
    host
      .querySelector<HTMLElement>(`.tasker-task[data-task-id="${tid}"] .tasker-task-main`)!
      .click();
  }

  it("status chip popover sets the task to active", () => {
    const { panel, host } = mount();
    const pid = inbox(panel);
    const tid = addTask(panel, pid, "Deploy API");
    panel.render();
    openTask(host, tid);

    host.querySelector<HTMLButtonElement>(".tasker-chip-status")!.click();
    host
      .querySelector<HTMLButtonElement>('.tasker-menu-item[data-status="active"]')!
      .click();

    expect(storageOf(panel).getTask(pid, tid).status).toBe("active");
  });

  it("priority popover updates the task priority", () => {
    const { panel, host } = mount();
    const pid = inbox(panel);
    const tid = addTask(panel, pid, "Deploy API");
    panel.render();
    openTask(host, tid);
    host.querySelector<HTMLButtonElement>(".tasker-chip-priority")!.click();
    host.querySelector<HTMLButtonElement>('.tasker-menu-item[data-priority="high"]')!.click();
    expect(storageOf(panel).getTask(pid, tid).priority).toBe("high");
  });

  it("calendar sets and clears dueDate", () => {
    const { panel, host } = mount();
    const pid = inbox(panel);
    const tid = addTask(panel, pid, "Deploy API");
    panel.render();
    openTask(host, tid);

    // Open the calendar and pick a day.
    host.querySelector<HTMLButtonElement>(".tasker-chip-due")!.click();
    const day = host.querySelector<HTMLButtonElement>('.tasker-cal-day[data-date="2026-06-09"]')!;
    expect(day).toBeTruthy();
    day.click();
    expect(typeof storageOf(panel).getTask(pid, tid).dueDate).toBe("number");

    // Re-open and clear.
    host.querySelector<HTMLButtonElement>(".tasker-chip-due")!.click();
    host.querySelector<HTMLButtonElement>(".tasker-cal-clear")!.click();
    expect(storageOf(panel).getTask(pid, tid).dueDate).toBeUndefined();
  });

  it("delete chip removes the task", () => {
    const { panel, host } = mount();
    const pid = inbox(panel);
    const tid = addTask(panel, pid, "Deploy API");
    panel.render();
    openTask(host, tid);
    host.querySelector<HTMLButtonElement>(".tasker-chip-delete")!.click();
    expect(storageOf(panel).getTask(pid, tid)).toBeNull();
  });

  it("clicking the title turns it into an editable input that commits on change", () => {
    const { panel, host } = mount();
    const pid = inbox(panel);
    const tid = addTask(panel, pid, "Deploy API");
    panel.render();

    host
      .querySelector<HTMLElement>(`.tasker-task[data-task-id="${tid}"] .tasker-task-title`)!
      .click();
    const input = host.querySelector<HTMLInputElement>(
      `.tasker-task[data-task-id="${tid}"] .tasker-title-input`,
    )!;
    expect(input).toBeTruthy();
    input.value = "Deploy API to Pulzen";
    input.dispatchEvent(new Event("change"));

    expect(storageOf(panel).getTask(pid, tid).title).toBe("Deploy API to Pulzen");
  });

  it("Escape cancels a title edit without changing the stored title", () => {
    const { panel, host } = mount();
    const pid = inbox(panel);
    const tid = addTask(panel, pid, "Deploy API");
    panel.render();

    host
      .querySelector<HTMLElement>(`.tasker-task[data-task-id="${tid}"] .tasker-task-title`)!
      .click();
    const input = host.querySelector<HTMLInputElement>(
      `.tasker-task[data-task-id="${tid}"] .tasker-title-input`,
    )!;
    expect(input).toBeTruthy();
    input.value = "Should not persist";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    expect(storageOf(panel).getTask(pid, tid).title).toBe("Deploy API");
    expect(
      host.querySelector(`.tasker-task[data-task-id="${tid}"] .tasker-title-input`),
    ).toBeNull();
  });

  it("clicking outside an open status popover closes it", () => {
    const { panel, host } = mount();
    const pid = inbox(panel);
    const tid = addTask(panel, pid, "Deploy API");
    panel.render();
    openTask(host, tid);

    host.querySelector<HTMLButtonElement>(".tasker-chip-status")!.click();
    expect(host.querySelector(".tasker-status-menu")).toBeTruthy();

    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

    expect(host.querySelector(".tasker-status-menu")).toBeNull();
  });
});

describe("TaskerPanel new-list composer", () => {
  it("does not call window.prompt and creates a project from the inline composer", () => {
    const promptSpy = vi.spyOn(window, "prompt");
    const { panel, host } = mount();

    host.querySelector<HTMLButtonElement>(".tasker-btn-new-project")!.click();
    const input = host.querySelector<HTMLInputElement>(".tasker-newlist-input")!;
    expect(input).toBeTruthy();
    input.value = "Roadmap";
    input.dispatchEvent(new Event("change"));

    const names = storageOf(panel).getProjects().map((p: any) => p.name);
    expect(names).toContain("Roadmap");
    expect(promptSpy).not.toHaveBeenCalled();
    promptSpy.mockRestore();
  });

  it("Escape cancels the composer without creating a project", () => {
    const { panel, host } = mount();
    const before = storageOf(panel).getProjects().length;
    host.querySelector<HTMLButtonElement>(".tasker-btn-new-project")!.click();
    const input = host.querySelector<HTMLInputElement>(".tasker-newlist-input")!;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(host.querySelector(".tasker-newlist-input")).toBeNull();
    expect(storageOf(panel).getProjects().length).toBe(before);
  });
});
