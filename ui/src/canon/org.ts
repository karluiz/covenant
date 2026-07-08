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

/** Derive a valid org slug from a display name: lowercase, [a-z0-9-] only,
 *  collapse runs of dashes, trim leading/trailing dashes, cap at 40. Mirrors
 *  the server's `valid_slug`. */
export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "").slice(0, 40);
}

/** Two-letter identity initials for an org (first letters of the first two
 *  words, else the first two characters). */
export function orgInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return (name.trim().slice(0, 2) || "??").toUpperCase();
}

/** Deterministic hue (0–359) from a slug so each org keeps a stable identity
 *  color across the chip, the menu, and the create surface. */
export function orgHue(slug: string): number {
  let h = 0;
  for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) % 360;
  return h;
}
