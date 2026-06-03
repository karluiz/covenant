import { describe, it, expect } from "vitest";
import { initialNavState, applyNav, type NavEvent } from "./nav-state";

const ev = (p: Partial<NavEvent>): NavEvent => ({
  url: "https://a.com/",
  title: "a.com",
  canGoBack: false,
  canGoForward: false,
  loading: false,
  ...p,
});

describe("nav-state", () => {
  it("starts empty and not loading", () => {
    const s = initialNavState();
    expect(s.url).toBe("");
    expect(s.loading).toBe(false);
  });
  it("applies a nav event", () => {
    const s = applyNav(initialNavState(), ev({ url: "https://b.com/", title: "B", canGoBack: true, loading: true }));
    expect(s.url).toBe("https://b.com/");
    expect(s.title).toBe("B");
    expect(s.canGoBack).toBe(true);
    expect(s.loading).toBe(true);
  });
  it("derives a tab label from title, falling back to host", () => {
    const s = applyNav(initialNavState(), ev({ url: "https://x.com/p", title: "" }));
    expect(s.label).toBe("x.com");
  });
});
