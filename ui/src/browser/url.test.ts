import { describe, it, expect } from "vitest";
import { normalizeAddress } from "./url";

describe("normalizeAddress", () => {
  it("passes through schemed URLs", () => {
    expect(normalizeAddress("https://example.com/x")).toBe("https://example.com/x");
  });
  it("prepends http:// for localhost:port", () => {
    expect(normalizeAddress("localhost:4321")).toBe("http://localhost:4321/");
  });
  it("prepends http:// for IP:port", () => {
    expect(normalizeAddress("127.0.0.1:3000")).toBe("http://127.0.0.1:3000/");
  });
  it("prepends https:// for bare domains", () => {
    expect(normalizeAddress("example.com")).toBe("https://example.com/");
  });
  it("treats free text as a DuckDuckGo search", () => {
    expect(normalizeAddress("rust async traits")).toBe(
      "https://duckduckgo.com/?q=rust%20async%20traits",
    );
  });
  it("trims surrounding whitespace", () => {
    expect(normalizeAddress("  example.com  ")).toBe("https://example.com/");
  });
});
