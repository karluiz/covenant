import { describe, expect, it, vi } from "vitest";
import { buildActions } from "./actions";

describe("buildActions", () => {
  it("carries no implicit-target verbs — those are row-scoped now", () => {
    const ids = buildActions().map((a) => a.id);
    expect(ids).not.toContain("new-workspace");
    expect(ids).not.toContain("rename-workspace");
    expect(ids).not.toContain("delete-workspace");
    expect(ids).not.toContain("close-tab");
  });

  it("Vitals dispatches the open event", () => {
    const spy = vi.fn();
    window.addEventListener("covenant:open-vitals", spy);
    const a = buildActions().find((x) => x.id === "open-vitals")!;
    void a.run();
    expect(spy).toHaveBeenCalled();
    window.removeEventListener("covenant:open-vitals", spy);
  });
});
