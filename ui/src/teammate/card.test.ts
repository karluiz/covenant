import { describe, expect, it } from "vitest";
import { splitMessageSegments, renderCardHtml, renderCardSegments } from "./card";

// A trivial cell renderer for structure assertions: HTML-escape only.
const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

describe("splitMessageSegments", () => {
  it("returns a single prose segment when there is no card fence", () => {
    const segs = splitMessageSegments("just a normal reply\nsecond line");
    expect(segs).toEqual([{ kind: "prose", text: "just a normal reply\nsecond line" }]);
  });

  it("parses a card fence with a title and label|value rows", () => {
    const text = "```card title=Last 10 commits\nb481d7d | operator threads plan\n76342a5 | spec\n```";
    const segs = splitMessageSegments(text);
    expect(segs).toEqual([
      {
        kind: "card",
        title: "Last 10 commits",
        rows: [
          { label: "b481d7d", value: "operator threads plan" },
          { label: "76342a5", value: "spec" },
        ],
      },
    ]);
  });

  it("accepts a bare title after `card ` (no title= prefix)", () => {
    const segs = splitMessageSegments("```card My Title\nrow\n```");
    expect(segs[0]).toMatchObject({ kind: "card", title: "My Title" });
  });

  it("treats a row with no pipe as a single full-width cell, and trims", () => {
    const segs = splitMessageSegments("```card\n  just one cell  \n```");
    expect(segs[0]).toEqual({ kind: "card", title: null, rows: [{ label: null, value: "just one cell" }] });
  });

  it("splits on the FIRST pipe only", () => {
    const segs = splitMessageSegments("```card\na | b | c\n```");
    expect((segs[0] as any).rows[0]).toEqual({ label: "a", value: "b | c" });
  });

  it("keeps prose before and after a card as separate segments", () => {
    const segs = splitMessageSegments("intro\n```card\nx | y\n```\noutro");
    expect(segs.map((s) => s.kind)).toEqual(["prose", "card", "prose"]);
    expect((segs[0] as any).text).toBe("intro");
    expect((segs[2] as any).text).toBe("outro");
  });

  it("falls back to prose for an unterminated fence", () => {
    const text = "```card title=Broken\nb481d7d | no closing fence";
    const segs = splitMessageSegments(text);
    expect(segs).toEqual([{ kind: "prose", text }]);
  });

  it("renders an empty card body as title only (no rows)", () => {
    const segs = splitMessageSegments("```card title=Empty\n```");
    expect(segs[0]).toEqual({ kind: "card", title: "Empty", rows: [] });
  });
});

describe("renderCardHtml", () => {
  it("emits a title and label/value rows, escaping via the cell renderer", () => {
    const html = renderCardHtml(
      { kind: "card", title: "T<>", rows: [{ label: "a&b", value: "v" }] },
      esc,
    );
    expect(html).toContain('<div class="teammate-card">');
    expect(html).toContain('<div class="teammate-card__title">T&lt;&gt;</div>');
    expect(html).toContain('<span class="teammate-card__label">a&amp;b</span>');
    expect(html).toContain('<span class="teammate-card__value">v</span>');
  });

  it("omits the title div when title is null", () => {
    const html = renderCardHtml({ kind: "card", title: null, rows: [] }, esc);
    expect(html).not.toContain("teammate-card__title");
  });

  it("emits a single full-width cell for a label-less row", () => {
    const html = renderCardHtml(
      { kind: "card", title: null, rows: [{ label: null, value: "solo" }] },
      esc,
    );
    expect(html).toContain('<span class="teammate-card__cell">solo</span>');
    expect(html).not.toContain("teammate-card__label");
  });
});

describe("renderCardSegments", () => {
  it("renders prose via the cell renderer and cards as blocks, in order", () => {
    const out = renderCardSegments("hi\n```card\na | b\n```\nbye", esc);
    expect(out).toBe("hi" + renderCardHtml({ kind: "card", title: null, rows: [{ label: "a", value: "b" }] }, esc) + "bye");
  });
});
