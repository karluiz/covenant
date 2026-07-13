import { describe, it, expect, vi } from "vitest";
import { renderRail, countsLabel, splitPath } from "./rail";
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

  it("shows the directory line under the file name", () => {
    const el = renderRail(changes, noop);
    const row = [...el.querySelectorAll<HTMLElement>(".cd-file")].find(r => r.dataset.path === "src/bar.ts")!;
    expect(row.querySelector(".cd-file-dir")?.textContent).toBe("src/");
    expect(row.querySelector(".cd-file-name")?.textContent).toBe("bar.ts");
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

  it("Stage all passes every unstaged path", () => {
    const onStageAll = vi.fn();
    const el = renderRail(changes, { ...noop, onStageAll });
    const acts = [...el.querySelectorAll<HTMLElement>(".cd-group-act")];
    acts.find(a => a.textContent === "Stage all")!.click();
    expect(onStageAll).toHaveBeenCalledWith(["src/bar.ts", "x.bmp"]);
  });

  it("shows an empty-state note when nothing is staged", () => {
    const el = renderRail({ staged: [], unstaged: changes.unstaged }, noop);
    expect(el.querySelector(".cd-group-empty")?.textContent).toMatch(/commit takes everything/i);
  });
});

describe("countsLabel", () => {
  const base = { oldPath: null, binary: false } as const;
  it("labels lockfiles as generated", () => {
    expect(countsLabel({ ...base, path: "Cargo.lock", status: "modified", added: 209, removed: 0 })).toBe("generated");
  });
  it("labels empty untracked files as new", () => {
    expect(countsLabel({ ...base, path: "otel.rs", status: "untracked", added: 0, removed: 0 })).toBe("new");
  });
  it("renders signed counts", () => {
    expect(countsLabel({ ...base, path: "a.rs", status: "modified", added: 3, removed: 1 })).toBe("+3 −1");
  });
});

describe("splitPath", () => {
  it("splits directory and basename", () => {
    expect(splitPath("crates/score/src/otel.rs")).toEqual(["crates/score/src", "otel.rs"]);
    expect(splitPath("Cargo.lock")).toEqual(["", "Cargo.lock"]);
  });
});
