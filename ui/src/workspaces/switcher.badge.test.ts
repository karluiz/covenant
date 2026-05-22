import { describe, it, expect } from "vitest";
import type { ActivityState } from "./activity";
import { chipBadge } from "./switcher";

describe("chipBadge", () => {
  it("returns empty for null state", () => {
    expect(chipBadge(null)).toEqual({ className: "", text: "" });
  });
  it("returns empty for clean state", () => {
    const s: ActivityState = { unseenBlocks: 0, hasFailure: false, hasAgentNote: false };
    expect(chipBadge(s)).toEqual({ className: "", text: "" });
  });
  it("failure overrides unseen and agent note", () => {
    const s: ActivityState = { unseenBlocks: 5, hasFailure: true, hasAgentNote: true };
    expect(chipBadge(s)).toEqual({ className: "workspace-chip--has-failure", text: "" });
  });
  it("agent note overrides unseen", () => {
    const s: ActivityState = { unseenBlocks: 3, hasFailure: false, hasAgentNote: true };
    expect(chipBadge(s)).toEqual({ className: "workspace-chip--has-note", text: "" });
  });
  it("renders unseen count when no failure or note", () => {
    const s: ActivityState = { unseenBlocks: 7, hasFailure: false, hasAgentNote: false };
    expect(chipBadge(s)).toEqual({ className: "workspace-chip--unseen", text: "7" });
  });
});
