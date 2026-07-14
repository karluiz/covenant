import { describe, expect, it } from "vitest";
import { healMilkdownEscapes } from "./soul_heal";

const FM = "---\nname: Zeta\nvoice: terse\n---\n";

describe("healMilkdownEscapes", () => {
  it("unescapes Milkdown block-syntax escapes in the body", () => {
    const raw = `${FM}Not risky — \\*irreversible\\*.\n\n\\## What I've decided\n\n\\- test, build → run them\n`;
    expect(healMilkdownEscapes(raw)).toBe(
      `${FM}Not risky — *irreversible*.\n\n## What I've decided\n\n- test, build → run them\n`,
    );
  });

  it("leaves front-matter untouched (regex deny rules keep their backslashes)", () => {
    const raw = `---\nname: Zeta\nhard_constraints: |\n  rm .*\\.env\n  [a-z\\-]+\n---\nbody \\*here\\*\n`;
    const healed = healMilkdownEscapes(raw);
    expect(healed).toContain("rm .*\\.env");
    expect(healed).toContain("[a-z\\-]+");
    expect(healed).toContain("body *here*");
  });

  it("skips fenced code blocks", () => {
    const raw = `${FM}before \\*x\\*\n\n\`\`\`\nliteral \\* stays\n\`\`\`\n\nafter \\- y\n`;
    const healed = healMilkdownEscapes(raw);
    expect(healed).toContain("before *x*");
    expect(healed).toContain("literal \\* stays");
    expect(healed).toContain("after - y");
  });

  it("is a no-op on clean input", () => {
    const raw = `${FM}You are Zeta.\n\n## Reflexes\n\n- commit on a feature branch → do it\n`;
    expect(healMilkdownEscapes(raw)).toBe(raw);
  });

  it("handles a body with no front-matter", () => {
    expect(healMilkdownEscapes("\\*hola\\*")).toBe("*hola*");
  });
});
