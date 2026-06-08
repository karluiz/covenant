// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { TaskerPanel } from "./panel";
import { BoardView } from "./board";
import { TaskStorage } from "./storage";
import type { TaskStatus } from "./types";

function boardHarness() {
  const storage = new TaskStorage();
  const project = storage.getProjects()[0] ?? storage.createProject("Inbox");
  const host = document.createElement("div");
  document.body.appendChild(host);
  let selected: { projectId: string; taskId: string } | null = null;
  let changes = 0;
  const view = new BoardView({
    storage,
    getProjectId: () => project.id,
    isSelected: (p, t) => selected?.projectId === p && selected?.taskId === t,
    onSelect: (p, t) => { selected = { projectId: p, taskId: t }; },
    onChange: () => { changes++; },
  });
  return { storage, project, host, view, getChanges: () => changes, getSelected: () => selected };
}

function mount(): { panel: TaskerPanel; host: HTMLElement } {
  document.body.innerHTML = `<div id="tasker-panel"></div>`;
  const host = document.getElementById("tasker-panel")!;
  const panel = new TaskerPanel(host);
  panel.render();
  return { panel, host };
}

beforeEach(() => {
  localStorage.clear();
  document.body.className = "";
  document.body.innerHTML = "";
});

describe("view toggle + fullscreen", () => {
  it("switches to board mode and adds body.tasker-board", () => {
    const { host } = mount();
    const boardBtn = host.querySelector<HTMLButtonElement>('.tasker-view-btn[data-view="board"]')!;
    expect(boardBtn).toBeTruthy();
    boardBtn.click();
    expect(document.body.classList.contains("tasker-board")).toBe(true);
    expect(host.querySelector(".tasker-panel-board")).toBeTruthy();
  });

  it("switches back to list and removes body.tasker-board", () => {
    const { host } = mount();
    host.querySelector<HTMLButtonElement>('.tasker-view-btn[data-view="board"]')!.click();
    host.querySelector<HTMLButtonElement>('.tasker-view-btn[data-view="list"]')!.click();
    expect(document.body.classList.contains("tasker-board")).toBe(false);
    expect(host.querySelector(".tasker-filters")).toBeTruthy();
  });

  it("Escape in board mode returns to list", () => {
    const { host } = mount();
    host.querySelector<HTMLButtonElement>('.tasker-view-btn[data-view="board"]')!.click();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(document.body.classList.contains("tasker-board")).toBe(false);
  });

  it("persists view mode across re-mount", () => {
    const { host } = mount();
    host.querySelector<HTMLButtonElement>('.tasker-view-btn[data-view="board"]')!.click();
    // remount with a fresh panel against the same localStorage
    document.body.innerHTML = `<div id="tasker-panel"></div>`;
    const host2 = document.getElementById("tasker-panel")!;
    new TaskerPanel(host2).render();
    expect(host2.querySelector(".tasker-panel-board")).toBeTruthy();
  });
});

describe("BoardView columns", () => {
  it("renders three status columns", () => {
    const h = boardHarness();
    h.view.render(h.host);
    const cols = h.host.querySelectorAll(".kb-col");
    expect(cols.length).toBe(3);
    expect([...cols].map((c) => (c as HTMLElement).dataset.status)).toEqual(["pending", "active", "done"]);
  });

  it("buckets tasks by status and excludes cancelled", () => {
    const h = boardHarness();
    h.storage.createTask(h.project.id, "todo task", { status: "pending" });
    h.storage.createTask(h.project.id, "doing task", { status: "active" });
    h.storage.createTask(h.project.id, "done task", { status: "done" });
    h.storage.createTask(h.project.id, "cancelled task", { status: "cancelled" });
    h.view.render(h.host);
    const col = (s: TaskStatus) => h.host.querySelector(`.kb-col[data-status="${s}"]`)!;
    expect(col("pending").querySelectorAll(".kb-card").length).toBe(1);
    expect(col("active").querySelectorAll(".kb-card").length).toBe(1);
    expect(col("done").querySelectorAll(".kb-card").length).toBe(1);
    expect(h.host.textContent).not.toContain("cancelled task");
  });

  it("shows per-column counts", () => {
    const h = boardHarness();
    h.storage.createTask(h.project.id, "a", { status: "pending" });
    h.storage.createTask(h.project.id, "b", { status: "pending" });
    h.view.render(h.host);
    const count = h.host.querySelector('.kb-col[data-status="pending"] .kb-col-count')!;
    expect(count.textContent).toBe("2");
  });

  it("orders a column by priority then due date then creation", () => {
    const h = boardHarness();
    h.storage.createTask(h.project.id, "low-old", { status: "pending", priority: "low" });
    h.storage.createTask(h.project.id, "urgent", { status: "pending", priority: "urgent" });
    h.storage.createTask(h.project.id, "normal", { status: "pending", priority: "normal" });
    h.view.render(h.host);
    const titles = [...h.host.querySelectorAll('.kb-col[data-status="pending"] .kb-card-title')]
      .map((e) => e.textContent);
    expect(titles).toEqual(["urgent", "normal", "low-old"]);
  });
});

