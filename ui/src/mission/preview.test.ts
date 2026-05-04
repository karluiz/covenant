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

  it("groups blank-line-separated lines into paragraphs", () => {
    const out = renderMarkdown("first line\n\nsecond line");
    expect(out).toContain("<p>first line</p>");
    expect(out).toContain("<p>second line</p>");
  });
});
