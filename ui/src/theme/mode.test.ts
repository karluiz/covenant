import { describe, it, expect, beforeEach, vi } from "vitest";
import { resolveTheme } from "./mode";

describe("resolveTheme", () => {
  beforeEach(() => {
    window.matchMedia = vi.fn().mockImplementation((q: string) => ({
      matches: false,
      media: q,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia;
  });

  it("returns dark for ThemeMode.dark", () => {
    expect(resolveTheme("dark")).toBe("dark");
  });

  it("returns light for ThemeMode.light", () => {
    expect(resolveTheme("light")).toBe("light");
  });

  it("resolves system to dark when prefers-color-scheme: light does NOT match", () => {
    expect(resolveTheme("system")).toBe("dark");
  });

  it("resolves system to light when prefers-color-scheme: light matches", () => {
    window.matchMedia = vi.fn().mockReturnValue({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }) as unknown as typeof window.matchMedia;
    expect(resolveTheme("system")).toBe("light");
  });
});
