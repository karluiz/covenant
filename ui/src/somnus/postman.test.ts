import { describe, expect, it } from "vitest";
import { parsePostman } from "./postman";
import { parseDraft } from "./draft";

const collection = {
  info: { name: "My API", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
  item: [
    {
      name: "Users",
      item: [
        {
          name: "List users",
          event: [{ listen: "test", script: { exec: ["pm.test()"] } }],
          request: {
            method: "GET",
            url: { raw: "{{base_url}}/users?page=1" },
            header: [
              { key: "Accept", value: "application/json" },
              { key: "X-Off", value: "x", disabled: true },
            ],
            auth: { type: "bearer", bearer: [{ key: "token", value: "{{tok}}", type: "string" }] },
          },
        },
      ],
    },
    {
      name: "Login",
      request: {
        method: "POST",
        url: "https://x.test/login",
        body: { mode: "urlencoded", urlencoded: [{ key: "u", value: "a" }, { key: "p", value: "b" }] },
      },
    },
    {
      name: "Upload",
      request: {
        method: "POST",
        url: "https://x.test/up",
        body: { mode: "formdata", formdata: [{ key: "f", type: "file" }] },
      },
    },
  ],
};

const environment = {
  name: "Staging",
  values: [
    { key: "base_url", value: "https://stg.test", enabled: true, type: "default" },
    { key: "tok", value: "s3cret", enabled: true, type: "secret" },
    { key: "off", value: "x", enabled: false },
  ],
};

describe("parsePostman collection", () => {
  const r = parsePostman(JSON.stringify(collection));
  it("detects a v2.1 collection and counts requests", () => {
    expect(r?.kind).toBe("collection");
    if (r?.kind !== "collection") return;
    expect(r.name).toBe("My API");
    expect(r.requests).toBe(3);
    expect(r.nodes).toHaveLength(3);
  });
  it("maps folders recursively and requests into drafts", () => {
    if (r?.kind !== "collection") return;
    const folder = r.nodes[0];
    expect(folder.kind).toBe("folder");
    expect(folder.children).toHaveLength(1);
    const draft = parseDraft(folder.children[0].request);
    expect(draft.method).toBe("GET");
    expect(draft.url).toBe("{{base_url}}/users?page=1");
    expect(draft.headers).toEqual([["Accept", "application/json"]]);
    expect(draft.auth).toEqual({ type: "bearer", token: "{{tok}}" });
  });
  it("maps urlencoded bodies to form mode", () => {
    if (r?.kind !== "collection") return;
    const draft = parseDraft(r.nodes[1].request);
    expect(draft.body_mode).toBe("form");
    expect(draft.body).toBe("u=a&p=b");
  });
  it("notes skipped features instead of dropping silently", () => {
    if (r?.kind !== "collection") return;
    expect(r.skipped.some((s) => s.includes("script"))).toBe(true);
    expect(r.skipped.some((s) => s.includes("formdata"))).toBe(true);
    expect(r.skipped.some((s) => s.includes("disabled"))).toBe(true);
  });
});

describe("parsePostman environment", () => {
  it("maps values incl. secret typing, skipping disabled", () => {
    const r = parsePostman(JSON.stringify(environment));
    expect(r?.kind).toBe("environment");
    if (r?.kind !== "environment") return;
    expect(r.name).toBe("Staging");
    expect(r.vars).toEqual([
      { key: "base_url", value: "https://stg.test", secret: false },
      { key: "tok", value: "s3cret", secret: true },
    ]);
  });
});

describe("parsePostman rejects", () => {
  it("garbage and unknown schemas return null", () => {
    expect(parsePostman("not json")).toBeNull();
    expect(parsePostman(JSON.stringify({ hello: 1 }))).toBeNull();
  });
});
