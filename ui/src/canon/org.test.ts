import { describe, it, expect } from "vitest";
import { resolveActiveOrg } from "./org";
import type { Org } from "../api";

function org(slug: string, personal = false): Org {
  return { id: slug.length, slug, name: slug, role: "owner", personal };
}

describe("resolveActiveOrg", () => {
  it("returns null when there are no orgs", () => {
    expect(resolveActiveOrg([], "acme")).toBeNull();
    expect(resolveActiveOrg([], null)).toBeNull();
  });

  it("prefers the saved slug when it matches a known org", () => {
    const orgs = [org("acme"), org("me", true), org("other")];
    expect(resolveActiveOrg(orgs, "other")).toBe(orgs[2]);
  });

  it("falls through to the personal org when the saved slug isn't in the list", () => {
    const orgs = [org("acme"), org("me", true)];
    expect(resolveActiveOrg(orgs, "ghost")).toBe(orgs[1]);
  });

  it("falls through to orgs[0] when there's no personal org and no saved match", () => {
    const orgs = [org("acme"), org("other")];
    expect(resolveActiveOrg(orgs, null)).toBe(orgs[0]);
    expect(resolveActiveOrg(orgs, "ghost")).toBe(orgs[0]);
  });
});
