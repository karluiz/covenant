import type { Org } from "../api";

/** The org a group works against: its saved slug (if still a member),
 *  else the personal org, else the first org, else null. THE resolution
 *  order — keep it in one place. */
export function resolveActiveOrg(orgs: Org[], saved: string | null): Org | null {
  if (orgs.length === 0) return null;
  if (saved) {
    const hit = orgs.find((o) => o.slug === saved);
    if (hit) return hit;
  }
  return orgs.find((o) => o.personal) ?? orgs[0];
}
