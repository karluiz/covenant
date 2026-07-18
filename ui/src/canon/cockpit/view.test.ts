import { describe, it, expect, vi } from "vitest";
import { CanonCockpitView } from "./view";

// Mock the api module so tests don't invoke Tauri IPC.
vi.mock("../../api", () => ({
  canonOrgMembers: vi.fn().mockResolvedValue([]),
  canonAddMember: vi.fn().mockResolvedValue(undefined),
  canonRemoveMember: vi.fn().mockResolvedValue(undefined),
  canonCreateOrg: vi.fn().mockResolvedValue({}),
  canonMyOrgs: vi.fn().mockResolvedValue([]),
  canonLocalStatus: vi.fn().mockResolvedValue({ installed: [], agents: [], contexts: [], memory: [], commands: [], mcp: [], specs: [], detectedSkills: [] }),
  canonReadLocal: vi.fn().mockResolvedValue(""),
  canonPublish: vi.fn().mockResolvedValue(undefined),
  canonUninstallSkill: vi.fn(async () => undefined),
  canonSearch: vi.fn().mockResolvedValue([]),
  canonPreview: vi.fn().mockResolvedValue({ description: "", skill_md: "" }),
  canonInstallRegistry: vi.fn().mockResolvedValue(undefined),
  canonInstallRegistryUnit: vi.fn(async () => undefined),
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
  canonMyOrgs, canonSearch, canonInstallRegistryUnit, scoreSummaryFiltered, canonEvalSummary, canonLocalStatus,
  operatorList, marketplaceSearch, operatorCreateFromSoul, operatorSetOrg, canonPublish, canonUninstallSkill,
  type Operator, type MarketplaceListing,
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
  orgsFetched: true,
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
      orgsFetched: true,
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
      { id: 1, name: "kyc", version: "1.0.0", description: "", publisher_login: "karluiz", installs: 3, sha: "abc1234", kind: "skill" },
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

  it("renders all six registry kind tabs", async () => {
    const v = new CanonCockpitView(opts);
    v.open();
    v.showSection("registry");
    const tabs = [...v.element.querySelectorAll(".canon-reg-kind")].map((b) => b.textContent);
    expect(tabs).toEqual(["Skills", "Operators", "Subagents", "Commands", "Context", "MCP"]);
  });

  it("searches and installs a non-skill kind through canonInstallRegistryUnit", async () => {
    vi.mocked(canonSearch).mockResolvedValue([
      { id: 1, kind: "command", name: "deploy", version: "abc123def456", description: "d", publisher_login: "k", installs: 2, sha: "abc" },
    ]);
    const v = new CanonCockpitView(opts);
    v.open();
    v.showSection("registry");
    const commandsTab = [...v.element.querySelectorAll<HTMLButtonElement>(".canon-reg-kind")]
      .find((b) => b.textContent === "Commands")!;
    commandsTab.click();
    await vi.waitFor(() => {
      expect(canonSearch).toHaveBeenLastCalledWith(expect.any(String), null, "command");
    });
    await vi.waitFor(() => {
      expect(v.element.querySelector(".canon-search-result")).toBeTruthy();
    });
    // Non-skill cards hide the content-addressed version + sha chips.
    const card = v.element.querySelector(".canon-search-result")!;
    expect(card.textContent).not.toContain("abc123def456");
    expect(card.textContent).toContain("k");
    const install = v.element.querySelector<HTMLButtonElement>(".canon-search-result [aria-label='Install']")!;
    install.click();
    await vi.waitFor(() => {
      expect(canonInstallRegistryUnit).toHaveBeenCalledWith(
        expect.any(String), expect.any(String), "deploy", "abc123def456", "command",
      );
    });
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
  it("lists context files and invokes onNewContext via the section-head action (moved from the rail — see panel.test.ts)", async () => {
    vi.mocked(canonLocalStatus).mockResolvedValueOnce({ installed: [], agents: [], contexts: [{ name: "kyc-peru.md", summary: null }], memory: [], commands: [], mcp: [], specs: [], detectedSkills: [] });
    let called = false;
    const v = new CanonCockpitView({ ...opts, onNewContext: () => { called = true; } });
    v.open(); v.showSection("context");
    await vi.waitFor(() => {
      expect(v.element.textContent).toContain("kyc-peru.md");
    });
    const headBtn = v.element.querySelector<HTMLButtonElement>(".canon-sec-head-action")!;
    expect(headBtn.hidden).toBe(false);
    headBtn.click();
    expect(called).toBe(true);
  });

  it("context head action is hidden while empty; empty-state CTA is the single affordance", async () => {
    vi.mocked(canonLocalStatus).mockResolvedValueOnce({
      installed: [], agents: [], contexts: [], memory: [], commands: [], mcp: [], specs: [], detectedSkills: [],
    });
    const v = new CanonCockpitView({ ...opts, onNewContext: () => {} });
    v.open(); v.showSection("context");
    await vi.waitFor(() => {
      expect(v.element.querySelector(".rail-empty-btn")).toBeTruthy();
    });
    const headBtn = v.element.querySelector<HTMLButtonElement>(".canon-sec-head-action")!;
    expect(headBtn.hidden).toBe(true);
  });
});

describe("CanonCockpitView unit publish actions", () => {
  it("subagent rows publish to the registry with kind agent", async () => {
    vi.mocked(canonLocalStatus).mockResolvedValueOnce({
      installed: [], agents: [{ name: "reviewer" }], contexts: [], memory: [], commands: [], mcp: [], specs: [], detectedSkills: [],
    });
    const v = new CanonCockpitView(opts);
    v.open(); v.showSection("agents");
    await vi.waitFor(() => {
      expect(v.element.querySelector(".canon-skill-row [aria-label='Publish to registry']")).toBeTruthy();
    });
    const pub = v.element.querySelector<HTMLButtonElement>(".canon-skill-row [aria-label='Publish to registry']")!;
    pub.click();
    await vi.waitFor(() => {
      expect(canonPublish).toHaveBeenCalledWith(expect.any(String), expect.any(String), "reviewer", "agent");
    });
  });

  it("command rows publish to the registry with kind command", async () => {
    vi.mocked(canonLocalStatus).mockResolvedValueOnce({
      installed: [], agents: [], contexts: [], memory: [], commands: [{ name: "deploy", description: null }], mcp: [], specs: [], detectedSkills: [],
    });
    const v = new CanonCockpitView(opts);
    v.open(); v.showSection("commands");
    await vi.waitFor(() => {
      expect(v.element.querySelector(".canon-skill-row [aria-label='Publish to registry']")).toBeTruthy();
    });
    const pub = v.element.querySelector<HTMLButtonElement>(".canon-skill-row [aria-label='Publish to registry']")!;
    pub.click();
    await vi.waitFor(() => {
      expect(canonPublish).toHaveBeenCalledWith(expect.any(String), expect.any(String), "deploy", "command");
    });
  });

  it("mcp rows publish to the registry with kind mcp", async () => {
    vi.mocked(canonLocalStatus).mockResolvedValueOnce({
      installed: [], agents: [], contexts: [], memory: [], commands: [], mcp: [{ name: "figma", description: null, transport: "stdio" }], specs: [], detectedSkills: [],
    });
    const v = new CanonCockpitView(opts);
    v.open(); v.showSection("mcp");
    await vi.waitFor(() => {
      expect(v.element.querySelector(".canon-skill-row [aria-label='Publish to registry']")).toBeTruthy();
    });
    const pub = v.element.querySelector<HTMLButtonElement>(".canon-skill-row [aria-label='Publish to registry']")!;
    pub.click();
    await vi.waitFor(() => {
      expect(canonPublish).toHaveBeenCalledWith(expect.any(String), expect.any(String), "figma", "mcp");
    });
  });

  it("context rows render as skillCard rows with a publish action, kind context", async () => {
    vi.mocked(canonLocalStatus).mockResolvedValueOnce({
      installed: [], agents: [], contexts: [{ name: "kyc-peru.md", summary: null }], memory: [], commands: [], mcp: [], specs: [], detectedSkills: [],
    });
    const v = new CanonCockpitView(opts);
    v.open(); v.showSection("context");
    await vi.waitFor(() => {
      expect(v.element.querySelector(".canon-skill-row [aria-label='Publish to registry']")).toBeTruthy();
    });
    const pub = v.element.querySelector<HTMLButtonElement>(".canon-skill-row [aria-label='Publish to registry']")!;
    pub.click();
    await vi.waitFor(() => {
      expect(canonPublish).toHaveBeenCalledWith(expect.any(String), expect.any(String), "kyc-peru.md", "context");
    });
  });

  it("does not render a publish action when no org is active", async () => {
    vi.mocked(canonLocalStatus).mockResolvedValueOnce({
      installed: [], agents: [{ name: "reviewer" }], contexts: [], memory: [], commands: [], mcp: [], specs: [], detectedSkills: [],
    });
    const v = new CanonCockpitView({ ...opts, orgs: [], getActiveOrg: () => null });
    v.open(); v.showSection("agents");
    // Wait for the row to actually render before asserting the button's
    // absence — a bare microtask flush would pass even if gating broke.
    await vi.waitFor(() => {
      expect(v.element.querySelector(".canon-skill-row")).toBeTruthy();
    });
    expect(v.element.querySelector(".canon-skill-row [aria-label='Publish to registry']")).toBeNull();
  });
});

describe("CanonCockpitView Skills section trash button", () => {
  it("uninstalls a skill via the trash button after confirm", async () => {
    vi.mocked(canonLocalStatus).mockResolvedValueOnce({
      installed: [{ name: "kyc", version: "1.0.0", source: "local:x", sha: "a", signer: null, installedAt: "t" }],
      agents: [], contexts: [], memory: [], commands: [], mcp: [], specs: [], detectedSkills: [],
    });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const v = new CanonCockpitView(opts);
    v.open(); v.showSection("skills");
    await vi.waitFor(() => {
      expect(v.element.querySelector(".canon-skill-row [aria-label='Uninstall skill']")).toBeTruthy();
    });
    v.element.querySelector<HTMLButtonElement>(".canon-skill-row [aria-label='Uninstall skill']")!.click();
    await vi.waitFor(() => {
      expect(canonUninstallSkill).toHaveBeenCalledWith(expect.any(String), "kyc");
    });
    // Reload ran: the default (empty) canonLocalStatus re-render drops the row.
    await vi.waitFor(() => {
      expect(v.element.querySelector(".canon-skill-row [aria-label='Uninstall skill']")).toBeNull();
    });
    confirmSpy.mockRestore();
  });

  it("does not uninstall when confirm is declined", async () => {
    vi.mocked(canonLocalStatus).mockResolvedValueOnce({
      installed: [{ name: "kyc", version: "1.0.0", source: "local:x", sha: "a", signer: null, installedAt: "t" }],
      agents: [], contexts: [], memory: [], commands: [], mcp: [], specs: [], detectedSkills: [],
    });
    vi.mocked(canonUninstallSkill).mockClear();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const v = new CanonCockpitView(opts);
    v.open(); v.showSection("skills");
    await vi.waitFor(() => {
      expect(v.element.querySelector(".canon-skill-row [aria-label='Uninstall skill']")).toBeTruthy();
    });
    v.element.querySelector<HTMLButtonElement>(".canon-skill-row [aria-label='Uninstall skill']")!.click();
    await Promise.resolve();
    expect(canonUninstallSkill).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });
});

describe("CanonCockpitView module filter toolbar", () => {
  it("reveals the filter only when a section has rows, and filters live by substring", async () => {
    vi.mocked(canonLocalStatus).mockResolvedValueOnce({
      installed: [], agents: [{ name: "reviewer" }, { name: "planner" }],
      contexts: [], memory: [], commands: [], mcp: [], specs: [], detectedSkills: [],
    });
    const v = new CanonCockpitView(opts);
    v.open(); v.showSection("agents");
    await vi.waitFor(() => {
      expect(v.element.querySelectorAll(".canon-skill-row").length).toBe(2);
    });
    const bar = v.element.querySelector<HTMLElement>(".canon-filter-bar")!;
    expect(bar).toBeTruthy();
    expect(bar.hidden).toBe(false); // revealed once rows loaded

    const input = bar.querySelector<HTMLInputElement>(".canon-filter")!;
    input.value = "rev";
    input.dispatchEvent(new Event("input"));
    const rows = () => Array.from(v.element.querySelectorAll<HTMLElement>(".canon-skill-row"));
    expect(rows().filter((r) => !r.hidden).map((r) => r.textContent)).toEqual([expect.stringContaining("reviewer")]);

    input.value = "zzz";
    input.dispatchEvent(new Event("input"));
    expect(rows().every((r) => r.hidden)).toBe(true);
    expect(v.element.querySelector<HTMLElement>(".canon-filter-none")?.hidden).toBe(false);

    input.value = "";
    input.dispatchEvent(new Event("input"));
    expect(rows().every((r) => !r.hidden)).toBe(true);
    expect(v.element.querySelector<HTMLElement>(".canon-filter-none")?.hidden).toBe(true);
  });

  it("keeps the filter hidden when a section is empty", async () => {
    vi.mocked(canonLocalStatus).mockResolvedValueOnce({
      installed: [], agents: [], contexts: [], memory: [], commands: [], mcp: [], specs: [], detectedSkills: [],
    });
    const v = new CanonCockpitView(opts);
    v.open(); v.showSection("agents");
    await vi.waitFor(() => {
      expect(v.element.querySelector(".canon-cockpit-empty")).toBeTruthy();
    });
    expect(v.element.querySelector<HTMLElement>(".canon-filter-bar")?.hidden).toBe(true);
  });

  it("Skills: the header Add button toggles the skills.sh import row", async () => {
    vi.mocked(canonLocalStatus).mockResolvedValueOnce({
      installed: [{ name: "kyc", version: "1.0.0", source: "local:x", sha: "a", signer: null, installedAt: "t" }],
      agents: [], contexts: [], memory: [], commands: [], mcp: [], specs: [], detectedSkills: [],
    });
    const v = new CanonCockpitView(opts);
    v.open(); v.showSection("skills");
    await vi.waitFor(() => {
      expect(v.element.querySelector(".canon-import-bar")).toBeTruthy();
    });
    const importBar = v.element.querySelector<HTMLElement>(".canon-import-bar")!;
    expect(importBar.hidden).toBe(true); // starts closed
    const add = v.element.querySelector<HTMLButtonElement>(".canon-sec-head-action")!;
    add.click();
    expect(importBar.hidden).toBe(false);
    add.click();
    expect(importBar.hidden).toBe(true);
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

  it("orgsFetched:false (offline) shows every operator with no stale badge, even one pointed at an unknown org", async () => {
    const orgAssigned: Operator = { ...OPERATOR_FIXTURE, id: "op-2", name: "Ghost", org_slug: "deleted-org" };
    vi.mocked(operatorList).mockResolvedValueOnce([OPERATOR_FIXTURE, orgAssigned]);
    const v = new CanonCockpitView({ ...opts, orgsFetched: false });
    v.open();
    v.showSection("operators");
    await vi.waitFor(() => {
      expect(v.element.textContent).toContain("Zeta");
      expect(v.element.textContent).toContain("Ghost");
      // No STALE badge (the default badge may legitimately render).
      expect(v.element.querySelector(".op-card-badge.is-warn")).toBeFalsy();
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

describe("CanonCockpitView homologated empty states", () => {
  it("renders the shared No-project-folder block for every repo-gated section", () => {
    const v = new CanonCockpitView({ ...opts, groupRootDir: null });
    v.open();
    for (const key of ["agents", "commands", "mcp", "spec", "memory", "skills", "context"] as const) {
      v.showSection(key);
      expect(
        v.element.querySelector(".canon-cockpit-empty .rail-empty-title")?.textContent,
        `section ${key}`,
      ).toBe("No project folder");
    }
    v.close();
  });

  it("renders the shared empty block with a CTA that routes to the registry when no skills are installed", async () => {
    const v = new CanonCockpitView(opts); // canonLocalStatus mock: all lists empty
    v.open(); v.showSection("skills");
    await Promise.resolve(); await Promise.resolve();
    const empty = v.element.querySelector(".canon-cockpit-empty") as HTMLElement;
    expect(empty.textContent).toContain("No skills installed");
    (empty.querySelector(".rail-empty-btn") as HTMLButtonElement).click();
    expect(v.element.querySelector('[data-section="registry"].is-active')).toBeTruthy();
    v.close();
  });

  it("shows the Loop empty state when the group has no repo and no org", () => {
    const v = new CanonCockpitView({ ...opts, groupRootDir: null, orgs: [], getActiveOrg: () => null });
    v.open(); v.showSection("loop");
    expect(v.element.querySelector(".canon-cockpit-empty")?.textContent).toContain("Nothing to measure yet");
    v.close();
  });
});

describe("CanonCockpitView operators empty state", () => {
  it("renders the shared empty block with a New operator CTA when the org has none", async () => {
    vi.mocked(operatorList).mockResolvedValueOnce([]);
    const v = new CanonCockpitView(opts);
    v.open(); v.showSection("operators");
    await Promise.resolve(); await Promise.resolve();
    const empty = v.element.querySelector(".canon-cockpit-empty");
    expect(empty?.textContent).toContain("No operators in this org");
    expect(empty?.querySelector(".rail-empty-btn")?.textContent).toBe("New operator");
    v.close();
  });
});
