import { describe, expect, it } from "vitest";
import { jsonTree, parseJsonBody } from "./json-tree";

describe("parseJsonBody", () => {
  it("parses objects and arrays, rejects everything else", () => {
    expect(parseJsonBody('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonBody("  [1,2]  ")).toEqual([1, 2]);
    expect(parseJsonBody("plain text")).toBeUndefined();
    expect(parseJsonBody('{"truncated":')).toBeUndefined();
    expect(parseJsonBody("")).toBeUndefined();
  });
});

describe("jsonTree", () => {
  it("renders an open root with typed leaves", () => {
    const el = jsonTree({ s: "hi", n: 4, b: true, z: null });
    expect(el.tagName).toBe("DETAILS");
    expect((el as HTMLDetailsElement).open).toBe(true);
    expect(el.querySelector(".jt-badge")?.textContent).toBe("{4}");
    expect(el.querySelector(".jt-str")?.textContent).toBe('"hi"');
    expect(el.querySelector(".jt-num")?.textContent).toBe("4");
    expect(el.querySelector(".jt-bool")?.textContent).toBe("true");
    expect(el.querySelector(".jt-null")?.textContent).toBe("null");
  });

  it("builds nested children lazily on first toggle", () => {
    const el = jsonTree({ inner: { a: 1 } });
    const inner = el.querySelector(".jt-children .jt-node");
    expect(inner).not.toBeNull();
    expect(inner?.querySelector(".jt-children")?.childElementCount).toBe(0);
    inner?.dispatchEvent(new Event("toggle"));
    expect(inner?.querySelector(".jt-children")?.childElementCount).toBe(1);
  });

  it("caps children at 500 and reports the remainder", () => {
    const el = jsonTree(Array.from({ length: 640 }, (_, i) => i));
    const kids = el.querySelector(":scope > .jt-children");
    expect(kids?.querySelectorAll(".jt-leaf").length).toBe(500);
    expect(kids?.querySelector(".jt-more")?.textContent).toContain("140 more");
    expect(el.querySelector(".jt-badge")?.textContent).toBe("[640]");
  });
});
