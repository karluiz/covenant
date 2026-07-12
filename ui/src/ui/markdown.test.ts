// Regression coverage for the shared markdown renderer. Merged from the
// former release/markdown (changelog + ACP prose) and mission/preview
// (spec picker) suites — every shape below is load-bearing for at least
// one surface: changelog, ACP chat, mission viewer, spec preview, canon.

import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./markdown";

describe("renderMarkdown", () => {
  it("renders headings, not literal ## (the ACP raw-MD bug)", () => {
    const html = renderMarkdown("## Opción A: Usar un template");
    expect(html).toBe("<h2>Opción A: Usar un template</h2>");
  });

  it("renders h1–h4", () => {
    const html = renderMarkdown("# Title\n## Sub\n### Deep\n#### Deeper");
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<h2>Sub</h2>");
    expect(html).toContain("<h3>Deep</h3>");
    expect(html).toContain("<h4>Deeper</h4>");
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

  it("renders links with target=_blank", () => {
    const html = renderMarkdown("see [docs](https://example.com)");
    expect(html).toContain('<a href="https://example.com"');
    expect(html).toContain(">docs</a>");
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

  it("tolerates an unclosed fence at EOF (mid-stream chunk)", () => {
    const html = renderMarkdown("```\ntodavía streameando");
    expect(html).toContain("<pre><code>");
    expect(html).toContain("todavía streameando");
  });

  it("renders bullet lists", () => {
    const html = renderMarkdown("- uno\n- dos");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>uno</li>");
    expect(html).toContain("<li>dos</li>");
  });

  it("renders ordered lists", () => {
    const out = renderMarkdown("1. one\n2. two");
    expect(out).toContain("<ol>");
    expect(out).toContain("<li>one</li>");
    expect(out).toContain("<li>two</li>");
    expect(out).not.toContain("1. one");
  });

  it("closes a bullet list before an ordered list starts", () => {
    const out = renderMarkdown("- a\n1. b");
    expect(out).toContain("</ul>\n<ol>");
  });

  it("escapes HTML before formatting — agent text can't inject markup", () => {
    const html = renderMarkdown('hola <img src=x onerror="pwn()"> **bold**');
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
    expect(html).toContain("<strong>bold</strong>");
  });

  it("escapes html in plain text", () => {
    const out = renderMarkdown("Hello <script>x</script>");
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
  });

  it("renders GFM tables (the ACP flattened-table bug)", () => {
    const html = renderMarkdown(
      "| Policy | Behavior |\n|--------|----------|\n| `SuggestOnly` | Propose only |\n| `FullAuto` | Full autonomy |",
    );
    expect(html).toContain("<table>");
    expect(html).toContain("<th>Policy</th>");
    expect(html).toContain("<td><code>SuggestOnly</code></td>");
    expect(html).toContain("<td>Full autonomy</td>");
    expect(html).not.toContain("<p>");
  });

  it("honors table alignment colons on header and cells", () => {
    const out = renderMarkdown(
      "| Endpoint | Dominio |\n|:---|---:|\n| `POST /x` | Payment |\n| `GET /y` | Account |",
    );
    expect(out).toContain('<th style="text-align:left">Endpoint</th>');
    expect(out).toContain('<th style="text-align:right">Dominio</th>');
    expect(out).toContain('<td style="text-align:left"><code>POST /x</code></td>');
    expect(out).toContain('<td style="text-align:right">Account</td>');
    // The separator row must not leak into output as text.
    expect(out).not.toContain(":---");
  });

  it("table ends at the first non-pipe line", () => {
    const html = renderMarkdown("| a | b |\n| :--- | ---: |\n| 1 | 2 |\nafter");
    expect(html).toContain('<td style="text-align:left">1</td>');
    expect(html).toContain("<p>after</p>");
  });

  it("does not treat a lone pipe line as a table", () => {
    const out = renderMarkdown("a | b without separator");
    expect(out).toContain("<p>a | b without separator</p>");
    expect(out).not.toContain("<table>");
  });

  it("a plain --- after a pipe-containing paragraph stays an hr, not a table", () => {
    const html = renderMarkdown("uses a | pipe\n\n---");
    expect(html).toContain("<hr>");
    expect(html).not.toContain("<table>");
  });

  it("groups blank-line-separated lines into paragraphs", () => {
    const out = renderMarkdown("first line\n\nsecond line");
    expect(out).toContain("<p>first line</p>");
    expect(out).toContain("<p>second line</p>");
  });
});
