import { describe, expect, it } from "vitest";
import { operatorsForOrg, isStaleOrg } from "./org-filter";
import type { Operator, Org } from "../api";

const op = (name: string, org_slug: string | null): Operator =>
  ({ name, org_slug } as unknown as Operator); // test double: only the filtered fields matter

const acme: Org = { id: 1, slug: "acme", name: "Acme", role: "owner", personal: false };
const personal: Org = { id: 2, slug: "me", name: "Me", role: "owner", personal: true };

describe("operatorsForOrg", () => {
  const ops = [op("a", null), op("b", "acme"), op("c", "ghost-org")];
  const known = new Set(["acme", "me"]);

  it("personal bucket = null org_slug plus stale slugs", () => {
    expect(operatorsForOrg(ops, personal, known).map((o) => o.name)).toEqual(["a", "c"]);
    expect(operatorsForOrg(ops, null, known).map((o) => o.name)).toEqual(["a", "c"]);
  });

  it("non-personal org filters by slug", () => {
    expect(operatorsForOrg(ops, acme, known).map((o) => o.name)).toEqual(["b"]);
  });

  it("isStaleOrg flags unknown slugs only", () => {
    expect(isStaleOrg(op("c", "ghost-org"), known)).toBe(true);
    expect(isStaleOrg(op("a", null), known)).toBe(false);
    expect(isStaleOrg(op("b", "acme"), known)).toBe(false);
  });

  it("isStaleOrg never flags when the org list is unavailable (null)", () => {
    expect(isStaleOrg(op("c", "ghost-org"), null)).toBe(false);
    expect(isStaleOrg(op("b", "acme"), null)).toBe(false);
    expect(isStaleOrg(op("a", null), null)).toBe(false);
  });

  it("personal bucket shows every operator when the org list is unavailable (null) — offline behaves as personal", () => {
    expect(operatorsForOrg(ops, personal, null).map((o) => o.name)).toEqual(["a", "b", "c"]);
    expect(operatorsForOrg(ops, null, null).map((o) => o.name)).toEqual(["a", "b", "c"]);
  });
});
