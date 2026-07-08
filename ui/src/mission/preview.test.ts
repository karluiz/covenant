import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./preview";

describe("renderMarkdown", () => {
  it("renders headings", () => {
    expect(renderMarkdown("# Title\n## Sub")).toContain("<h1>Title</h1>");
    expect(renderMarkdown("# Title\n## Sub")).toContain("<h2>Sub</h2>");
  });

  it("escapes html in plain text", () => {
    const out = renderMarkdown("Hello <script>x</script>");
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
  });

  it("renders unordered lists", () => {
    const out = renderMarkdown("- one\n- two");
    expect(out).toContain("<ul>");
    expect(out).toContain("<li>one</li>");
    expect(out).toContain("<li>two</li>");
  });

  it("renders fenced code blocks without escaping inside the block tag", () => {
    const out = renderMarkdown("```\nfn main() {}\n```");
    expect(out).toContain("<pre><code>");
    expect(out).toContain("fn main() {}");
  });

  it("renders inline code, bold, italic", () => {
    expect(renderMarkdown("a `b` c")).toContain("<code>b</code>");
    expect(renderMarkdown("**bold**")).toContain("<strong>bold</strong>");
    expect(renderMarkdown("*it*")).toContain("<em>it</em>");
  });

  it("renders ordered lists", () => {
    const out = renderMarkdown("1. one\n2. two");
    expect(out).toContain("<ol>");
    expect(out).toContain("<li>one</li>");
    expect(out).toContain("<li>two</li>");
    expect(out).not.toContain("1. one");
  });

  it("renders GFM tables with header, body and alignment", () => {
    const out = renderMarkdown(
      "| Endpoint | Dominio |\n|:---|---:|\n| `POST /x` | Payment |\n| `GET /y` | Account |",
    );
    expect(out).toContain("<table>");
    expect(out).toContain("<thead>");
    expect(out).toContain('<th style="text-align:left">Endpoint</th>');
    expect(out).toContain('<th style="text-align:right">Dominio</th>');
    expect(out).toContain('<td style="text-align:left"><code>POST /x</code></td>');
    expect(out).toContain("<td style=\"text-align:right\">Account</td>");
    // The separator row must not leak into output as text.
    expect(out).not.toContain(":---");
    expect(out).not.toContain("|");
  });

  it("does not treat a lone pipe line as a table", () => {
    const out = renderMarkdown("a | b without separator");
    expect(out).toContain("<p>a | b without separator</p>");
    expect(out).not.toContain("<table>");
  });

  it("groups blank-line-separated lines into paragraphs", () => {
    const out = renderMarkdown("first line\n\nsecond line");
    expect(out).toContain("<p>first line</p>");
    expect(out).toContain("<p>second line</p>");
  });
});
