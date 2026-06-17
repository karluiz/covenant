import { describe, it, expect } from "vitest";
import { highlightMatches, clearMarks } from "./find-highlight";

function div(html: string): HTMLElement {
  const el = document.createElement("div");
  el.innerHTML = html;
  return el;
}

describe("highlightMatches", () => {
  it("returns [] for an empty query and leaves the DOM untouched", () => {
    const root = div("<p>hello world</p>");
    expect(highlightMatches(root, "")).toEqual([]);
    expect(root.querySelectorAll("mark").length).toBe(0);
  });

  it("wraps a single match in a mark", () => {
    const root = div("<p>hello world</p>");
    const marks = highlightMatches(root, "world");
    expect(marks.length).toBe(1);
    expect(marks[0].textContent).toBe("world");
    expect(root.textContent).toBe("hello world");
    expect(root.querySelectorAll("mark.mv-find-hit").length).toBe(1);
  });

  it("is case-insensitive but preserves the original casing in the mark", () => {
    const root = div("<p>Handoff handoff HANDOFF</p>");
    const marks = highlightMatches(root, "handoff");
    expect(marks.map((m) => m.textContent)).toEqual(["Handoff", "handoff", "HANDOFF"]);
  });

  it("finds multiple matches within one text node", () => {
    const root = div("<p>aXaXa</p>");
    const marks = highlightMatches(root, "a");
    expect(marks.length).toBe(3);
    expect(root.textContent).toBe("aXaXa");
  });

  it("matches across separate elements, in document order", () => {
    const root = div("<h2>Rate limit</h2><p>the rate is fixed</p>");
    const marks = highlightMatches(root, "rate");
    expect(marks.length).toBe(2);
    // First mark is inside the heading, second inside the paragraph.
    expect(marks[0].closest("h2")).not.toBeNull();
    expect(marks[1].closest("p")).not.toBeNull();
  });

  it("does not double-wrap nodes already inside a mark", () => {
    const root = div("<p>chain</p>");
    highlightMatches(root, "chain");
    const again = highlightMatches(root, "chain");
    // Second pass finds nothing new because the text now lives inside a mark.
    expect(again.length).toBe(0);
    expect(root.querySelectorAll("mark").length).toBe(1);
  });

  it("clearMarks restores the original text and removes all marks", () => {
    const root = div("<p>the <strong>chain_id</strong> cap</p>");
    const before = root.innerHTML;
    const marks = highlightMatches(root, "chain");
    expect(marks.length).toBe(1);
    clearMarks(marks);
    expect(root.querySelectorAll("mark").length).toBe(0);
    expect(root.innerHTML).toBe(before);
  });

  it("clearMarks normalizes so a straddling match is found on the next pass", () => {
    const root = div("<p>foobar</p>");
    const first = highlightMatches(root, "foo"); // splits "foobar" → [foo][bar]
    clearMarks(first);
    // After normalize the text is one node again, so "oob" (which straddled
    // the old split point) is now matchable.
    const second = highlightMatches(root, "oob");
    expect(second.length).toBe(1);
    expect(second[0].textContent).toBe("oob");
  });
});
