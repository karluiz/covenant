// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskerPanel } from "./panel";

// vi.fn() (not a bare arrow fn) so the shared-state test below can override
// a single call with mockResolvedValueOnce; every other test keeps the
// default "no tauri" rejection.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.reject(new Error("no tauri"))) }));

import { invoke } from "@tauri-apps/api/core";
import { getPushState, isBoardShared, resetBoardShareStateForTests, shareProjectBoard } from "./share";

function mount(opts?: { boardShareEnabled?: boolean }): { panel: TaskerPanel; host: HTMLElement } {
  document.body.innerHTML = `<div id="tasker-panel"></div>`;
  const host = document.getElementById("tasker-panel")!;
  const panel = new TaskerPanel(host, opts);
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
  // Finding 4: sharedProjects/pushState/the auto-push subscription are
  // module singletons that outlive any one test — without this, an id (or a
  // listener bound to a prior test's storage) leaks across tests in this
  // file.
  resetBoardShareStateForTests();
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
      .querySelector<HTMLButtonElement>(`.tasker-task[data-task-id="${tid}"] .rail-cb`)!
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
      .querySelector<HTMLButtonElement>(`.tasker-task[data-task-id="${tid}"] .rail-cb`)!
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
    return Array.from(host.querySelectorAll(".rail-ttl")).map(
      (el) => el.textContent ?? "",
    );
  }

  it("Active filter shows only active tasks", () => {
    const { panel, host } = mount();
    setupThree(panel);
    host.querySelector<HTMLButtonElement>('.rail-pill[data-filter="active"]')!.click();
    expect(visibleTitles(host)).toEqual(["active one"]);
  });

  it("Pending filter shows only pending tasks", () => {
    const { panel, host } = mount();
    setupThree(panel);
    host.querySelector<HTMLButtonElement>('.rail-pill[data-filter="pending"]')!.click();
    expect(visibleTitles(host)).toEqual(["pending one"]);
  });

  it("All filter shows every task", () => {
    const { panel, host } = mount();
    setupThree(panel);
    host.querySelector<HTMLButtonElement>('.rail-pill[data-filter="all"]')!.click();
    expect(visibleTitles(host).sort()).toEqual(["active one", "done one", "pending one"]);
  });
});

