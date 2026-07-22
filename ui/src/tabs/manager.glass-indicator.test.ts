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

  it("targets the group chip when the active pill is folded", () => {
    document.body.classList.add("tab-style-glass");
    const h = document.createElement("div");
    const shell = document.createElement("div");
    shell.className = "tab-group-shell";
    const chip = document.createElement("div");
    chip.className = "group-chip";
    chip.getBoundingClientRect = () =>
      ({ top: 40, left: 4, width: 200, height: 28 }) as DOMRect;
    const pill = document.createElement("div");
    pill.className = "tab-btn active tab-pill-folded";
    pill.getBoundingClientRect = () =>
      ({ top: 68, left: 4, width: 200, height: 0 }) as DOMRect;
    shell.append(chip, pill);
    h.appendChild(shell);
    document.body.appendChild(h);
    positionGlassIndicator(h);
    const ind = h.querySelector<HTMLElement>(".tab-glass-indicator")!;
    expect(ind.style.opacity).toBe("1");
    expect(ind.style.top).toBe("40px");
    expect(ind.style.height).toBe("28px");
  });

  it("hides when the folded active pill has no group chip", () => {
    document.body.classList.add("tab-style-glass");
    const h = document.createElement("div");
    const pill = document.createElement("div");
    pill.className = "tab-btn active tab-pill-folded";
    h.appendChild(pill);
    document.body.appendChild(h);
    positionGlassIndicator(h);
    const ind = h.querySelector<HTMLElement>(".tab-glass-indicator")!;
    expect(ind.style.opacity).toBe("0");
  });

  it("reuses the same indicator element across calls", () => {
    document.body.classList.add("tab-style-glass");
    const h = host(0);
    positionGlassIndicator(h);
    positionGlassIndicator(h);
    expect(h.querySelectorAll(".tab-glass-indicator").length).toBe(1);
  });
});
