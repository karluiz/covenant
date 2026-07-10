import { describe, it, expect, vi } from "vitest";
import { CanonCockpitView } from "./view";

// Mock the api module so tests don't invoke Tauri IPC.
vi.mock("../../api", () => ({
  canonOrgMembers: vi.fn().mockResolvedValue([]),
  canonAddMember: vi.fn().mockResolvedValue(undefined),
  canonRemoveMember: vi.fn().mockResolvedValue(undefined),
  canonCreateOrg: vi.fn().mockResolvedValue({}),
  canonMyOrgs: vi.fn().mockResolvedValue([]),
  canonLocalStatus: vi.fn().mockResolvedValue({ installed: [], agents: [], contexts: [], memory: [], commands: [], mcp: [], specs: [] }),
  canonReadLocal: vi.fn().mockResolvedValue(""),
  canonPublish: vi.fn().mockResolvedValue(undefined),
  canonSearch: vi.fn().mockResolvedValue([]),
  canonPreview: vi.fn().mockResolvedValue({ description: "", skill_md: "" }),
  canonInstallRegistry: vi.fn().mockResolvedValue(undefined),
  scoreSummaryFiltered: vi.fn().mockResolvedValue({ total_tokens: 0, total_prompts: 0, total_specs: 0, total_commits: 0 }),
  canonEvalSummary: vi.fn().mockResolvedValue([]),
}));

// The cockpit's "Create organization" button opens the immersive create
// surface; mock it so we can capture and drive its onCreated callback.
vi.mock("../create-org/view", () => ({ openCreateOrgExperience: vi.fn() }));

import { canonMyOrgs, canonSearch, scoreSummaryFiltered, canonEvalSummary, canonLocalStatus } from "../../api";
import { openCreateOrgExperience } from "../create-org/view";

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

describe("CanonCockpitView create-org flow", () => {
  it("opens the create surface, then refreshes the org list so the new org becomes active", async () => {
    vi.mocked(openCreateOrgExperience).mockClear();
    vi.mocked(canonMyOrgs).mockResolvedValue([
      { id: 1, slug: "karluiz", name: "karluiz", role: "owner", personal: true },
      { id: 2, slug: "neworg", name: "New Org", role: "owner", personal: false },
    ]);
    const setActiveOrg = vi.fn();
    let active: string | null = "karluiz";
    const createOpts = {
      groupId: "g1", groupLabel: "G1", groupRootDir: "/x",
      orgs: [{ id: 1, slug: "karluiz", name: "karluiz", role: "owner", personal: true }],
      getActiveOrg: () => active,
      setActiveOrg: (slug: string | null) => { active = slug; setActiveOrg(slug); },
    };
    const v = new CanonCockpitView(createOpts);
    v.open();

    const wrap = v.element.querySelector(".canon-cockpit-org-create") as HTMLElement;
    (wrap.querySelector("button") as HTMLButtonElement).click();

    // The button opens the immersive create surface (not an inline form).
    expect(openCreateOrgExperience).toHaveBeenCalledTimes(1);
    const onCreated = vi.mocked(openCreateOrgExperience).mock.calls[0][0].onCreated;

    // Simulate a successful create — the cockpit refetches, switches active.
    onCreated("neworg");
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(setActiveOrg).toHaveBeenCalledWith("neworg");
    expect(v.element.textContent).toContain("neworg");
  });
});

describe("CanonCockpitView Registry section", () => {
  it("renders registry search results for the active org", async () => {
    vi.mocked(canonSearch).mockResolvedValue([
      { id: 1, name: "kyc", version: "1.0.0", description: "", publisher_login: "karluiz", installs: 3, sha: "abc1234" },
    ]);
    const v = new CanonCockpitView(opts);
    v.open(); v.showSection("registry");
    const input = v.element.querySelector(".canon-cockpit-search-input") as HTMLInputElement;
    const go = v.element.querySelector(".canon-cockpit-search-go") as HTMLButtonElement;
    input.value = "kyc"; go.click();
    await Promise.resolve(); await Promise.resolve();
    expect(v.element.textContent).toContain("kyc");
  });
});

describe("CanonCockpitView Context section", () => {
  it("lists context files and invokes onNewContext (moved from the rail — see panel.test.ts)", async () => {
    vi.mocked(canonLocalStatus).mockResolvedValueOnce({ installed: [], agents: [], contexts: [{ name: "kyc-peru.md", summary: null }], memory: [], commands: [], mcp: [], specs: [] });
    let called = false;
    const v = new CanonCockpitView({ ...opts, onNewContext: () => { called = true; } });
    v.open(); v.showSection("context");
    await Promise.resolve(); await Promise.resolve();
    expect(v.element.textContent).toContain("kyc-peru.md");
    (v.element.querySelector(".canon-new-context-btn") as HTMLButtonElement).click();
    expect(called).toBe(true);
  });
});

describe("CanonCockpitView Loop section", () => {
  it("renders inference stats in the Loop section", async () => {
    vi.mocked(scoreSummaryFiltered).mockResolvedValueOnce({
      total_tokens: 1500, total_prompts: 10, total_specs: 2, total_commits: 4,
    });
    const v = new CanonCockpitView(opts);
    v.open(); v.showSection("loop");
    await Promise.resolve(); await Promise.resolve();
    expect(v.element.textContent).toContain("1.5k"); // fmtTokens
  });

  it("renders eval pass-rate in the Loop section (moved from the rail — see panel.test.ts)", async () => {
    vi.mocked(canonEvalSummary).mockResolvedValueOnce([{ skill: "kyc-peru", passed: 4, total: 5, baseline_passed: 2, baseline_total: 5 }]);
    const v = new CanonCockpitView(opts);
    v.open(); v.showSection("loop");
    await Promise.resolve(); await Promise.resolve();
    expect(v.element.textContent).toContain("80%");
  });
});
