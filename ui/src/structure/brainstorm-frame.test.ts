import { describe, it, expect } from "vitest";
import {
  isFullHtmlDocument,
  isBrainstormFragmentPath,
  htmlPreviewSrcdoc,
  BRAINSTORM_FRAME_TEMPLATE,
} from "./brainstorm-frame";

const FRAGMENT = `<h2>Spawns settings — which direction?</h2>\n<p class="subtitle">pick one</p>`;
const BRAINSTORM_PATH =
  "/Users/x/Sources/karlTerminal/.superpowers/brainstorm/24545-1781212925/content/spawns-layout.html";

describe("isFullHtmlDocument", () => {
  it("detects a doctype document", () => {
    expect(isFullHtmlDocument("<!DOCTYPE html><html></html>")).toBe(true);
  });
  it("detects an <html> document (leading whitespace)", () => {
    expect(isFullHtmlDocument("\n  <html><body></body></html>")).toBe(true);
  });
  it("treats a body fragment as not-a-document", () => {
    expect(isFullHtmlDocument(FRAGMENT)).toBe(false);
  });
});

describe("isBrainstormFragmentPath", () => {
  it("matches a brainstorm content fragment path", () => {
    expect(isBrainstormFragmentPath(BRAINSTORM_PATH)).toBe(true);
  });
  it("matches .htm too", () => {
    expect(
      isBrainstormFragmentPath(
        "/a/.superpowers/brainstorm/s1/content/waiting.htm",
      ),
    ).toBe(true);
  });
  it("rejects an unrelated html path", () => {
    expect(isBrainstormFragmentPath("/a/b/index.html")).toBe(false);
  });
  it("rejects null/empty", () => {
    expect(isBrainstormFragmentPath(null)).toBe(false);
    expect(isBrainstormFragmentPath(undefined)).toBe(false);
  });
});

describe("htmlPreviewSrcdoc", () => {
  it("wraps a brainstorm fragment in the frame (design shell present)", () => {
    const out = htmlPreviewSrcdoc(FRAGMENT, BRAINSTORM_PATH);
    // Fragment content is embedded…
    expect(out).toContain("Spawns settings");
    // …inside the vendored frame (theme vars + structure markers)…
    expect(out).toContain("--bg-primary");
    expect(out).toContain('id="claude-content"');
    // …and the placeholder is consumed, not left behind.
    expect(out).not.toContain("<!-- CONTENT -->");
  });

  it("passes a full document through unchanged", () => {
    const doc = "<!DOCTYPE html><html><body>hi</body></html>";
    expect(htmlPreviewSrcdoc(doc, BRAINSTORM_PATH)).toBe(doc);
  });

  it("leaves a non-brainstorm fragment untouched", () => {
    expect(htmlPreviewSrcdoc(FRAGMENT, "/some/other/file.html")).toBe(FRAGMENT);
  });

  it("the template exposes a single content placeholder", () => {
    expect(BRAINSTORM_FRAME_TEMPLATE.split("<!-- CONTENT -->").length).toBe(2);
  });
});
