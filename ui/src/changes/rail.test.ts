import { describe, it, expect, vi } from "vitest";
import { renderRail } from "./rail";
import type { Changes } from "../api";

const changes: Changes = {
  staged: [{ path: "a.ts", oldPath: null, status: "added", added: 8, removed: 0, binary: false }],
  unstaged: [
    { path: "src/bar.ts", oldPath: null, status: "modified", added: 43, removed: 2, binary: false },
    { path: "x.bmp", oldPath: null, status: "untracked", added: 0, removed: 0, binary: true },
  ],
};
const noop = { onSelect() {}, onStage() {}, onUnstage() {} };

describe("renderRail", () => {
  it("renders Staged and Unstaged groups with counts", () => {
    const el = renderRail(changes, noop);
    const groups = el.querySelectorAll(".cd-group-title");
    expect(groups[0].textContent).toMatch(/Staged.*1/);
    expect(groups[1].textContent).toMatch(/Unstaged.*2/);
  });

  it("shows +/- counts and binary tag", () => {
    const el = renderRail(changes, noop);
    expect(el.textContent).toContain("+43");
    expect(el.textContent).toMatch(/binary/i);
  });

  it("filters rows by substring", () => {
    const el = renderRail(changes, noop, "bar");
    const rows = el.querySelectorAll(".cd-file");
    expect(rows.length).toBe(1);
    expect(rows[0].textContent).toContain("bar.ts");
  });

  it("calls onStage from an unstaged row's stage button", () => {
    const onStage = vi.fn();
    const el = renderRail(changes, { ...noop, onStage });
    const row = [...el.querySelectorAll<HTMLElement>(".cd-file")].find(r => r.textContent?.includes("bar.ts"))!;
    row.querySelector<HTMLElement>(".cd-stage-btn")!.click();
    expect(onStage).toHaveBeenCalledWith("src/bar.ts");
  });

  it("calls onSelect when a row is clicked", () => {
    const onSelect = vi.fn();
    const el = renderRail(changes, { ...noop, onSelect });
    const row = [...el.querySelectorAll<HTMLElement>(".cd-file")].find(r => r.textContent?.includes("a.ts"))!;
    row.click();
    expect(onSelect).toHaveBeenCalledWith("a.ts", true);
  });
});