describe("TaskerPanel inline edit", () => {
  function openTask(host: HTMLElement, tid: string): void {
    host
      .querySelector<HTMLElement>(`.tasker-task[data-task-id="${tid}"] .rail-task`)!
      .click();
  }

  it("status segmented switch updates status", () => {
    const { panel, host } = mount();
    const pid = inbox(panel);
    const tid = addTask(panel, pid, "Ship it");
    panel.render();
    openTask(host, tid);

    host.querySelector<HTMLButtonElement>('.tasker-seg-status [data-status="active"]')!.click();
    expect(storageOf(panel).getTask(pid, tid).status).toBe("active");

    openTask(host, tid); openTask(host, tid); // collapse then re-open
    host.querySelector<HTMLButtonElement>('.tasker-seg-status [data-status="done"]')!.click();
    expect(storageOf(panel).getTask(pid, tid).status).toBe("done");
    expect(typeof storageOf(panel).getTask(pid, tid).completedAt).toBe("number");
  });

  it("priority dots update priority", () => {
    const { panel, host } = mount();
    const pid = inbox(panel);
    const tid = addTask(panel, pid, "Tune");
    panel.render();
    openTask(host, tid);
    host.querySelector<HTMLButtonElement>('.tasker-prio-dots [data-priority="high"]')!.click();
    expect(storageOf(panel).getTask(pid, tid).priority).toBe("high");
  });

  afterEach(() => {
    document.querySelectorAll(".tasker-date-menu").forEach((n) => n.remove());
  });

  it("calendar sets and clears dueDate", () => {
    const { panel, host } = mount();
    const pid = inbox(panel);
    const tid = addTask(panel, pid, "Deploy API");
    panel.render();
    openTask(host, tid);

    host.querySelector<HTMLButtonElement>(".tasker-chip-due")!.click();
    const day = document.querySelector<HTMLButtonElement>(".tasker-date-menu .tasker-cal-day:not(.tasker-cal-out)")!;
    expect(day).toBeTruthy();
    day.click();
    expect(typeof storageOf(panel).getTask(pid, tid).dueDate).toBe("number");

    host.querySelector<HTMLButtonElement>(".tasker-chip-due")!.click();
    document.querySelector<HTMLButtonElement>(".tasker-date-menu .tasker-cal-clear")!.click();
    expect(storageOf(panel).getTask(pid, tid).dueDate).toBeUndefined();
  });

  it("delete action removes the task", () => {
    const { panel, host } = mount();
    const pid = inbox(panel);
    const tid = addTask(panel, pid, "Deploy API");
    panel.render();
    openTask(host, tid);
    host.querySelector<HTMLButtonElement>(".tasker-sheet-delete")!.click();
    expect(storageOf(panel).getTask(pid, tid)).toBeNull();
  });

  it("clicking the title turns it into an editable input that commits on change", () => {
    const { panel, host } = mount();
    const pid = inbox(panel);
    const tid = addTask(panel, pid, "Deploy API");
    panel.render();

    host
      .querySelector<HTMLElement>(`.tasker-task[data-task-id="${tid}"] .rail-ttl`)!
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
      .querySelector<HTMLElement>(`.tasker-task[data-task-id="${tid}"] .rail-ttl`)!
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

});

describe("TaskerPanel project rename", () => {
  function projectNameEl(host: HTMLElement, pid: string): HTMLElement {
    return host.querySelector<HTMLElement>(
      `.rail-group-head[data-project-id="${pid}"] .tasker-project-name`,
    )!;
  }

  it("double-clicking a project name turns it into an input that commits on change", () => {
    const { panel, host } = mount();
    const project = storageOf(panel).createProject("Travel to Peru");
    panel.render();

    projectNameEl(host, project.id).dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    const input = host.querySelector<HTMLInputElement>(
      `.tasker-project-rename-input[data-project-id="${project.id}"]`,
    )!;
    expect(input).toBeTruthy();
    input.value = "Travel to Chile";
    input.dispatchEvent(new Event("change"));

    expect(storageOf(panel).getProject(project.id).name).toBe("Travel to Chile");
  });

  it("Escape cancels a project rename without changing the stored name", () => {
    const { panel, host } = mount();
    const project = storageOf(panel).createProject("Travel to Peru");
    panel.render();

    projectNameEl(host, project.id).dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    const input = host.querySelector<HTMLInputElement>(
      `.tasker-project-rename-input[data-project-id="${project.id}"]`,
    )!;
    expect(input).toBeTruthy();
    input.value = "Should not persist";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    expect(storageOf(panel).getProject(project.id).name).toBe("Travel to Peru");
    expect(host.querySelector(".tasker-project-rename-input")).toBeNull();
  });

  it("an empty name does not commit", () => {
    const { panel, host } = mount();
    const project = storageOf(panel).createProject("Travel to Peru");
    panel.render();

    projectNameEl(host, project.id).dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    const input = host.querySelector<HTMLInputElement>(
      `.tasker-project-rename-input[data-project-id="${project.id}"]`,
    )!;
    input.value = "   ";
    input.dispatchEvent(new Event("change"));

    expect(storageOf(panel).getProject(project.id).name).toBe("Travel to Peru");
  });

  it("Inbox cannot be renamed", () => {
    const { panel, host } = mount();
    const pid = inbox(panel);
    panel.render();

    projectNameEl(host, pid).dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(host.querySelector(".tasker-project-rename-input")).toBeNull();
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

describe("board share control", () => {
  // F1 — the forge has no /boards routes yet, so the whole feature is gated
  // behind experimental.board_share. Off by default, mount() with no opts
  // must render no share button at all (not merely a hidden one).
  it("renders no share button when experimental.board_share is off", () => {
    const { panel, host } = mount();
    const pid = inbox(panel);

    expect(
      host.querySelector(`.tasker-project-share[data-project-id="${pid}"]`),
    ).toBeNull();
  });

  it("renders a share button per project, unmarked when not shared", () => {
    const { panel, host } = mount({ boardShareEnabled: true });
    const pid = inbox(panel);

    const btn = host.querySelector<HTMLButtonElement>(
      `.tasker-project-share[data-project-id="${pid}"]`,
    );
    expect(btn).not.toBeNull();
    expect(btn!.classList.contains("shared")).toBe(false);
    expect(btn!.getAttribute("aria-label")).toBe("Share board");
  });

  it("renders the shared state: shared class + matching push-state attribute", async () => {
    const { panel, host } = mount({ boardShareEnabled: true });
    const pid = inbox(panel);
    const project = storageOf(panel).getProject(pid);

    vi.mocked(invoke).mockResolvedValueOnce({ boardId: 1, token: "tok", url: "https://forge.test/g/tok" });
    await shareProjectBoard(project);
    panel.render();

    const btn = host.querySelector<HTMLButtonElement>(
      `.tasker-project-share[data-project-id="${pid}"]`,
    );
    expect(btn).not.toBeNull();
    expect(btn!.classList.contains("shared")).toBe(true);
    expect(btn!.getAttribute("data-push-state")).toBe(getPushState(pid));
  });

  // F4 — the Alt-click revoke gesture is gone. A shared board's button now
  // opens a Copy link / Stop sharing menu, cloned from the panel's existing
  // project-switcher menu chrome.
  it("clicking a shared board's button opens a Copy link / Stop sharing menu, and Stop sharing revokes", async () => {
    const { panel, host } = mount({ boardShareEnabled: true });
    const pid = inbox(panel);
    const project = storageOf(panel).getProject(pid);

    vi.mocked(invoke).mockResolvedValueOnce({ boardId: 1, token: "tok", url: "https://forge.test/g/tok" });
    await shareProjectBoard(project);
    panel.render();
    expect(isBoardShared(pid)).toBe(true);

    const btn = host.querySelector<HTMLButtonElement>(
      `.tasker-project-share[data-project-id="${pid}"]`,
    )!;
    btn.click();

    const menu = document.querySelector<HTMLElement>(".tasker-share-menu");
    expect(menu).not.toBeNull();
    const copyItem = menu!.querySelector<HTMLButtonElement>('[data-action="copy"]');
    const stopItem = menu!.querySelector<HTMLButtonElement>('[data-action="stop"]');
    expect(copyItem?.textContent).toContain("Copy link");
    expect(stopItem?.textContent).toContain("Stop sharing");

    vi.mocked(invoke).mockResolvedValueOnce(undefined); // board_revoke
    stopItem!.click();

    await vi.waitFor(() => expect(isBoardShared(pid)).toBe(false));
    expect(document.querySelector(".tasker-share-menu")).toBeNull();
  });
});
