import { describe, it, expect, beforeEach } from "vitest";
import { positionGlassIndicator } from "./glass-indicator";

function host(activeIdx: number): HTMLElement {
  const h = document.createElement("div");
  h.id = "tabs";
  ["a", "b", "c"].forEach((_id, i) => {
    const t = document.createElement("div");
    t.className = "tab-btn" + (i === activeIdx ? " active" : "");
    t.style.setProperty("--tab-color", "#7aa2f7");
    h.appendChild(t);
  });
  document.body.appendChild(h);
  return h;
}

describe("positionGlassIndicator", () => {
  beforeEach(() => { document.body.innerHTML = ""; document.body.className = ""; });

  it("creates exactly one indicator under glass and shows it", () => {
    document.body.classList.add("tab-style-glass");
    const h = host(1);
    positionGlassIndicator(h);
    const inds = h.querySelectorAll(".tab-glass-indicator");
    expect(inds.length).toBe(1);
    expect((inds[0] as HTMLElement).style.opacity).toBe("1");
  });

  it("hides the indicator when no active tab", () => {
    document.body.classList.add("tab-style-glass");
    const h = host(-1);
    positionGlassIndicator(h);
    const ind = h.querySelector<HTMLElement>(".tab-glass-indicator")!;
    expect(ind.style.opacity).toBe("0");
  });

  it("is a no-op (no indicator) when not glass", () => {
    const h = host(1);
    positionGlassIndicator(h);
    expect(h.querySelector(".tab-glass-indicator")).toBeNull();
  });

  it("reuses the same indicator element across calls", () => {
    document.body.classList.add("tab-style-glass");
    const h = host(0);
    positionGlassIndicator(h);
    positionGlassIndicator(h);
    expect(h.querySelectorAll(".tab-glass-indicator").length).toBe(1);
  });
});
