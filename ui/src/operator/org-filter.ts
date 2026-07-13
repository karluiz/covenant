import type { Operator, Org } from "../api";

/** True when the operator points at an org we no longer know (deleted server-side). */
export function isStaleOrg(op: Operator, knownSlugs: Set<string>): boolean {
  return !!op.org_slug && !knownSlugs.has(op.org_slug);
}

/**
 * Bucket operators by active org. Personal (or no org) shows NULL-org operators
 * plus any whose org no longer exists, so nothing silently disappears.
 */
export function operatorsForOrg(ops: Operator[], org: Org | null, knownSlugs: Set<string>): Operator[] {
  if (!org || org.personal) return ops.filter((o) => !o.org_slug || isStaleOrg(o, knownSlugs));
  return ops.filter((o) => o.org_slug === org.slug);
}
