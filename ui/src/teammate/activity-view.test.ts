import { describe, it, expect } from "vitest";
import { detailForDecision, tabChipHtml } from "./activity-view";

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

describe("origin-tab chip", () => {
  it("renders a clickable chip for a live tab", () => {
    const html = tabChipHtml({ short: "WE6JN9", name: "pi updates", open: true });
    expect(html).toContain("pi updates");
    expect(html).toContain('data-session-short="WE6JN9"');
    expect(html).toContain('role="button"');
    expect(html).not.toContain("closed");
  });

  it("renders a muted, non-clickable chip with a closed marker for a dead tab", () => {
    const html = tabChipHtml({ short: "WE6JN9", name: "old tab", open: false });
    expect(html).toContain("old tab");
    expect(html).toContain("tp-act-tab--closed");
    expect(html).toContain("closed");
    expect(html).not.toContain("data-session-short");
  });

  it("renders nothing when origin is unknown", () => {
    expect(tabChipHtml(null)).toBe("");
  });

  it("escapes the tab name", () => {
    const html = tabChipHtml({ short: "abc123", name: "<script>", open: true });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
