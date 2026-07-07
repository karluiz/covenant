import { describe, it, expect, beforeEach, vi } from "vitest";
import { ProjectNotesPanel } from "./panel";

vi.mock("./commands-tab", () => ({
  CommandsTab: class {
    mount(parent: HTMLElement) {
      const el = document.createElement("div");
      el.className = "pn-cmd-tab";
      parent.appendChild(el);
      return this;
    }
  },
}));

vi.mock("./notes-tab", () => ({
  NotesTab: class {
    mount(parent: HTMLElement) {
      const el = document.createElement("div");
      el.className = "pn-notes-tab";
      parent.appendChild(el);
      return this;
    }
  },
}));

vi.mock("./docs-tab", () => ({
  DocsTab: class {
    mount(parent: HTMLElement) {
      const el = document.createElement("div");
      el.className = "pn-docs-tab";
      parent.appendChild(el);
      return this;
    }
  },
}));

vi.mock("./drafts-tab", () => ({
  DraftsTab: class {
    mount(parent: HTMLElement) {
      const el = document.createElement("div");
      el.className = "pn-drafts-tab";
      parent.appendChild(el);
      return this;
    }
  },
}));

vi.mock("./prompts-tab", () => ({
  PromptsTab: class {
    mount(parent: HTMLElement) {
      const el = document.createElement("div");
      el.className = "pn-prompt-tab";
      parent.appendChild(el);
      return this;
    }
  },
}));

describe("ProjectNotesPanel", () => {
  let host: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = "";
    host = document.createElement("div");
    document.body.appendChild(host);
    localStorage.clear();
  });

  it("renders five tab buttons and the default tab", () => {
    const p = new ProjectNotesPanel({ groupId: "g1", groupLabel: "COVENANT" });
    p.mount(host);
    const buttons = host.querySelectorAll(".rail-tab");
    expect(buttons.length).toBe(5);
    expect(host.querySelector(".pn-cmd-tab")).not.toBeNull();
  });

  it("persists the last active tab per group", () => {
    const p1 = new ProjectNotesPanel({ groupId: "g1", groupLabel: "G1" }).mount(host);
    p1.switchTab("notes");
    p1.close();
    const p2 = new ProjectNotesPanel({ groupId: "g1", groupLabel: "G1" }).mount(host);
    expect(p2.activeTab).toBe("notes");
  });

  it("isolates last-tab state across groups", () => {
    new ProjectNotesPanel({ groupId: "g1", groupLabel: "G1" }).mount(host).switchTab("docs");
    const p2 = new ProjectNotesPanel({ groupId: "g2", groupLabel: "G2" }).mount(host);
    expect(p2.activeTab).toBe("commands");
  });

  it("closes on Escape", () => {
    let closed = false;
    new ProjectNotesPanel({
      groupId: "g1",
      groupLabel: "G1",
      onClose: () => (closed = true),
    }).mount(host);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(closed).toBe(true);
    expect(host.querySelector(".pn-panel")).toBeNull();
  });

  it("toggles fullscreen class", () => {
    const p = new ProjectNotesPanel({ groupId: "g1", groupLabel: "G1" }).mount(host);
    p.toggleFullscreen();
    expect(host.querySelector(".pn-panel.pn-fullscreen")).not.toBeNull();
  });

  it("renders the drafts tab when selected", () => {
    const p = new ProjectNotesPanel({
      groupId: "g1",
      groupLabel: "G1",
      onOpenDraft: () => {},
      onNewSpec: () => {},
    }).mount(host);
    p.switchTab("drafts");
    expect(host.querySelector(".pn-drafts-tab")).not.toBeNull();
    const buttons = host.querySelectorAll(".rail-tab");
    expect(buttons.length).toBe(5);
  });

  it("renders the prompts tab when selected", () => {
    const p = new ProjectNotesPanel({ groupId: "g1", groupLabel: "G1" }).mount(host);
    p.switchTab("prompts");
    expect(host.querySelector(".pn-prompt-tab")).not.toBeNull();
  });

  it("flushes the body padding for list tabs but not docs", () => {
    const p = new ProjectNotesPanel({ groupId: "g1", groupLabel: "G1" }).mount(host);
    const body = host.querySelector(".pn-body") as HTMLElement;
    expect(body.classList.contains("pn-body--flush")).toBe(true); // default: commands
    p.switchTab("docs");
    expect(body.classList.contains("pn-body--flush")).toBe(false);
    p.switchTab("drafts");
    expect(body.classList.contains("pn-body--flush")).toBe(true);
  });
});
