import { describe, expect, it } from "vitest";
import { OPERATOR_PERSONA_TEMPLATES } from "./persona-templates";

describe("OPERATOR_PERSONA_TEMPLATES", () => {
  it("ships exactly 6 templates", () => {
    expect(OPERATOR_PERSONA_TEMPLATES).toHaveLength(6);
  });

  it("each template has a non-empty name and persona", () => {
    for (const t of OPERATOR_PERSONA_TEMPLATES) {
      expect(t.name.trim().length).toBeGreaterThan(0);
      expect(t.persona.trim().length).toBeGreaterThan(20);
    }
  });

  it("template names are unique", () => {
    const names = OPERATOR_PERSONA_TEMPLATES.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("includes the canonical Cautious senior baseline", () => {
    const names = OPERATOR_PERSONA_TEMPLATES.map((t) => t.name);
    expect(names).toContain("Cautious senior");
  });
});
