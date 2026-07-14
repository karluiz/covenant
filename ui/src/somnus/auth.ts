import type { SomnusAuth } from "../api";

export type CompiledAuth = { headers: [string, string][]; query: [string, string][] };

function hasHeader(headers: [string, string][], name: string): boolean {
  const n = name.toLowerCase();
  return headers.some(([k]) => k.trim().toLowerCase() === n);
}

/// Compile the Auth tab into concrete headers / query params.
/// An explicit header typed in the Headers tab always wins (spec §3).
export function compileAuth(auth: SomnusAuth, existingHeaders: [string, string][]): CompiledAuth {
  const out: CompiledAuth = { headers: [], query: [] };
  switch (auth.type) {
    case "none":
      break;
    case "bearer":
      if (auth.token && !hasHeader(existingHeaders, "Authorization")) {
        out.headers.push(["Authorization", `Bearer ${auth.token}`]);
      }
      break;
    case "basic":
      if ((auth.username || auth.password) && !hasHeader(existingHeaders, "Authorization")) {
        out.headers.push(["Authorization", `Basic ${btoa(`${auth.username}:${auth.password}`)}`]);
      }
      break;
    case "apikey":
      if (!auth.key) break;
      if (auth.placement === "header") {
        if (!hasHeader(existingHeaders, auth.key)) out.headers.push([auth.key, auth.value]);
      } else {
        out.query.push([auth.key, auth.value]);
      }
      break;
  }
  return out;
}
