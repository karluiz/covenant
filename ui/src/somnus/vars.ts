import type { SomnusEnvVar } from "../api";

/// {{var_name}} — letters/digits/underscore start, then . and - allowed.
/// Postman-compatible enough for real collections.
const VAR_RE = /\{\{\s*([A-Za-z0-9_][A-Za-z0-9_.-]*)\s*\}\}/g;

/// Single-pass substitution. A value that itself contains {{refs}} is NOT
/// re-resolved. ponytail: no recursion — add a bounded loop if nested
/// variables ever matter.
export function resolveVars(text: string, vars: ReadonlyMap<string, string>): string {
  return text.replace(VAR_RE, (whole, name: string) => vars.get(name) ?? whole);
}

/// Unique missing variable names, in first-appearance order.
export function findUnresolved(text: string, vars: ReadonlyMap<string, string>): string[] {
  const missing: string[] = [];
  for (const m of text.matchAll(VAR_RE)) {
    const name = m[1];
    if (!vars.has(name) && !missing.includes(name)) missing.push(name);
  }
  return missing;
}

/// Parse a SomnusEnvironment.vars JSON blob into a lookup map.
export function envVarsToMap(json: string): Map<string, string> {
  const out = new Map<string, string>();
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return out;
    for (const v of parsed as SomnusEnvVar[]) {
      if (typeof v?.key === "string" && v.key.trim() && typeof v.value === "string") {
        out.set(v.key.trim(), v.value);
      }
    }
  } catch {
    // garbage in the DB → behave as "no variables"
  }
  return out;
}
