// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { TaskerPanel } from "./panel";

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
