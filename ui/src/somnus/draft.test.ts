import { describe, expect, it } from "vitest";
import type { SomnusDraft, SomnusHistoryEntry } from "../api";
import {
  buildRequest,
  draftFromEntry,
  draftKey,
  emptyDraft,
  findUnresolvedDraft,
  parseDraft,
  parseForm,
  queryRows,
  serializeForm,
  withQueryRows,
} from "./draft";

const vars = new Map([["base_url", "https://api.test"], ["tok", "T"]]);

function draft(over: Partial<SomnusDraft>): SomnusDraft {
  return { ...emptyDraft(), ...over };
}

describe("query rows", () => {
  it("parses rows from the query string, tolerating {{vars}} in the host", () => {
    expect(queryRows("https://{{base_url}}/u?a=1&b=two%20words")).toEqual([
      ["a", "1"],
      ["b", "two words"],
    ]);
    expect(queryRows("https://x.test/plain")).toEqual([]);
  });
  it("writes rows back, dropping blank keys and the dangling ?", () => {
    expect(withQueryRows("https://{{base_url}}/u?old=1", [["a", "1"], ["", "x"]])).toBe(
      "https://{{base_url}}/u?a=1",
    );
    expect(withQueryRows("https://x.test/u?a=1", [])).toBe("https://x.test/u");
  });
});

describe("form body", () => {
  it("round-trips rows through the urlencoded string", () => {
    const rows: [string, string][] = [["a", "1"], ["b", "two words"]];
    expect(parseForm(serializeForm(rows))).toEqual(rows);
  });

  it("keeps {{var}} literal through serializeForm re-serialization", () => {
    expect(serializeForm([["a", "{{tok}}"]])).toBe("a={{tok}}");
    expect(parseForm(serializeForm([["a", "{{tok}}"]]))).toEqual([["a", "{{tok}}"]]);
  });
});

describe("withQueryRows braces", () => {
  it("keeps {{var}} literal instead of percent-encoding the braces", () => {
    expect(withQueryRows("https://x.test/u", [["q", "{{tok}}"]])).toBe("https://x.test/u?q={{tok}}");
  });
});

describe("parseDraft", () => {
  it("fills defaults for missing fields and garbage", () => {
    expect(parseDraft(null)).toEqual(emptyDraft());
    expect(parseDraft("garbage")).toEqual(emptyDraft());
    const d = parseDraft(JSON.stringify({ method: "POST", url: "https://x.test" }));
    expect(d.method).toBe("POST");
    expect(d.body_mode).toBe("none");
    expect(d.auth).toEqual({ type: "none" });
  });

  it("coalesces missing type-specific fields on a partial stored auth object", () => {
    const d = parseDraft(JSON.stringify({ auth: { type: "bearer" } }));
    expect(d.auth).toEqual({ type: "bearer", token: "" });
    expect(() => findUnresolvedDraft(d, vars)).not.toThrow();

    const basic = parseDraft(JSON.stringify({ auth: { type: "basic" } }));
    expect(basic.auth).toEqual({ type: "basic", username: "", password: "" });

    const apikey = parseDraft(JSON.stringify({ auth: { type: "apikey" } }));
    expect(apikey.auth).toEqual({ type: "apikey", key: "", value: "", placement: "header" });
  });
});

describe("buildRequest", () => {
  it("resolves vars in url, headers, and body", () => {
    const req = buildRequest(
      draft({
        method: "POST",
        url: "{{base_url}}/u",
        headers: [["X-T", "{{tok}}"]],
        body: '{"t":"{{tok}}"}',
        body_mode: "json",
      }),
      vars,
    );
    expect(req.url).toBe("https://api.test/u");
    expect(req.headers).toContainEqual(["X-T", "T"]);
    expect(req.body).toBe('{"t":"T"}');
  });

  it("merges compiled auth headers and query", () => {
    const req = buildRequest(
      draft({
        url: "https://x.test/u",
        auth: { type: "apikey", key: "k", value: "{{tok}}", placement: "query" },
      }),
      vars,
    );
    expect(req.url).toBe("https://x.test/u?k=T");
    const req2 = buildRequest(
      draft({ url: "https://x.test/u", auth: { type: "bearer", token: "abc" } }),
      vars,
    );
    expect(req2.headers).toContainEqual(["Authorization", "Bearer abc"]);
  });

  it("resolves {{vars}} in the URL's own query rows when auth query forces re-serialization", () => {
    const req = buildRequest(
      draft({
        url: "https://x.test/u?q={{tok}}",
        auth: { type: "apikey", key: "k", value: "static", placement: "query" },
      }),
      vars,
    );
    expect(req.url).toBe("https://x.test/u?q=T&k=static");
  });

  it("auto-sets Content-Type for json and form modes unless present", () => {
    const j = buildRequest(draft({ url: "https://x.test", body: "{}", body_mode: "json" }), vars);
    expect(j.headers).toContainEqual(["Content-Type", "application/json"]);
    const f = buildRequest(draft({ url: "https://x.test", body: "a=1", body_mode: "form" }), vars);
    expect(f.headers).toContainEqual(["Content-Type", "application/x-www-form-urlencoded"]);
    const explicit = buildRequest(
      draft({
        url: "https://x.test",
        body: "{}",
        body_mode: "json",
        headers: [["content-type", "application/vnd.custom+json"]],
      }),
      vars,
    );
    expect(explicit.headers.filter(([k]) => k.toLowerCase() === "content-type")).toHaveLength(1);
  });

  it("none mode sends no body; empty body sends null", () => {
    expect(buildRequest(draft({ url: "https://x.test", body: "x", body_mode: "none" }), vars).body).toBeNull();
    expect(buildRequest(draft({ url: "https://x.test", body: "", body_mode: "json" }), vars).body).toBeNull();
  });

  it("skips blank header rows", () => {
    const req = buildRequest(
      draft({ url: "https://x.test", headers: [["", "x"], ["A", "1"]] }),
      vars,
    );
    expect(req.headers).toEqual([["A", "1"]]);
  });
});

describe("findUnresolvedDraft", () => {
  it("unions missing keys across url, headers, body, and auth", () => {
    const missing = findUnresolvedDraft(
      draft({
        url: "{{host}}/u",
        headers: [["X", "{{h}}"]],
        body: "{{b}}",
        body_mode: "text",
        auth: { type: "bearer", token: "{{t}}" },
      }),
      vars,
    );
    expect(missing).toEqual(["host", "h", "b", "t"]);
  });
});

describe("draftKey / draftFromEntry", () => {
  it("draftKey is stable for equal drafts", () => {
    expect(draftKey(draft({ url: "https://x.test" }))).toBe(draftKey(draft({ url: "https://x.test" })));
    expect(draftKey(draft({ url: "https://x.test" }))).not.toBe(draftKey(draft({ url: "https://y.test" })));
  });
  it("draftFromEntry maps a history row into a draft", () => {
    const entry = {
      id: "1",
      method: "POST",
      url: "https://x.test/u",
      req_headers: [["content-type", "application/json"]],
      req_body: "{}",
      status: 200,
      resp_headers: [],
      resp_body: null,
      error: null,
      duration_ms: 1,
      size_bytes: 1,
      created_at_unix_ms: 0,
    } as SomnusHistoryEntry;
    const d = draftFromEntry(entry);
    expect(d.method).toBe("POST");
    expect(d.body).toBe("{}");
    expect(d.body_mode).toBe("json"); // inferred from content-type
    expect(d.auth).toEqual({ type: "none" });
  });
});
