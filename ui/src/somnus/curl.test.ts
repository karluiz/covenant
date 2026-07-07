import { describe, expect, it } from "vitest";
import { parseCurl } from "./curl";

describe("parseCurl", () => {
  it("returns null for non-curl input", () => {
    expect(parseCurl("https://api.test/things")).toBeNull();
    expect(parseCurl("")).toBeNull();
    expect(parseCurl("curling is a sport")).toBeNull();
  });

  it("parses a bare GET", () => {
    expect(parseCurl("curl https://api.test/things")).toEqual({
      method: "GET",
      url: "https://api.test/things",
      headers: [],
      body: null,
    });
  });

  it("parses method, headers, and body with mixed quoting", () => {
    const p = parseCurl(
      `curl -X PUT https://api.test/things/1 -H 'Content-Type: application/json' -H "X-Token: abc" -d '{"name":"x"}'`,
    );
    expect(p).toEqual({
      method: "PUT",
      url: "https://api.test/things/1",
      headers: [
        ["Content-Type", "application/json"],
        ["X-Token", "abc"],
      ],
      body: '{"name":"x"}',
    });
  });

  it("--request/--header/--data long forms work", () => {
    const p = parseCurl(
      "curl --request DELETE --header 'X-A: 1' --data 'k=v' https://api.test/x",
    );
    expect(p?.method).toBe("DELETE");
    expect(p?.headers).toEqual([["X-A", "1"]]);
    expect(p?.body).toBe("k=v");
  });

  it("-d without -X implies POST", () => {
    expect(parseCurl("curl https://api.test -d a=b")?.method).toBe("POST");
  });

  it("survives line continuations and unknown flags", () => {
    const p = parseCurl("curl -s --compressed \\\n  -o out.json https://api.test/x");
    expect(p?.url).toBe("https://api.test/x");
    expect(p?.method).toBe("GET");
  });

  it("returns null when no URL is present", () => {
    expect(parseCurl("curl -s -X GET")).toBeNull();
  });

  it("parses attached short-flag forms (-XDELETE, -d'...')", () => {
    const p = parseCurl("curl -XDELETE https://api.test/x");
    expect(p?.method).toBe("DELETE");
    const q = parseCurl("curl -d'foo=bar' https://api.test/x");
    expect(q?.body).toBe("foo=bar");
    expect(q?.method).toBe("POST");
    expect(q?.url).toBe("https://api.test/x");
  });

  it("does not mistake an unknown value-flag's argument for the URL", () => {
    const p = parseCurl("curl -F 'file=@a.jpg' https://api.test/upload");
    expect(p?.url).toBe("https://api.test/upload");
    const q = parseCurl("curl --some-unknown-flag value https://api.test/x");
    expect(q?.url).toBe("https://api.test/x");
  });
});
