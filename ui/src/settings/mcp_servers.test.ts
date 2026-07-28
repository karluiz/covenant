import { describe, expect, it } from "vitest";
import { formatHeaderLines, parseHeaderLines } from "./mcp_servers";

describe("parseHeaderLines", () => {
  it("parses one header per line, splitting on the first colon", () => {
    expect(parseHeaderLines("Authorization: Bearer a:b:c\nX-Env: prod")).toEqual([
      ["Authorization", "Bearer a:b:c"],
      ["X-Env", "prod"],
    ]);
  });

  it("drops lines without a colon or with an empty name", () => {
    expect(parseHeaderLines("noheader\n: value\n\nX-Ok: 1")).toEqual([["X-Ok", "1"]]);
  });

  it("round-trips with formatHeaderLines", () => {
    const pairs: [string, string][] = [["Authorization", "Bearer t"]];
    expect(parseHeaderLines(formatHeaderLines(pairs))).toEqual(pairs);
  });
});
