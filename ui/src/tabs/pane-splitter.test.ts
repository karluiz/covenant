import { describe, expect, it, vi } from "vitest";
import { installPaneSplitter } from "./pane-splitter";

describe("installPaneSplitter", () => {
  it("calls onCommit on pointerup with the final ratio", async () => {
    document.body.innerHTML = `
      <div id="block" style="width:400px;height:200px">
        <div id="splitter" style="width:4px"></div>
      </div>
    `;
    const block = document.getElementById("block")!;
    const splitter = document.getElementById("splitter")!;
    Object.defineProperty(block, "offsetWidth", { value: 400, configurable: true });
    Object.defineProperty(block, "offsetHeight", { value: 200, configurable: true });

    const onRatio = vi.fn();
    const onCommit = vi.fn();
    const dispose = installPaneSplitter({
      splitter,
      block,
      orientation: "horizontal",
      onRatio,
      onCommit,
    });

    splitter.dispatchEvent(new PointerEvent("pointerdown", { clientX: 200, clientY: 100, pointerId: 1 }));
    splitter.dispatchEvent(new PointerEvent("pointermove", { clientX: 300, clientY: 100, pointerId: 1 }));

    // wait for RAF flush
    await new Promise((r) => requestAnimationFrame(() => r(undefined)));

    splitter.dispatchEvent(new PointerEvent("pointerup", { clientX: 300, clientY: 100, pointerId: 1 }));

    expect(onRatio).toHaveBeenCalled();
    expect(onCommit).toHaveBeenCalled();
    // dragged 100px / 400px width = 0.25 delta; starting at 0.5 → ~0.75
    const calls = onCommit.mock.calls;
    const finalRatio = calls[calls.length - 1]?.[0];
    expect(finalRatio).toBeCloseTo(0.75, 1);

    dispose();
  });

  it("returns a dispose function that removes the listener", () => {
    document.body.innerHTML = `<div id="block"><div id="splitter"></div></div>`;
    const block = document.getElementById("block")!;
    const splitter = document.getElementById("splitter")!;
    const onRatio = vi.fn();
    const onCommit = vi.fn();
    const dispose = installPaneSplitter({
      splitter, block, orientation: "horizontal", onRatio, onCommit,
    });
    dispose();
    splitter.dispatchEvent(new PointerEvent("pointerdown", { clientX: 0, clientY: 0, pointerId: 1 }));
    expect(onRatio).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });
});
