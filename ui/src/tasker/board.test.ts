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
