import { afterEach, describe, expect, it } from "vitest";
import { CollapsedRail, monogram } from "./collapsed-rail";
import type { RailSnapshot } from "./manager";
import { applyFoldedRailStyle } from "./custom-style";

const SNAP: RailSnapshot = {
  items: [
    {
      kind: "group",
      group: {
        id: "g1",
        name: "karlTerminal",
        color: "#7aa2f7",
        tabs: [
          { id: "t1", name: "vite", color: null, active: false, kind: "shell" },
          { id: "t2", name: "cargo test", color: null, active: true, kind: "shell" },
        ],
      },
    },
    { kind: "tab", tab: { id: "t3", name: "zsh", color: null, active: false, kind: "shell" } },
    { kind: "tab", tab: { id: "t4", name: "docs", color: "#73daca", active: false, kind: "browser" } },
  ],
};

function mount(style: "legacy" | "glyph" | "labels" | "spine"): {
  host: HTMLElement;
  selected: string[];
  rail: CollapsedRail;
} {
  applyFoldedRailStyle(style);
  const host = document.createElement("div");
  const selected: string[] = [];
  const rail = new CollapsedRail(host, {
    snapshot: () => SNAP,
    selectTab: (id) => selected.push(id),
    setOnAfterRender: () => {},
  });
  return { host, selected, rail };
}

afterEach(() => {
  applyFoldedRailStyle("legacy");
});

describe("monogram", () => {
  it("takes the first two alphanumeric chars", () => {
    expect(monogram("cargo test")).toBe("ca");
    expect(monogram("  vite")).toBe("vi");
    expect(monogram("⚡ build")).toBe("bu");
    expect(monogram("x")).toBe("x");
  });

  it("falls back to a middot when nothing usable", () => {
    expect(monogram("⚡⚡")).toBe("·");
    expect(monogram("")).toBe("·");
  });
});

describe("CollapsedRail styles", () => {
  it("legacy renders the original pill cells", () => {
    const { host } = mount("legacy");
    expect(host.querySelectorAll(".tabbar-rail-cell").length).toBe(4);
    expect(host.querySelectorAll(".tabbar-rail-glyph-tile").length).toBe(0);
  });

  it("glyph renders monogram tiles with a group badge", () => {
    const { host, selected } = mount("glyph");
    const badge = host.querySelector<HTMLButtonElement>(".tabbar-rail-glyph-badge")!;
    expect(badge.textContent).toBe("ka");
    const tiles = Array.from(host.querySelectorAll<HTMLButtonElement>(".tabbar-rail-glyph-tile"));
    expect(tiles.map((t) => t.textContent)).toEqual(["vi", "ca", "zs", "🌐"]);
    expect(tiles[1].classList.contains("active")).toBe(true);
    tiles[0].click();
    badge.click();
    expect(selected).toEqual(["t1", "t1"]);
  });

  it("labels renders truncatable name rows under a group head", () => {
    const { host, selected } = mount("labels");
    expect(host.querySelector(".tabbar-rail-labels-head")!.textContent).toBe("karlTerminal");
    const rows = Array.from(host.querySelectorAll<HTMLButtonElement>(".tabbar-rail-labels-row"));
    expect(rows.map((r) => r.textContent)).toEqual(["vite", "cargo test", "zsh", "🌐 docs"]);
    expect(rows[1].classList.contains("active")).toBe(true);
    rows[3].click();
    expect(selected).toEqual(["t4"]);
  });

  it("spine renders one segment per tab under a group monogram", () => {
    const { host, selected } = mount("spine");
    expect(host.querySelector(".tabbar-rail-spine-mono")!.textContent).toBe("ka");
    const segs = Array.from(host.querySelectorAll<HTMLButtonElement>(".tabbar-rail-spine-seg"));
    expect(segs.length).toBe(4);
    expect(segs[1].classList.contains("active")).toBe(true);
    segs[2].click();
    expect(selected).toEqual(["t3"]);
  });

  it("re-renders when the style flips at runtime", () => {
    const { host, rail } = mount("legacy");
    expect(host.querySelectorAll(".tabbar-rail-cell").length).toBe(4);
    applyFoldedRailStyle("glyph");
    expect(host.querySelectorAll(".tabbar-rail-glyph-tile").length).toBe(4);
    rail.destroy();
    applyFoldedRailStyle("spine");
    expect(host.innerHTML).toBe("");
  });

  it("every non-legacy interactive element carries a hover peek", () => {
    for (const style of ["glyph", "labels", "spine"] as const) {
      const { host } = mount(style);
      const peeks = host.querySelectorAll(".tabbar-rail-cell-peek");
      // 4 tabs + 1 group header peek (labels heads skip the peek).
      expect(peeks.length).toBeGreaterThanOrEqual(4);
    }
  });
});
