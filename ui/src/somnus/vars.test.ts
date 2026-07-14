import { describe, expect, it } from "vitest";
import { envVarsToMap, findUnresolved, resolveVars } from "./vars";

const vars = new Map([
  ["base_url", "https://api.test"],
  ["token", "s3cr3t"],
  ["other", "{{token}}"],
]);

describe("resolveVars", () => {
  it("substitutes known variables", () => {
    expect(resolveVars("{{base_url}}/users", vars)).toBe("https://api.test/users");
  });
  it("allows whitespace inside braces", () => {
    expect(resolveVars("{{ base_url }}/x", vars)).toBe("https://api.test/x");
  });
  it("leaves unknown variables literal", () => {
    expect(resolveVars("{{base_url}}/{{nope}}", vars)).toBe("https://api.test/{{nope}}");
  });
  it("is single-pass: values containing {{refs}} stay literal", () => {
    expect(resolveVars("{{other}}", vars)).toBe("{{token}}");
  });
  it("passes through text without variables", () => {
    expect(resolveVars("plain", vars)).toBe("plain");
  });
});

describe("findUnresolved", () => {
  it("lists missing keys once", () => {
    expect(findUnresolved("{{a}} {{b}} {{a}} {{base_url}}", vars)).toEqual(["a", "b"]);
  });
  it("returns empty when everything resolves", () => {
    expect(findUnresolved("{{base_url}}", vars)).toEqual([]);
  });
});

describe("envVarsToMap", () => {
  it("parses the stored JSON and skips blank keys", () => {
    const json = JSON.stringify([
      { key: "a", value: "1", secret: false },
      { key: "", value: "x", secret: false },
      { key: "b", value: "2", secret: true },
    ]);
    const m = envVarsToMap(json);
    expect(m.get("a")).toBe("1");
    expect(m.get("b")).toBe("2");
    expect(m.size).toBe(2);
  });
  it("returns an empty map on garbage", () => {
    expect(envVarsToMap("not json").size).toBe(0);
  });
});
