import { describe, it, expect } from "vitest";
import { splitSizes, sizeRequestPaths } from "./sizes";

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
