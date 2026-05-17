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

describe("ProjectNotesPanel", () => {
  let host: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = "";
    host = document.createElement("div");
    document.body.appendChild(host);
    localStorage.clear();
  });

  it("renders four tab buttons and the default tab", () => {
    const p = new ProjectNotesPanel({ groupId: "g1", groupLabel: "COVENANT" });
    p.mount(host);
    const buttons = host.querySelectorAll(".pn-tabs button");
    expect(buttons.length).toBe(4);
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
      groupRootDir: "/repo",
      onOpenFile: () => {},
      onOpenWizard: () => {},
    }).mount(host);
    p.switchTab("drafts");
    expect(host.querySelector(".pn-drafts-tab")).not.toBeNull();
    const buttons = host.querySelectorAll(".pn-tabs button");
    expect(buttons.length).toBe(4);
  });
});
