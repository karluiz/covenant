// Regression coverage for the mini markdown renderer. Originally scoped
// to the changelog; now also renders ACP agent prose (Claude streams real
// markdown), so the shapes below are load-bearing for the chat view.

import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./markdown";

describe("renderMarkdown", () => {
  it("renders headings, not literal ## (the ACP raw-MD bug)", () => {
    const html = renderMarkdown("## Opción A: Usar un template");
    expect(html).toBe("<h2>Opción A: Usar un template</h2>");
  });

  it("renders bold, italic, and inline code", () => {
    expect(renderMarkdown("necesita responder **3 preguntas**")).toContain(
      "<strong>3 preguntas</strong>",
    );
    expect(renderMarkdown("usa *cursiva* aquí")).toContain("<em>cursiva</em>");
    expect(renderMarkdown("ya tienes `persona-templates.ts` listo")).toContain(
      "<code>persona-templates.ts</code>",
    );
  });

  it("renders --- as a horizontal rule", () => {
    expect(renderMarkdown("antes\n\n---\n\ndespués")).toContain("<hr>");
  });

  it("renders fenced code blocks verbatim, without inline formatting", () => {
    const html = renderMarkdown("```\nALWAYS-YES:\n- correr **tests**\n```");
    expect(html).toContain("<pre><code>");
    expect(html).toContain("- correr **tests**"); // no <strong> inside fences
    expect(html).not.toContain("<strong>");
  });

  it("keeps a language tag as a lang- class", () => {
    expect(renderMarkdown("```rust\nfn main() {}\n```")).toContain('class="lang-rust"');
  });

  it("renders bullet lists", () => {
    const html = renderMarkdown("- uno\n- dos");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>uno</li>");
  });

  it("escapes HTML before formatting — agent text can't inject markup", () => {
    const html = renderMarkdown('hola <img src=x onerror="pwn()"> **bold**');
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
    expect(html).toContain("<strong>bold</strong>");
  });

  it("tolerates an unclosed fence at EOF (mid-stream chunk)", () => {
    const html = renderMarkdown("```\ntodavía streameando");
    expect(html).toContain("<pre><code>");
    expect(html).toContain("todavía streameando");
  });
});
