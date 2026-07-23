import { describe, it, expect } from "vitest";
import { splitSizes, sizeRequestPaths, subtractNested } from "./sizes";

describe("splitSizes", () => {
  it("splits totals from target/ entries and defaults missing to 0", () => {
    const paths = ["/a", "/b"];
    const sizes: Array<[string, number]> = [["/a", 100], ["/a/target", 80], ["/b", 50]];
    const out = splitSizes(paths, sizes);
    expect(out.get("/a")).toEqual({ total: 100, target: 80 });
    expect(out.get("/b")).toEqual({ total: 50, target: 0 });
  });

  it("requests both worktree and target paths", () => {
    expect(sizeRequestPaths(["/a", "/b"])).toEqual(["/a", "/b", "/a/target", "/b/target"]);
  });
});

describe("subtractNested", () => {
  it("removes nested child bytes from a containing worktree", () => {
    const m = new Map([
      ["/main", { total: 6500, target: 50 }],
      ["/main/.covenant/worktrees/a", { total: 6000, target: 5900 }],
      ["/main/.covenant/worktrees/b", { total: 100, target: 0 }],
      ["/elsewhere/c", { total: 200, target: 0 }],
    ]);
    const out = subtractNested(m);
    expect(out.get("/main")!.total).toBe(400);       // 6500 - 6000 - 100
    expect(out.get("/main")!.target).toBe(50);        // target untouched
    expect(out.get("/main/.covenant/worktrees/a")!.total).toBe(6000); // unchanged
    expect(out.get("/elsewhere/c")!.total).toBe(200); // not nested, unchanged
  });
});
