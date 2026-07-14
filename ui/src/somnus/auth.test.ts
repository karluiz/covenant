import { describe, expect, it } from "vitest";
import { compileAuth } from "./auth";

describe("compileAuth", () => {
  it("none produces nothing", () => {
    expect(compileAuth({ type: "none" }, [])).toEqual({ headers: [], query: [] });
  });

  it("bearer produces an Authorization header", () => {
    expect(compileAuth({ type: "bearer", token: "abc" }, []).headers).toEqual([
      ["Authorization", "Bearer abc"],
    ]);
  });

  it("basic produces base64 credentials", () => {
    const { headers } = compileAuth({ type: "basic", username: "u", password: "p" }, []);
    expect(headers).toEqual([["Authorization", `Basic ${btoa("u:p")}`]]);
  });

  it("an explicit Authorization header wins over the auth tab", () => {
    const existing: [string, string][] = [["authorization", "custom"]];
    expect(compileAuth({ type: "bearer", token: "abc" }, existing).headers).toEqual([]);
    expect(compileAuth({ type: "basic", username: "u", password: "p" }, existing).headers).toEqual([]);
  });

  it("apikey in header placement produces a header, guarded by existing", () => {
    expect(
      compileAuth({ type: "apikey", key: "X-Api-Key", value: "k", placement: "header" }, []).headers,
    ).toEqual([["X-Api-Key", "k"]]);
    expect(
      compileAuth(
        { type: "apikey", key: "X-Api-Key", value: "k", placement: "header" },
        [["x-api-key", "mine"]],
      ).headers,
    ).toEqual([]);
  });

  it("apikey in query placement produces a query pair", () => {
    expect(
      compileAuth({ type: "apikey", key: "api_key", value: "k", placement: "query" }, []),
    ).toEqual({ headers: [], query: [["api_key", "k"]] });
  });

  it("empty credentials produce nothing", () => {
    expect(compileAuth({ type: "bearer", token: "" }, []).headers).toEqual([]);
    expect(
      compileAuth({ type: "apikey", key: "", value: "x", placement: "header" }, []).headers,
    ).toEqual([]);
  });
});
