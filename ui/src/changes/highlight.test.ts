import { describe, it, expect } from "vitest";
import { highlightInto } from "./highlight";

describe("highlightInto", () => {
  it("leaves text intact for unknown languages", () => {
    const el = document.createElement("span");
    el.textContent = "const x = 1";
    highlightInto(el, "const x = 1", "file.unknownext");
    expect(el.textContent).toBe("const x = 1");
  });

  it("preserves the full text content for a known language", () => {
    const el = document.createElement("span");
    const code = "const x = 1;";
    el.textContent = code;
    highlightInto(el, code, "a.ts");
    // tokens may add spans, but concatenated text must equal the source
    expect(el.textContent).toBe(code);
  });

  it("produces tok-* class spans for a known language", () => {
    const el = document.createElement("span");
    const code = "const x = 1;";
    el.textContent = code;
    highlightInto(el, code, "a.ts");
    // classHighlighter emits stable tok-* class names; verify real spans exist.
    // Confirmed in jsdom: 5 spans for 'const x = 1;' (keyword, variableName,
    // operator, number, punctuation).
    expect(el.querySelectorAll("span").length).toBeGreaterThan(0);
    // Spot-check that at least one span carries a tok-* class
    const spans = Array.from(el.querySelectorAll("span"));
    const hasTokClass = spans.some(s => s.className.startsWith("tok-"));
    expect(hasTokClass).toBe(true);
  });
});
