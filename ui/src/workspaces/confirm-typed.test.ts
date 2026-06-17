import { describe, it, expect, beforeEach, vi } from "vitest";
import { openConfirmTyped } from "./confirm-typed";

function overlay(): HTMLElement | null {
  return document.querySelector(".workspace-confirm-overlay");
}
function input(): HTMLInputElement {
  return document.querySelector<HTMLInputElement>(".workspace-confirm-typed-input")!;
}
function confirmBtn(): HTMLButtonElement {
  return document.querySelector<HTMLButtonElement>(".workspace-confirm-confirm")!;
}
function type(value: string): void {
  const el = input();
  el.value = value;
  el.dispatchEvent(new Event("input"));
}

describe("openConfirmTyped", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("renders with the confirm button disabled and the expected name shown", () => {
    openConfirmTyped({ label: "Destroy group", message: "gone", expected: "My Group", onConfirm: vi.fn() });
    expect(overlay()).not.toBeNull();
    expect(confirmBtn().disabled).toBe(true);
    expect(document.querySelector(".workspace-confirm-typed-name")?.textContent).toBe("My Group");
  });

  it("enables confirm only on an exact (trimmed) match", () => {
    openConfirmTyped({ message: "gone", expected: "My Group", onConfirm: vi.fn() });
    type("My Grou");
    expect(confirmBtn().disabled).toBe(true);
    type("my group"); // case-sensitive
    expect(confirmBtn().disabled).toBe(true);
    type("  My Group  "); // surrounding whitespace tolerated
    expect(confirmBtn().disabled).toBe(false);
  });

  it("does not fire onConfirm when the value doesn't match (button click or Enter)", () => {
    const onConfirm = vi.fn();
    openConfirmTyped({ message: "gone", expected: "My Group", onConfirm });
    type("wrong");
    confirmBtn().click();
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(overlay()).not.toBeNull(); // stays open
  });

  it("fires onConfirm once and closes when matched and confirmed", () => {
    const onConfirm = vi.fn();
    openConfirmTyped({ message: "gone", expected: "My Group", onConfirm });
    type("My Group");
    confirmBtn().click();
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(overlay()).toBeNull();
  });

  it("fires onConfirm on Enter when matched", () => {
    const onConfirm = vi.fn();
    openConfirmTyped({ message: "gone", expected: "X", onConfirm });
    type("X");
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(overlay()).toBeNull();
  });

  it("Escape cancels without confirming", () => {
    const onConfirm = vi.fn();
    openConfirmTyped({ message: "gone", expected: "X", onConfirm });
    type("X");
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(overlay()).toBeNull();
  });

  it("backdrop click cancels", () => {
    const onConfirm = vi.fn();
    openConfirmTyped({ message: "gone", expected: "X", onConfirm });
    overlay()!.click();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(overlay()).toBeNull();
  });
});
