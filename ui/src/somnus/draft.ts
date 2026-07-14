import type { SomnusAuth, SomnusBodyMode, SomnusDraft, SomnusHistoryEntry, SomnusRequest } from "../api";
import { compileAuth } from "./auth";
import { findUnresolved, resolveVars } from "./vars";

const BODY_MODES: SomnusBodyMode[] = ["none", "json", "text", "form"];

export function emptyDraft(): SomnusDraft {
  return { method: "GET", url: "", headers: [], body: "", body_mode: "none", auth: { type: "none" } };
}

/// Lenient parse of a stored draft blob — unknown/missing fields fall back
/// to defaults so old rows keep loading as the shape evolves.
export function parseDraft(json: string | null): SomnusDraft {
  const d = emptyDraft();
  if (!json) return d;
  try {
    const raw: unknown = JSON.parse(json);
    if (typeof raw !== "object" || raw === null) return d;
    const r = raw as Record<string, unknown>;
    if (typeof r.method === "string" && r.method) d.method = r.method;
    if (typeof r.url === "string") d.url = r.url;
    if (Array.isArray(r.headers)) {
      d.headers = (r.headers as unknown[])
        .filter((h): h is [string, string] => Array.isArray(h) && typeof h[0] === "string" && typeof h[1] === "string")
        .map((h) => [h[0], h[1]]);
    }
    if (typeof r.body === "string") d.body = r.body;
    if (BODY_MODES.includes(r.body_mode as SomnusBodyMode)) d.body_mode = r.body_mode as SomnusBodyMode;
    const a = r.auth as SomnusAuth | undefined;
    if (a && typeof a === "object" && ["none", "bearer", "basic", "apikey"].includes(a.type)) d.auth = a;
  } catch {
    // garbage → defaults
  }
  return d;
}

/// Canonical string for dirty comparison (field order fixed by emptyDraft).
export function draftKey(d: SomnusDraft): string {
  return JSON.stringify({
    method: d.method,
    url: d.url,
    headers: d.headers,
    body: d.body,
    body_mode: d.body_mode,
    auth: d.auth,
  });
}

// URLs may hold {{vars}} in the host, which new URL() rejects — all query
// manipulation is string-based on the part after the first "?".
function splitUrl(url: string): { base: string; query: string } {
  const i = url.indexOf("?");
  return i === -1 ? { base: url, query: "" } : { base: url.slice(0, i), query: url.slice(i + 1) };
}

export function queryRows(url: string): [string, string][] {
  const { query } = splitUrl(url);
  if (!query) return [];
  return [...new URLSearchParams(query).entries()];
}

export function withQueryRows(url: string, rows: [string, string][]): string {
  const { base } = splitUrl(url);
  const sp = new URLSearchParams();
  for (const [k, v] of rows) if (k.trim()) sp.append(k, v);
  const q = sp.toString();
  return q ? `${base}?${q}` : base;
}

export function serializeForm(rows: [string, string][]): string {
  const sp = new URLSearchParams();
  for (const [k, v] of rows) if (k.trim()) sp.append(k, v);
  return sp.toString();
}

export function parseForm(body: string): [string, string][] {
  if (!body) return [];
  return [...new URLSearchParams(body).entries()];
}

function hasHeader(headers: [string, string][], name: string): boolean {
  const n = name.toLowerCase();
  return headers.some(([k]) => k.trim().toLowerCase() === n);
}

const AUTO_CONTENT_TYPE: Partial<Record<SomnusBodyMode, string>> = {
  json: "application/json",
  form: "application/x-www-form-urlencoded",
};

/// The send pipeline (spec §Send pipeline):
/// draft → compileAuth → merge params/headers → resolveVars → SomnusRequest.
export function buildRequest(draft: SomnusDraft, vars: ReadonlyMap<string, string>): SomnusRequest {
  const headers = draft.headers.filter(([k]) => k.trim() !== "");
  const auth = compileAuth(draft.auth, headers);
  const merged = [...headers, ...auth.headers];
  let url = draft.url.trim();
  if (auth.query.length) {
    const resolvedAuthQuery = auth.query.map(([k, v]) => [resolveVars(k, vars), resolveVars(v, vars)] as [string, string]);
    url = withQueryRows(url, [...queryRows(url), ...resolvedAuthQuery]);
  }
  const auto = AUTO_CONTENT_TYPE[draft.body_mode];
  const body = draft.body_mode !== "none" && draft.body ? draft.body : null;
  if (body && auto && !hasHeader(merged, "Content-Type")) merged.push(["Content-Type", auto]);
  return {
    method: draft.method,
    url: resolveVars(url, vars),
    headers: merged.map(([k, v]) => [resolveVars(k, vars), resolveVars(v, vars)]),
    body: body === null ? null : resolveVars(body, vars),
  };
}

/// Missing {{keys}} across every field the pipeline resolves.
export function findUnresolvedDraft(draft: SomnusDraft, vars: ReadonlyMap<string, string>): string[] {
  const texts: string[] = [draft.url];
  for (const [k, v] of draft.headers) texts.push(k, v);
  if (draft.body_mode !== "none") texts.push(draft.body);
  const a = draft.auth;
  if (a.type === "bearer") texts.push(a.token);
  else if (a.type === "basic") texts.push(a.username, a.password);
  else if (a.type === "apikey") texts.push(a.key, a.value);
  const missing: string[] = [];
  for (const t of texts) {
    for (const k of findUnresolved(t, vars)) if (!missing.includes(k)) missing.push(k);
  }
  return missing;
}

/// History rows predate drafts — infer body_mode from the content-type.
export function draftFromEntry(e: SomnusHistoryEntry): SomnusDraft {
  const ct = e.req_headers.find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? "";
  let body_mode: SomnusBodyMode = "none";
  if (e.req_body) {
    if (ct.includes("json")) body_mode = "json";
    else if (ct.includes("x-www-form-urlencoded")) body_mode = "form";
    else body_mode = "text";
  }
  return {
    method: e.method,
    url: e.url,
    headers: e.req_headers.map(([k, v]) => [k, v]),
    body: e.req_body ?? "",
    body_mode,
    auth: { type: "none" },
  };
}
