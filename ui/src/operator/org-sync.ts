import { operatorOrgPull } from "../api";

const lastPull = new Map<string, number>();
const THROTTLE_MS = 60_000;

/**
 * Pull the org's operator roster, throttled to once a minute per org.
 * Resolves true when a sync actually changed something locally (rows were
 * pulled), so callers can re-render. Offline/backend-down resolves false —
 * the local cache stands, per the org-roster spec.
 */
export async function pullOrgOperators(slug: string | null | undefined): Promise<boolean> {
  if (!slug) return false;
  const now = Date.now();
  if ((lastPull.get(slug) ?? 0) > now - THROTTLE_MS) return false;
  lastPull.set(slug, now);
  try {
    const s = await operatorOrgPull(slug);
    return s.pulled > 0;
  } catch {
    lastPull.delete(slug);
    return false;
  }
}