describe("board selection + checkbox", () => {
  it("clicking a card opens the details dock with the task's status control", () => {
    document.body.innerHTML = `<div id="tasker-panel"></div>`;
    const host = document.getElementById("tasker-panel")!;
    const panel = new TaskerPanel(host);
    const storage = (panel as unknown as { storage: TaskStorage }).storage;
    const pid = storage.getProjects()[0].id;
    storage.createTask(pid, "Pick me", { status: "pending" });
    (panel as unknown as { boardProjectId: string }).boardProjectId = pid;
    panel.render();
    host.querySelector<HTMLButtonElement>('.tasker-view-btn[data-view="board"]')!.click();

    host.querySelector<HTMLElement>(".kb-card")!.click();
    const dock = host.querySelector(".tasker-board-dock .tasker-edit");
    expect(dock).toBeTruthy();
    expect(dock!.querySelector('.tasker-seg-btn[data-status="pending"].on')).toBeTruthy();
  });

  it("checkbox toggles a task to done", () => {
    const h = boardHarness();
    const t = h.storage.createTask(h.project.id, "Finish", { status: "pending" })!;
    h.view.render(h.host);
    h.host.querySelector<HTMLButtonElement>(`.kb-card[data-task-id="${t.id}"] .kb-check`)!.click();
    expect(h.storage.getTask(h.project.id, t.id)!.status).toBe("done");
    expect(h.getChanges()).toBeGreaterThan(0);
  });
});

describe("board drag move", () => {
  it("moveTaskToStatus changes status and sets completedAt when done", () => {
    const h = boardHarness();
    const t = h.storage.createTask(h.project.id, "Ship", { status: "pending" })!;
    h.view.render(h.host);
    h.view.moveTaskToStatus(h.project.id, t.id, "done");
    const after = h.storage.getTask(h.project.id, t.id)!;
    expect(after.status).toBe("done");
    expect(typeof after.completedAt).toBe("number");
  });

  it("moving out of done clears completedAt", () => {
    const h = boardHarness();
    const t = h.storage.createTask(h.project.id, "Reopen", { status: "done", completedAt: 123 })!;
    h.view.render(h.host);
    h.view.moveTaskToStatus(h.project.id, t.id, "active");
    const after = h.storage.getTask(h.project.id, t.id)!;
    expect(after.status).toBe("active");
    expect(after.completedAt).toBeUndefined();
  });

  it("a no-op move (same status) does not call onChange", () => {
    const h = boardHarness();
    const t = h.storage.createTask(h.project.id, "Same", { status: "active" })!;
    h.view.render(h.host);
    const before = h.getChanges();
    h.view.moveTaskToStatus(h.project.id, t.id, "active");
    expect(h.getChanges()).toBe(before);
  });
});

describe("board inline add", () => {
  it("addTask creates a task with the column's status in the current project", () => {
    const h = boardHarness();
    h.view.render(h.host);
    h.view.addTask(h.project.id, "active", "Wire it up");
    const created = h.storage.getProject(h.project.id)!.tasks.find((t) => t.title === "Wire it up");
    expect(created).toBeTruthy();
    expect(created!.status).toBe("active");
  });

  it("clicking + Add task reveals an input that creates on submit", () => {
    const h = boardHarness();
    h.view.render(h.host);
    const addBtn = h.host.querySelector<HTMLButtonElement>('.kb-col[data-status="pending"] .kb-add')!;
    addBtn.click();
    const input = h.host.querySelector<HTMLInputElement>('.kb-col[data-status="pending"] .kb-add-input')!;
    expect(input).toBeTruthy();
    input.value = "From the board";
    input.closest("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    const created = h.storage.getProject(h.project.id)!.tasks.find((t) => t.title === "From the board");
    expect(created).toBeTruthy();
    expect(created!.status).toBe("pending");
  });
});
