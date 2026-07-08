import { describe, expect, it } from "vitest";
import { OPERATOR_PERSONA_TEMPLATES } from "./persona-templates";
import { PRESETS } from "../settings/operator_presets";

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

// Souls are delegations of the principal, not permission tables.
// See AGENTS.md § "The Ontology".
describe("persona templates are souls, not config", () => {
  for (const t of OPERATOR_PERSONA_TEMPLATES) {
    describe(t.name, () => {
      it("opens with the Mandate layer (first-person delegation)", () => {
        expect(t.persona).toMatch(/You are the version of me/);
      });

      it("ships clean markdown — no Milkdown backslash-escapes", () => {
        // The soul body is hand-authored source: `##` headings, `-` bullets.
        // A WYSIWYG round-trip escapes those to `\##` / `\-` / `\*`, corrupting
        // the saved file. Templates must ship — and stay — clean.
        expect(t.persona).not.toMatch(/\\[#*-]/);
        expect(t.persona).toMatch(/^## /m); // real headings, not escaped text
      });
    });
  }
});

describe("operator presets seed populated souls", () => {
  for (const p of PRESETS) {
    it(`${p.key} seeds a non-empty persona`, () => {
      expect(p.seed().persona.trim().length).toBeGreaterThan(0);
    });
  }
});
