import { afterEach, describe, expect, it, vi } from "vitest";
import { openConfirmPrompt } from "./confirm-prompt";

afterEach(() => {
  document.body.innerHTML = "";
});

function overlay(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".workspace-confirm-overlay");
}

function confirmBtn(): HTMLButtonElement {
  return document.querySelector<HTMLButtonElement>(".workspace-confirm-confirm")!;
}

describe("openConfirmPrompt", () => {
  it("opens a palette-style overlay with label, message and focused confirm button", () => {
    openConfirmPrompt({
      label: "Delete workspace",
      message: 'Delete "Workspace 7"? Its tabs will be closed.',
      confirmText: "Delete",
      onConfirm: vi.fn(),
    });
    const el = overlay();
    expect(el).toBeTruthy();
    expect(el?.classList.contains("command-palette-overlay")).toBe(true);
    expect(el?.querySelector(".command-palette-label")?.textContent).toBe("Delete workspace");
    expect(el?.querySelector(".workspace-confirm-message")?.textContent).toBe(
      'Delete "Workspace 7"? Its tabs will be closed.',
    );
    expect(confirmBtn().textContent).toBe("Delete");
    expect(document.activeElement).toBe(confirmBtn());
  });

  it("clicking confirm runs onConfirm and closes", () => {
    const onConfirm = vi.fn();
    openConfirmPrompt({ message: "sure?", onConfirm });
    confirmBtn().click();
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(overlay()).toBeNull();
  });

  it("Enter confirms", () => {
    const onConfirm = vi.fn();
    openConfirmPrompt({ message: "sure?", onConfirm });
    overlay()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(overlay()).toBeNull();
  });

  it("clicking cancel closes without confirming", () => {
    const onConfirm = vi.fn();
    openConfirmPrompt({ message: "sure?", onConfirm });
    document.querySelector<HTMLButtonElement>(".workspace-confirm-cancel")!.click();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(overlay()).toBeNull();
  });

  it("Escape closes without confirming", () => {
    const onConfirm = vi.fn();
    openConfirmPrompt({ message: "sure?", onConfirm });
    overlay()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(overlay()).toBeNull();
  });

  it("backdrop click closes without confirming", () => {
    const onConfirm = vi.fn();
    openConfirmPrompt({ message: "sure?", onConfirm });
    overlay()!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(overlay()).toBeNull();
  });

  it("opening a second prompt replaces the first", () => {
    openConfirmPrompt({ message: "a", onConfirm: vi.fn() });
    openConfirmPrompt({ message: "b", onConfirm: vi.fn() });
    expect(document.querySelectorAll(".workspace-confirm-overlay").length).toBe(1);
    expect(document.querySelector(".workspace-confirm-message")?.textContent).toBe("b");
  });
});
