import { describe, it, expect, beforeEach } from "vitest";
import { ProjectNotesPanel } from "./panel";

describe("ProjectNotesPanel", () => {
  let host: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = "";
    host = document.createElement("div");
    document.body.appendChild(host);
    localStorage.clear();
  });

  it("renders three tab buttons and the default tab", () => {
    const p = new ProjectNotesPanel({ groupId: "g1", groupLabel: "COVENANT" });
    p.mount(host);
    const buttons = host.querySelectorAll(".pn-tabs button");
    expect(buttons.length).toBe(3);
    expect(host.querySelector(".pn-tab-commands")).not.toBeNull();
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
});
