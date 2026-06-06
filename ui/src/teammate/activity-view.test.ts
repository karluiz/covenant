import { describe, it, expect } from "vitest";
import { detailForDecision } from "./activity-view";

describe("activity detail", () => {
  it("includes in-flight command and full escalation", () => {
    const d = detailForDecision({
      kind: "escalated",
      inFlightCommand: "claude --dangerously-skip-permissions",
      escalation: "Your executor isn't accepting input",
      rationale: "loop guard (repeat-reply)",
      replyText: null,
      outputExcerpt: "…tail…",
    });
    expect(d).toContain("claude --dangerously-skip-permissions");
    expect(d).toContain("Your executor isn't accepting input");
  });

  it("is empty when there is nothing to show", () => {
    const d = detailForDecision({
      kind: "waited",
      inFlightCommand: null,
      escalation: null,
      rationale: null,
      replyText: null,
      outputExcerpt: null,
    });
    expect(d).toBe("");
  });

  it("includes reply text and output tail for typed rows", () => {
    const d = detailForDecision({
      kind: "typed",
      inFlightCommand: "aider",
      escalation: null,
      rationale: "ALWAYS-YES",
      replyText: "y",
      outputExcerpt: "proceed? [y/N]",
    });
    expect(d).toContain("$ aider");
    expect(d).toContain("reply: y");
    expect(d).toContain("proceed? [y/N]");
  });
});
