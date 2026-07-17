import { describe, it, expect, vi } from "vitest";
import { sortSpecs } from "./view";

vi.mock("../../api", () => ({}));

const names = (specs: { name: string }[]): string[] => specs.map((s) => s.name);

describe("sortSpecs", () => {
  it("orders by dotted number, not lexicographically", () => {
    const specs = ["3.10-drafts", "3.2-multi", "3.1-master", "3.20-mind"].map((name) => ({ name }));
    expect(names(sortSpecs(specs))).toEqual(["3.1-master", "3.2-multi", "3.10-drafts", "3.20-mind"]);
  });

  it("sorts a third level under its parent", () => {
    const specs = ["3.9-export", "3.8.1-redesign", "3.8-convergence"].map((name) => ({ name }));
    expect(names(sortSpecs(specs))).toEqual(["3.8-convergence", "3.8.1-redesign", "3.9-export"]);
  });

  it("puts unnumbered specs last, alphabetically", () => {
    const specs = ["zebra", "3.2-multi", "alpha"].map((name) => ({ name }));
    expect(names(sortSpecs(specs))).toEqual(["3.2-multi", "alpha", "zebra"]);
  });
});
