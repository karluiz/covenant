import type { SomnusAuth, SomnusDraft, SomnusEnvVar, SomnusImportNode } from "../api";
import { serializeForm } from "./draft";

export type PostmanResult =
  | { kind: "collection"; name: string; nodes: SomnusImportNode[]; requests: number; skipped: string[] }
  | { kind: "environment"; name: string; vars: SomnusEnvVar[] }
  | null;

type Obj = Record<string, unknown>;

const asObj = (v: unknown): Obj | null => (typeof v === "object" && v !== null ? (v as Obj) : null);
const asStr = (v: unknown): string => (typeof v === "string" ? v : "");

/// Postman v2.1 auth params are arrays of {key,value}; fetch one by key.
function pv(list: unknown, key: string): string {
  if (!Array.isArray(list)) return "";
  const hit = list.map(asObj).find((o) => o && asStr(o.key) === key);
  return hit ? asStr(hit.value) : "";
}

function mapAuth(raw: unknown, skipped: string[], at: string): SomnusAuth {
  const a = asObj(raw);
  if (!a) return { type: "none" };
  const t = asStr(a.type);
  if (t === "bearer") return { type: "bearer", token: pv(a.bearer, "token") };
  if (t === "basic") {
    return { type: "basic", username: pv(a.basic, "username"), password: pv(a.basic, "password") };
  }
  if (t === "apikey") {
    const placement = pv(a.apikey, "in") === "query" ? "query" : "header";
    return { type: "apikey", key: pv(a.apikey, "key"), value: pv(a.apikey, "value"), placement };
  }
  if (t && t !== "noauth") skipped.push(`${at}: auth type "${t}" not supported`);
  return { type: "none" };
}

function mapRequest(name: string, raw: Obj, skipped: string[]): SomnusImportNode {
  const draft: SomnusDraft = {
    method: asStr(raw.method) || "GET",
    url: asStr(raw.url) || asStr(asObj(raw.url)?.raw),
    headers: [],
    body: "",
    body_mode: "none",
    auth: mapAuth(raw.auth, skipped, name),
  };
  if (Array.isArray(raw.header)) {
    for (const h of raw.header.map(asObj)) {
      if (!h) continue;
      if (h.disabled === true) {
        skipped.push(`${name}: disabled header "${asStr(h.key)}"`);
        continue;
      }
      draft.headers.push([asStr(h.key), asStr(h.value)]);
    }
  }
  const body = asObj(raw.body);
  if (body) {
    const mode = asStr(body.mode);
    if (mode === "raw") {
      draft.body = asStr(body.raw);
      const lang = asStr(asObj(asObj(body.options)?.raw)?.language);
      draft.body_mode = lang === "json" || draft.body.trim().startsWith("{") ? "json" : "text";
    } else if (mode === "urlencoded" && Array.isArray(body.urlencoded)) {
      const rows: [string, string][] = [];
      for (const p of body.urlencoded.map(asObj)) {
        if (!p || p.disabled === true) continue;
        rows.push([asStr(p.key), asStr(p.value)]);
      }
      draft.body = serializeForm(rows);
      draft.body_mode = "form";
    } else if (mode) {
      skipped.push(`${name}: ${mode} body not supported`);
    }
  }
  if (Array.isArray(raw.event) && raw.event.length) {
    skipped.push(`${name}: scripts/tests not supported`);
  }
  return { kind: "request", name, request: JSON.stringify(draft), children: [] };
}

function mapItems(items: unknown[], skipped: string[], count: { n: number }): SomnusImportNode[] {
  const out: SomnusImportNode[] = [];
  for (const it of items.map(asObj)) {
    if (!it) continue;
    const name = asStr(it.name) || "Untitled";
    if (Array.isArray(it.item)) {
      if (Array.isArray(it.event) && it.event.length) skipped.push(`${name}: folder scripts not supported`);
      out.push({ kind: "folder", name, request: null, children: mapItems(it.item, skipped, count) });
    } else {
      const req = asObj(it.request);
      if (!req) continue;
      if (Array.isArray(it.event) && it.event.length) skipped.push(`${name}: scripts/tests not supported`);
      const node = mapRequest(name, req, skipped);
      count.n += 1;
      out.push(node);
    }
  }
  return out;
}

/// Detects and parses a Postman Collection v2.1 or Environment export.
/// Returns null when the JSON is neither.
export function parsePostman(json: string): PostmanResult {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  const root = asObj(raw);
  if (!root) return null;

  const info = asObj(root.info);
  if (info && Array.isArray(root.item)) {
    const skipped: string[] = [];
    const count = { n: 0 };
    const nodes = mapItems(root.item, skipped, count);
    return { kind: "collection", name: asStr(info.name) || "Imported", nodes, requests: count.n, skipped };
  }

  if (Array.isArray(root.values) && typeof root.name === "string") {
    const vars: SomnusEnvVar[] = [];
    for (const v of root.values.map(asObj)) {
      if (!v || v.enabled === false) continue;
      const key = asStr(v.key).trim();
      if (!key) continue;
      vars.push({ key, value: asStr(v.value), secret: asStr(v.type) === "secret" });
    }
    return { kind: "environment", name: root.name, vars };
  }

  return null;
}
