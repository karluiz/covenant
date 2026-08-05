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
      // Stands in for the composer, so a test can prove the draft survives.
      el.innerHTML = `<textarea class="pn-note-input"></textarea>`;
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

  it("renders exactly three tabs", () => {
    new ProjectNotesPanel({ groupId: "g", groupLabel: "G" }).mount(host);
    expect(host.querySelectorAll(".rail-tab").length).toBe(3);
  });

  it("renders the default tab", () => {
    const p = new ProjectNotesPanel({ groupId: "g1", groupLabel: "COVENANT" });
    p.mount(host);
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
    new ProjectNotesPanel({ groupId: "g1", groupLabel: "G1" }).mount(host).switchTab("prompts");
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

  it("expands into a canon-cockpit shell with grouped nav", () => {
    const host = document.createElement("div");
    const p = new ProjectNotesPanel({ groupId: "g", groupLabel: "G" }).mount(host);
    (host.querySelector('[aria-label="Toggle fullscreen"]') as HTMLButtonElement).click();
    const shell = document.querySelector(".canon-cockpit");
    expect(shell).not.toBeNull();
    expect(shell!.querySelectorAll(".canon-cockpit-grouplabel").length).toBe(2); // LIBRARY, KNOWLEDGE
    expect(shell!.querySelectorAll(".canon-cockpit-nav-btn").length).toBe(3);    // Commands, Prompts, Notes
    p.close();
    (document.querySelector(".canon-cockpit") as HTMLElement | null)?.remove();
  });

  it("renders the prompts tab when selected", () => {
    const p = new ProjectNotesPanel({ groupId: "g1", groupLabel: "G1" }).mount(host);
    p.switchTab("prompts");
    expect(host.querySelector(".pn-prompt-tab")).not.toBeNull();
  });

  it("keeps a tab's draft across a switch away and back", () => {
    const p = new ProjectNotesPanel({ groupId: "g1", groupLabel: "G1" }).mount(host);
    p.switchTab("notes");
    const input = host.querySelector(".pn-note-input") as HTMLTextAreaElement;
    input.value = "half-written thought";
    p.switchTab("commands");
    p.switchTab("notes");
    // Same element, same value — the tab was toggled, not rebuilt.
    expect(host.querySelectorAll(".pn-notes-tab").length).toBe(1);
    expect((host.querySelector(".pn-note-input") as HTMLTextAreaElement).value)
      .toBe("half-written thought");
  });

  it("shows only the active tab's host", () => {
    const p = new ProjectNotesPanel({ groupId: "g1", groupLabel: "G1" }).mount(host);
    p.switchTab("notes");
    const hosts = Array.from(host.querySelectorAll(".pn-tabhost")) as HTMLElement[];
    expect(hosts.length).toBe(2); // commands (default) + notes
    expect(hosts.filter((h) => !h.hidden).length).toBe(1);
  });

  it("flushes the body padding for all tabs", () => {
    const p = new ProjectNotesPanel({ groupId: "g1", groupLabel: "G1" }).mount(host);
    const body = host.querySelector(".pn-body") as HTMLElement;
    expect(body.classList.contains("pn-body--flush")).toBe(true); // default: commands
    p.switchTab("prompts");
    expect(body.classList.contains("pn-body--flush")).toBe(true);
    p.switchTab("notes");
    expect(body.classList.contains("pn-body--flush")).toBe(true);
  });
});
