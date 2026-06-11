import { afterEach, describe, expect, it, vi } from "vitest";
import { openRenamePrompt } from "./rename-prompt";

afterEach(() => {
  document.body.innerHTML = "";
});

function input(): HTMLInputElement {
  return document.querySelector<HTMLInputElement>(".workspace-rename-overlay .command-palette-input")!;
}

describe("openRenamePrompt", () => {
  it("opens a palette-style overlay with the value prefilled, focused and selected", () => {
    openRenamePrompt({ value: "Workspace 7", onCommit: vi.fn() });
    const overlay = document.querySelector(".workspace-rename-overlay");
    expect(overlay).toBeTruthy();
    expect(overlay?.classList.contains("command-palette-overlay")).toBe(true);
    expect(document.querySelector(".workspace-rename-overlay .command-palette-card")).toBeTruthy();
    const inp = input();
    expect(inp.value).toBe("Workspace 7");
    expect(document.activeElement).toBe(inp);
    expect(inp.selectionStart).toBe(0);
    expect(inp.selectionEnd).toBe("Workspace 7".length);
  });

  it("shows the label chip", () => {
    openRenamePrompt({ label: "Rename workspace", value: "x", onCommit: vi.fn() });
    expect(document.querySelector(".workspace-rename-overlay .command-palette-label")?.textContent).toBe(
      "Rename workspace",
    );
  });

  it("Enter commits the trimmed value and closes", () => {
    const onCommit = vi.fn();
    openRenamePrompt({ value: "old", onCommit });
    const inp = input();
    inp.value = "  new name  ";
    inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(onCommit).toHaveBeenCalledWith("new name");
    expect(document.querySelector(".workspace-rename-overlay")).toBeNull();
  });

  it("Enter with a whitespace-only value closes without committing", () => {
    const onCommit = vi.fn();
    openRenamePrompt({ value: "old", onCommit });
    const inp = input();
    inp.value = "   ";
    inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(onCommit).not.toHaveBeenCalled();
    expect(document.querySelector(".workspace-rename-overlay")).toBeNull();
  });

  it("Escape closes without committing", () => {
    const onCommit = vi.fn();
    openRenamePrompt({ value: "old", onCommit });
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(onCommit).not.toHaveBeenCalled();
    expect(document.querySelector(".workspace-rename-overlay")).toBeNull();
  });

  it("backdrop click closes without committing", () => {
    const onCommit = vi.fn();
    openRenamePrompt({ value: "old", onCommit });
    const overlay = document.querySelector<HTMLElement>(".workspace-rename-overlay")!;
    overlay.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onCommit).not.toHaveBeenCalled();
    expect(document.querySelector(".workspace-rename-overlay")).toBeNull();
  });

  it("clicking inside the card does not close", () => {
    openRenamePrompt({ value: "old", onCommit: vi.fn() });
    const card = document.querySelector<HTMLElement>(".workspace-rename-overlay .command-palette-card")!;
    card.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(document.querySelector(".workspace-rename-overlay")).toBeTruthy();
  });

  it("opening a second prompt replaces the first", () => {
    openRenamePrompt({ value: "a", onCommit: vi.fn() });
    openRenamePrompt({ value: "b", onCommit: vi.fn() });
    expect(document.querySelectorAll(".workspace-rename-overlay").length).toBe(1);
    expect(input().value).toBe("b");
  });
});
