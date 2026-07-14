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
  operatorList: vi.fn(async () => [] as unknown[]),
  operatorDelete: vi.fn().mockResolvedValue(undefined),
  operatorSetOrg: vi.fn().mockResolvedValue(undefined),
  operatorCreateFromSoul: vi.fn(async () => ({ id: "op-installed", name: "Zeta Installed" }) as unknown),
  marketplacePublish: vi.fn().mockResolvedValue(undefined),
  marketplaceSearch: vi.fn(async () => [] as unknown[]),
  marketplaceInstallCount: vi.fn().mockResolvedValue(undefined),
}));

// The cockpit's "Create organization" button opens the immersive create
// surface; mock it so we can capture and drive its onCreated callback.
vi.mock("../create-org/view", () => ({ openCreateOrgExperience: vi.fn() }));

import {
  canonMyOrgs, canonSearch, scoreSummaryFiltered, canonEvalSummary, canonLocalStatus,
  operatorList, marketplaceSearch, operatorCreateFromSoul, operatorSetOrg, type Operator,
  type MarketplaceListing,
} from "../../api";
import { openCreateOrgExperience } from "../create-org/view";

const OPERATOR_FIXTURE: Operator = {
  id: "op-1", name: "Zeta", emoji: "🟣", color: "#a855f7", tags: ["rust"],
  persona: "", escalate_threshold: 0.5, model: "claude-sonnet-4-6", hard_constraints: "",
  voice: "Terse", is_default: true, created_at_unix_ms: 0, updated_at_unix_ms: 0, xp: 0,
  github_access: "Off", acp_enabled: false, perception_enabled: false, org_slug: null,
};

const LISTING_FIXTURE: MarketplaceListing = {
  id: "listing-1", name: "Zeta", emoji: "🟣", color: "#a855f7", tags: ["rust"],
  tagline: "Rust reviewer", author_login: "someone", installs: 4, soul_md: "---\nname: Zeta\n---\nbody",
};

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

  it("shows the id-card rename pencil only to owners and opens the surface in rename mode", () => {
    vi.mocked(openCreateOrgExperience).mockClear();
    const memberV = new CanonCockpitView({ ...opts,
      orgs: [{ id: 1, slug: "cleverit", name: "Cleverit", role: "member", personal: false }],
      getActiveOrg: () => "cleverit" });
    memberV.open();
    expect(memberV.element.querySelector(".canon-cockpit-idcard-edit")).toBeNull();
    memberV.close();

    const v = new CanonCockpitView(opts); // active org role: owner
    v.open();
    const edit = v.element.querySelector(".canon-cockpit-idcard-edit") as HTMLElement;
    expect(edit).toBeTruthy();
    edit.click();
    expect(openCreateOrgExperience).toHaveBeenCalledWith(
      expect.objectContaining({ rename: { slug: "karluiz", name: "karluiz" } }),
    );
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

  it("registry toggle switches to operators and renders marketplace results", async () => {
    vi.mocked(marketplaceSearch).mockResolvedValue([LISTING_FIXTURE]);
    const v = new CanonCockpitView(opts);
    v.open();
    v.showSection("registry");
    const toggle = [...v.element.querySelectorAll(".canon-reg-kind")].find((b) => b.textContent === "Operators")!;
    (toggle as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(v.element.textContent).toContain("Zeta");
    });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
  });

  it("installs an operator into the active non-personal org", async () => {
    vi.mocked(marketplaceSearch).mockResolvedValue([LISTING_FIXTURE]);
    vi.mocked(operatorList).mockResolvedValue([]);
    vi.mocked(operatorCreateFromSoul).mockResolvedValue({ id: "op-new", name: "Zeta" } as Operator);
    const orgOpts = { ...opts, orgs: [{ id: 2, slug: "cleverit", name: "Cleverit", role: "owner", personal: false }], getActiveOrg: () => "cleverit" };
    const v = new CanonCockpitView(orgOpts);
    v.open();
    v.showSection("registry");
    const toggle = [...v.element.querySelectorAll(".canon-reg-kind")].find((b) => b.textContent === "Operators")!;
    (toggle as HTMLButtonElement).click();
    await vi.waitFor(() => expect(v.element.textContent).toContain("Zeta"));
    const install = v.element.querySelector(".canon-search-result [aria-label='Install']") as HTMLButtonElement;
    install.click();
    await vi.waitFor(() => {
      expect(operatorCreateFromSoul).toHaveBeenCalled();
      expect(operatorSetOrg).toHaveBeenCalledWith("op-new", "cleverit");
    });
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

describe("CanonCockpitView Operators section", () => {
  it("operators section renders the org-filtered roster with a New operator button", async () => {
    vi.mocked(operatorList).mockResolvedValueOnce([OPERATOR_FIXTURE]);
    const v = new CanonCockpitView(opts);
    v.open();
    v.showSection("operators");
    await vi.waitFor(() => {
      expect(v.element.querySelector(".op-card-grid")).toBeTruthy();
      expect(v.element.textContent).toContain("Zeta");
      expect(v.element.querySelector("[data-role='op-new']")).toBeTruthy();
    });
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
