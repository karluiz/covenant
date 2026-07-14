import type { Operator, Org } from "../api";

/**
 * True when the operator points at an org we no longer know (deleted
 * server-side). `knownSlugs === null` means the org list itself couldn't be
 * fetched (offline / backend down) — that's "unknown", not "deleted", so
 * nothing is flagged stale in that case.
 */
export function isStaleOrg(op: Operator, knownSlugs: Set<string> | null): boolean {
  if (knownSlugs === null) return false;
  return !!op.org_slug && !knownSlugs.has(op.org_slug);
}

/**
 * Bucket operators by active org. Personal (or no org) shows NULL-org operators
 * plus any whose org no longer exists, so nothing silently disappears.
 *
 * When `knownSlugs` is null (orgs fetch failed), we can't tell a deleted org
 * from a real one, so the personal/no-org view falls back to showing EVERY
 * operator — no badges, no rescue-on-save, nothing hidden or clobbered while
 * offline.
 */
export function operatorsForOrg(ops: Operator[], org: Org | null, knownSlugs: Set<string> | null): Operator[] {
  if (!org || org.personal) {
    if (knownSlugs === null) return ops;
    return ops.filter((o) => !o.org_slug || isStaleOrg(o, knownSlugs));
  }
  return ops.filter((o) => o.org_slug === org.slug);
}
