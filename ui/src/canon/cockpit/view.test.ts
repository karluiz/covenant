import { describe, it, expect, vi } from "vitest";
import { CanonCockpitView } from "./view";

// Mock the api module so tests don't invoke Tauri IPC.
vi.mock("../../api", () => ({
  canonOrgMembers: vi.fn().mockResolvedValue([]),
  canonAddMember: vi.fn().mockResolvedValue(undefined),
  canonRemoveMember: vi.fn().mockResolvedValue(undefined),
  canonCreateOrg: vi.fn().mockResolvedValue({}),
}));

const opts = {
  groupId: "g1", groupLabel: "G1", groupRootDir: "/x",
  orgs: [{ id: 1, slug: "karluiz", name: "karluiz", role: "owner", personal: true }],
  getActiveOrg: () => "karluiz", setActiveOrg: vi.fn(),
};

describe("CanonCockpitView shell", () => {
  it("opens with the org section active and switches sections", () => {
    const v = new CanonCockpitView(opts);
    v.open();
    expect(v.element.querySelector(".canon-cockpit-nav")).toBeTruthy();
    expect(v.element.querySelector('[data-section="org"].is-active')).toBeTruthy();
    v.showSection("members");
    expect(v.element.querySelector('[data-section="members"].is-active')).toBeTruthy();
    v.close();
    expect(document.querySelector(".canon-cockpit")).toBeNull();
  });
});

describe("CanonCockpitView Members section", () => {
  it("gates member add/remove on owner role", async () => {
    const memberOpts = { ...opts,
      orgs: [{ id: 1, slug: "cleverit", name: "Cleverit", role: "member", personal: false }],
      getActiveOrg: () => "cleverit" };
    const v = new CanonCockpitView(memberOpts);
    v.open(); v.showSection("members");
    expect(v.element.querySelector(".canon-cockpit-add-member")).toBeNull(); // member: no add UI
    const ownerV = new CanonCockpitView(opts); // opts active org is owner
    ownerV.open(); ownerV.showSection("members");
    expect(ownerV.element.querySelector(".canon-cockpit-add-member")).toBeTruthy();
  });
});
