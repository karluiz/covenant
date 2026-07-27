import { describe, it, expect, vi, beforeEach } from "vitest";
import { GlobalSearchPalette } from "./palette";
import { structureSearch } from "../api";

vi.mock("../api", () => ({
  structureSearch: vi.fn().mockResolvedValue([]),
  structureFindFiles: vi.fn().mockResolvedValue([]),
}));
vi.mock("../tooltip/tooltip", () => ({ attachTooltip: vi.fn() }));

const WT = "/repo/.covenant/worktrees/agent-x";
const MAIN = "/repo";

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function openPalette(mainRoot: string | null): { palette: GlobalSearchPalette; host: HTMLElement } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const palette = new GlobalSearchPalette(host, {
    cwd: () => WT,
    open: () => {},
    mainRoot: async () => mainRoot,
  });
  palette.open();
  return { palette, host };
}

const chip = (host: HTMLElement): HTMLElement =>
  host.querySelector<HTMLElement>(".global-search-scope")!;

const shiftTab = (host: HTMLElement): void => {
  host.querySelector<HTMLInputElement>(".global-search-input")!
    .dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }));
};

beforeEach(() => {
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("GlobalSearchPalette scope chip", () => {
  it("stays hidden when the cwd is not a linked worktree", async () => {
    const { host } = openPalette(null);
    await flush();
    expect(chip(host).hidden).toBe(true);
  });

  it("appears as WORKTREE once mainRoot resolves, and ⇧Tab flips it to MAIN", async () => {
    const { host } = openPalette(MAIN);
    await flush();
    expect(chip(host).hidden).toBe(false);
    expect(chip(host).dataset.scope).toBe("worktree");
    expect(chip(host).textContent).toBe("worktree");

    shiftTab(host);
    expect(chip(host).dataset.scope).toBe("main");
    shiftTab(host);
    expect(chip(host).dataset.scope).toBe("worktree");
  });

  it("searches in the main root when scope is MAIN, the worktree otherwise", async () => {
    const { host } = openPalette(MAIN);
    await flush();
    const input = host.querySelector<HTMLInputElement>(".global-search-input")!;
    input.value = "needle";

    shiftTab(host); // → main; non-empty query re-runs the search immediately
    await flush();
    expect(vi.mocked(structureSearch)).toHaveBeenLastCalledWith(MAIN, "needle", expect.any(Number));

    shiftTab(host); // → back to worktree
    await flush();
    expect(vi.mocked(structureSearch)).toHaveBeenLastCalledWith(WT, "needle", expect.any(Number));
  });

  it("⇧Tab is inert when there is no main root to switch to", async () => {
    const { host } = openPalette(null);
    await flush();
    shiftTab(host);
    expect(chip(host).hidden).toBe(true);
    expect(chip(host).dataset.scope).toBe("worktree");
  });
});
