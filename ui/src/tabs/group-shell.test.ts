import { describe, expect, it } from "vitest";
import { createGroupShell } from "./group-shell";

describe("createGroupShell", () => {
  it("returns a shell element with stripe + body children in that order", () => {
    const { shell, body } = createGroupShell({ groupId: "g1", color: "#3b82f6", collapsed: false });
    expect(shell.classList.contains("tab-group-shell")).toBe(true);
    expect(shell.dataset.groupId).toBe("g1");
    expect(shell.children.length).toBe(2);
    expect(shell.children[0].classList.contains("tab-group-stripe")).toBe(true);
    expect(shell.children[1]).toBe(body);
    expect(body.classList.contains("tab-group-body")).toBe(true);
  });

  it("paints stripe with --group-color when color is provided", () => {
    const { shell } = createGroupShell({ groupId: "g1", color: "#84cc16", collapsed: false });
    expect(shell.style.getPropertyValue("--group-color")).toBe("#84cc16");
    expect(shell.classList.contains("tab-group-shell-colored")).toBe(true);
  });

  it("omits colored class when no color", () => {
    const { shell } = createGroupShell({ groupId: "g1", color: null, collapsed: false });
    expect(shell.classList.contains("tab-group-shell-colored")).toBe(false);
    expect(shell.style.getPropertyValue("--group-color")).toBe("");
  });

  it("adds collapsed class when group is collapsed", () => {
    const { shell } = createGroupShell({ groupId: "g1", color: "#fff", collapsed: true });
    expect(shell.classList.contains("tab-group-shell-collapsed")).toBe(true);
  });
});
