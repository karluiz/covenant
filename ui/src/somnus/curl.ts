// curl-paste import for the Somnus composer. Parses method (-X), URL,
// headers (-H) and body (-d/--data*) out of a pasted curl command.
// Unsupported flags are ignored; flags known to take a value consume it
// so the value can't be mistaken for the URL.

export interface ParsedCurl {
  method: string;
  url: string;
  headers: [string, string][];
  body: string | null;
}

/// Flags (besides the ones we parse) that consume a following value.
const VALUE_FLAGS = new Set([
  "-o", "--output", "-A", "--user-agent", "-b", "--cookie", "-u", "--user",
  "-e", "--referer", "--connect-timeout", "--max-time", "-m",
  "-F", "--form", "--form-string", "--data-urlencode", "-w", "--write-out",
  "--cacert", "--cert", "--key", "-x", "--proxy", "-c", "--cookie-jar",
  "-T", "--upload-file", "--retry", "--limit-rate", "--resolve", "--interface",
]);

/// Whitespace tokenizer honoring single/double quotes and backslash escapes.
function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let sawQuote = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else cur += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\" && i + 1 < input.length) {
        cur += input[++i];
        continue;
      }
      if (ch === '"') quote = null;
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      sawQuote = true;
      continue;
    }
    if (ch === "\\" && i + 1 < input.length) {
      cur += input[++i];
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur || sawQuote) {
        tokens.push(cur);
        cur = "";
        sawQuote = false;
      }
      continue;
    }
    cur += ch;
  }
  if (cur || sawQuote) tokens.push(cur);
  return tokens;
}

export function parseCurl(text: string): ParsedCurl | null {
  const trimmed = text.trim();
  if (!/^curl\s/i.test(trimmed)) return null;
  // "\<newline>" line continuations are cosmetic — flatten them first.
  const tokens = tokenize(trimmed.replace(/\\\r?\n/g, " ")).slice(1);
  let method: string | null = null;
  const headers: [string, string][] = [];
  let body: string | null = null;
  const nonFlag: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "-X" || t === "--request") {
      method = tokens[++i]?.toUpperCase() ?? null;
      continue;
    }
    if (t === "-H" || t === "--header") {
      const h = tokens[++i] ?? "";
      const colon = h.indexOf(":");
      if (colon > 0) headers.push([h.slice(0, colon).trim(), h.slice(colon + 1).trim()]);
      continue;
    }
    if (t === "-d" || t === "--data" || t === "--data-raw" || t === "--data-binary") {
      body = tokens[++i] ?? null;
      continue;
    }
    // Attached short-flag forms: -XPOST, -H'A: b', -d'k=v' (no space).
    if (t.startsWith("-X") && !t.startsWith("--") && t.length > 2) {
      method = t.slice(2).toUpperCase();
      continue;
    }
    if (t.startsWith("-H") && !t.startsWith("--") && t.length > 2) {
      const h = t.slice(2);
      const colon = h.indexOf(":");
      if (colon > 0) headers.push([h.slice(0, colon).trim(), h.slice(colon + 1).trim()]);
      continue;
    }
    if (t.startsWith("-d") && !t.startsWith("--") && t.length > 2) {
      body = t.slice(2);
      continue;
    }
    if (VALUE_FLAGS.has(t)) {
      i++; // skip the flag's value
      continue;
    }
    if (t.startsWith("-")) continue; // bare flag we ignore
    nonFlag.push(t);
  }
  // Prefer the first explicit http(s) token; else first non-flag token
  // (curl accepts scheme-less URLs). Guards against an unlisted value-flag's
  // argument being mistaken for the URL.
  const url = nonFlag.find((t) => /^https?:\/\//i.test(t)) ?? nonFlag[0] ?? null;
  if (!url) return null;
  return {
    method: method ?? (body !== null ? "POST" : "GET"),
    url,
    headers,
    body,
  };
}
