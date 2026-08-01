import { afterEach, describe, it, expect, vi } from "vitest";
import { CanonCockpitView, unusedUnits, inventoryRows, skillCurrency, evalChip } from "./view";

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
  canonOrgDefaults: vi.fn(async () => [] as unknown[]),
  canonOrgDefaultSet: vi.fn().mockResolvedValue(undefined),
  canonOrgDefaultUnset: vi.fn().mockResolvedValue(undefined),
  canonUnitInstalled: vi.fn(async () => false),
  canonUninstallSkill: vi.fn(async () => undefined),
  canonNewUnit: vi.fn(async () => "/x/.covenant/canon/agents/reviewer.md"),
  canonImportSkill: vi.fn(async () => [] as string[]),
  canonAdopt: vi.fn(async () => undefined),
  canonProjectionStatus: vi.fn(async () => ({ executors: [], source_edited_unix: null })),
  canonExport: vi.fn(async () => undefined),
  canonRunEvals: vi.fn(async () => undefined),
  onCanonEvalProgress: vi.fn(async () => () => {}),
  canonUnitPath: vi.fn(async () => "/x/.covenant/canon/agents/reviewer.md"),
  canonDeleteUnit: vi.fn(async () => undefined),
  canonReadSource: vi.fn(async () => ""),
  canonSearch: vi.fn().mockResolvedValue([]),
  canonPreview: vi.fn().mockResolvedValue({ description: "", skill_md: "" }),
  canonInstallRegistry: vi.fn().mockResolvedValue(undefined),
  canonInstallRegistryUnit: vi.fn(async () => undefined),
  scoreSummaryFiltered: vi.fn().mockResolvedValue({ total_tokens: 0, total_prompts: 0, total_specs: 0, total_commits: 0 }),
  scoreSkillUsage: vi.fn().mockResolvedValue([]),
  canonEvalSummary: vi.fn().mockResolvedValue([]),
  operatorList: vi.fn(async () => [] as unknown[]),
  operatorDelete: vi.fn().mockResolvedValue(undefined),
  operatorSetOrg: vi.fn().mockResolvedValue(undefined),
  operatorCreateFromSoul: vi.fn(async () => ({ id: "op-installed", name: "Zeta Installed" }) as unknown),
}));

// The cockpit's "Create organization" button opens the immersive create
// surface; mock it so we can capture and drive its onCreated callback.
vi.mock("../create-org/view", () => ({ openCreateOrgExperience: vi.fn() }));

import {
  canonMyOrgs, canonSearch, canonInstallRegistryUnit, scoreSummaryFiltered, canonEvalSummary, canonLocalStatus,
  operatorList, canonPublish, canonUninstallSkill,
  canonOrgDefaults, canonOrgDefaultSet, canonUnitInstalled,
  canonNewUnit, canonImportSkill, canonUnitPath, canonDeleteUnit, scoreSkillUsage,
  canonProjectionStatus, canonExport, canonRunEvals,
  type Operator, type PkgMeta,
} from "../../api";
import { openCreateOrgExperience } from "../create-org/view";

const OPERATOR_FIXTURE: Operator = {
  id: "op-1", name: "Zeta", emoji: "🟣", color: "#a855f7", tags: ["rust"],
  persona: "", escalate_threshold: 0.5, model: "claude-sonnet-4-6", hard_constraints: "",
  voice: "Terse", is_default: true, created_at_unix_ms: 0, updated_at_unix_ms: 0, xp: 0,
  github_access: "Off", acp_enabled: false, perception_enabled: false,
  supervision_enabled: false, org_slug: null,
};


// Tests open cockpits without closing them; a leftover root keeps answering
// document-level keys (⌘K), so tear the DOM down between them.
afterEach(() => {
  document.body.replaceChildren();
});

const opts = {
  groupId: "g1", groupLabel: "G1", groupRootDir: "/x",
  orgs: [{ id: 1, slug: "karluiz", name: "karluiz", role: "owner", personal: true }],
  orgsFetched: true,
  getActiveOrg: () => "karluiz", setActiveOrg: vi.fn(),
};

describe("CanonCockpitView shell", () => {
  it("opens on Overview — the state of the repo, not the org settings screen", () => {
    const v = new CanonCockpitView(opts);
    v.open();
    expect(v.element.querySelector(".canon-cockpit-nav")).toBeTruthy();
    expect(v.element.querySelector('[data-section="overview"].is-active')).toBeTruthy();
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
    v.open(); v.showSection("org");

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
    memberV.open(); memberV.showSection("org");
    expect(memberV.element.querySelector(".canon-cockpit-idcard-edit")).toBeNull();
    memberV.close();

    const v = new CanonCockpitView(opts); // active org role: owner
    v.open(); v.showSection("org");
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
      { id: 1, name: "kyc", version: "1.0.0", description: "", publisher_login: "karluiz", installs: 3, sha: "abc1234", kind: "skill", eval_passed: 0, eval_total: 0 },
    ]);
    const v = new CanonCockpitView(opts);
    v.open(); v.showSection("registry");
    const input = v.element.querySelector(".canon-cockpit-search-input") as HTMLInputElement;
    const go = v.element.querySelector(".canon-cockpit-search-go") as HTMLButtonElement;
    input.value = "kyc"; go.click();
    await Promise.resolve(); await Promise.resolve();
    expect(v.element.textContent).toContain("kyc");
  });

  it("renders all five registry kind tabs", async () => {
    const v = new CanonCockpitView(opts);
    v.open();
    v.showSection("registry");
    const tabs = [...v.element.querySelectorAll(".canon-reg-kind")].map((b) => b.textContent);
    expect(tabs).toEqual(["Skills", "Subagents", "Commands", "Context", "MCP"]);
  });

  it("searches and installs a non-skill kind through canonInstallRegistryUnit", async () => {
    vi.mocked(canonSearch).mockResolvedValue([
      { id: 1, kind: "command", name: "deploy", version: "abc123def456", description: "d", publisher_login: "k", installs: 2, sha: "abc", eval_passed: 0, eval_total: 0 },
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
});

describe("CanonCockpitView org defaults", () => {
  it("org section lists defaults with install action for missing ones", async () => {
    vi.mocked(canonOrgDefaults).mockResolvedValue([
      { kind: "skill", name: "conventions" },
      { kind: "mcp", name: "jira" },
    ]);
    vi.mocked(canonUnitInstalled).mockImplementation(async (_cwd, _kind, name) => name === "conventions");
    const v = new CanonCockpitView(opts);
    v.open();
    v.showSection("org");
    await vi.waitFor(() => {
      expect(v.element.textContent).toContain("Org defaults");
      expect(v.element.textContent).toContain("conventions");
      expect(v.element.textContent).toContain("jira");
    });
    // conventions is installed (no install button); jira is missing (button).
    const installs = [...v.element.querySelectorAll('[aria-label="Install into this repo"]')];
    expect(installs.length).toBe(1);
  });

  it("registry cards show the org-default pin only to owners", async () => {
    vi.mocked(canonSearch).mockResolvedValue([
      { id: 1, kind: "skill", name: "conventions", version: "1", description: "", publisher_login: "k", installs: 0, sha: "abc", eval_passed: 0, eval_total: 0 },
    ]);
    const v = new CanonCockpitView(opts); // opts org role: owner
    v.open();
    v.showSection("registry");
    const go = v.element.querySelector(".canon-cockpit-search-go") as HTMLButtonElement;
    go.click();
    await vi.waitFor(() => expect(v.element.querySelector(".canon-search-result")).toBeTruthy());
    expect(v.element.querySelector(".canon-default-pin")).toBeTruthy();

    const memberOpts = { ...opts,
      orgs: [{ id: 2, slug: "cleverit", name: "Cleverit", role: "member", personal: false }],
      getActiveOrg: () => "cleverit" };
    const m = new CanonCockpitView(memberOpts);
    m.open();
    m.showSection("registry");
    const mgo = m.element.querySelector(".canon-cockpit-search-go") as HTMLButtonElement;
    mgo.click();
    await vi.waitFor(() => expect(m.element.querySelector(".canon-search-result")).toBeTruthy());
    expect(m.element.querySelector(".canon-default-pin")).toBeNull();
  });

  it("pinning calls canonOrgDefaultSet with the card's kind and name", async () => {
    vi.mocked(canonOrgDefaults).mockResolvedValue([]);
    vi.mocked(canonSearch).mockResolvedValue([
      { id: 1, kind: "skill", name: "conventions", version: "1", description: "", publisher_login: "k", installs: 0, sha: "abc", eval_passed: 0, eval_total: 0 },
    ]);
    const v = new CanonCockpitView(opts);
    v.open();
    v.showSection("registry");
    (v.element.querySelector(".canon-cockpit-search-go") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(v.element.querySelector(".canon-default-pin")).toBeTruthy());
    (v.element.querySelector(".canon-default-pin") as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(canonOrgDefaultSet).toHaveBeenCalledWith("karluiz", "skill", "conventions");
    });
  });
});

describe("CanonCockpitView Operators section gating", () => {
  it("renders the org roster read-only for plain members (no edit/delete, duplicate stays)", async () => {
    vi.mocked(operatorList).mockResolvedValue([
      { ...OPERATOR_FIXTURE, org_slug: "cleverit", is_default: false },
    ]);
    const memberOpts = { ...opts,
      orgs: [{ id: 2, slug: "cleverit", name: "Cleverit", role: "member", personal: false }],
      getActiveOrg: () => "cleverit" };
    const v = new CanonCockpitView(memberOpts);
    v.open();
    v.showSection("operators");
    await vi.waitFor(() => {
      expect(v.element.querySelector(".op-card-grid")).toBeTruthy();
    });
    const labels = [...v.element.querySelectorAll(".op-card-grid button")]
      .map((b) => b.getAttribute("aria-label"));
    expect(labels).not.toContain("Edit");
    expect(labels).not.toContain("Delete");
    expect(labels).toContain("Duplicate");
  });

  it("keeps edit/delete for the org owner", async () => {
    vi.mocked(operatorList).mockResolvedValue([
      { ...OPERATOR_FIXTURE, org_slug: "cleverit", is_default: false },
    ]);
    const ownerOpts = { ...opts,
      orgs: [{ id: 2, slug: "cleverit", name: "Cleverit", role: "owner", personal: false }],
      getActiveOrg: () => "cleverit" };
    const v = new CanonCockpitView(ownerOpts);
    v.open();
    v.showSection("operators");
    await vi.waitFor(() => {
      expect(v.element.querySelector(".op-card-grid")).toBeTruthy();
    });
    const labels = [...v.element.querySelectorAll(".op-card-grid button")]
      .map((b) => b.getAttribute("aria-label"));
    expect(labels).toContain("Edit");
    expect(labels).toContain("Delete");
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
    const v = new CanonCockpitView(opts);
    v.open(); v.showSection("skills");
    await vi.waitFor(() => {
      expect(v.element.querySelector(".canon-skill-row [aria-label='Uninstall skill']")).toBeTruthy();
    });
    v.element.querySelector<HTMLButtonElement>(".canon-skill-row [aria-label='Uninstall skill']")!.click();
    // The in-app confirm card, not window.confirm — Tauri's capability set
    // doesn't allow native dialogs (see workspaces/confirm-prompt.ts).
    document.querySelector<HTMLButtonElement>(".workspace-confirm-confirm")!.click();
    await vi.waitFor(() => {
      expect(canonUninstallSkill).toHaveBeenCalledWith(expect.any(String), "kyc");
    });
    // Reload ran: the default (empty) canonLocalStatus re-render drops the row.
    await vi.waitFor(() => {
      expect(v.element.querySelector(".canon-skill-row [aria-label='Uninstall skill']")).toBeNull();
    });
  });

  it("does not uninstall when confirm is declined", async () => {
    vi.mocked(canonLocalStatus).mockResolvedValueOnce({
      installed: [{ name: "kyc", version: "1.0.0", source: "local:x", sha: "a", signer: null, installedAt: "t" }],
      agents: [], contexts: [], memory: [], commands: [], mcp: [], specs: [], detectedSkills: [],
    });
    vi.mocked(canonUninstallSkill).mockClear();
    const v = new CanonCockpitView(opts);
    v.open(); v.showSection("skills");
    await vi.waitFor(() => {
      expect(v.element.querySelector(".canon-skill-row [aria-label='Uninstall skill']")).toBeTruthy();
    });
    v.element.querySelector<HTMLButtonElement>(".canon-skill-row [aria-label='Uninstall skill']")!.click();
    document.querySelector<HTMLButtonElement>(".workspace-confirm-cancel")!.click();
    await Promise.resolve();
    expect(canonUninstallSkill).not.toHaveBeenCalled();
    expect(document.querySelector(".workspace-confirm-overlay")).toBeNull();
  });
});

describe("CanonCockpitView shared repo status", () => {
  it("walks the repo once per open, and again only after a write", async () => {
    const withSkill = {
      installed: [{ name: "kyc", version: "1.0.0", source: "local:x", sha: "a", signer: null, installedAt: "t" }],
      agents: [], contexts: [], memory: [], commands: [], mcp: [], specs: [], detectedSkills: [],
    };
    vi.mocked(canonLocalStatus).mockClear();
    vi.mocked(canonLocalStatus).mockResolvedValueOnce(withSkill).mockResolvedValueOnce(withSkill);

    const v = new CanonCockpitView(opts);
    v.open(); v.showSection("skills");
    await vi.waitFor(() => {
      expect(v.element.querySelector(".canon-skill-row")).toBeTruthy();
    });
    // A second section reads the same snapshot instead of re-walking the repo.
    v.showSection("agents");
    await vi.waitFor(() => {
      expect(v.element.querySelector(".canon-cockpit-empty")).toBeTruthy();
    });
    v.showSection("skills");
    await vi.waitFor(() => {
      expect(v.element.querySelector(".canon-skill-row")).toBeTruthy();
    });
    expect(canonLocalStatus).toHaveBeenCalledTimes(1);

    // A write invalidates it — the redraw must not come from the stale snapshot.
    v.element.querySelector<HTMLButtonElement>(".canon-skill-row [aria-label='Uninstall skill']")!.click();
    document.querySelector<HTMLButtonElement>(".workspace-confirm-confirm")!.click();
    await vi.waitFor(() => {
      expect(canonLocalStatus).toHaveBeenCalledTimes(2);
    });
  });
});

describe("CanonCockpitView unit row verbs", () => {
  const withAgent = (detectedIn: string | null) => ({
    installed: [], agents: [{ name: "reviewer", detectedIn }], contexts: [], memory: [],
    commands: [], mcp: [], specs: [], detectedSkills: [],
  });
  const labels = (v: CanonCockpitView): (string | null)[] =>
    [...v.element.querySelectorAll(".canon-skill-row button")].map((b) => b.getAttribute("aria-label"));

  it("adopted rows carry Open · Publish · Delete", async () => {
    vi.mocked(canonLocalStatus).mockResolvedValueOnce(withAgent(null));
    const opened: string[] = [];
    const v = new CanonCockpitView({ ...opts, onOpenFile: (p) => opened.push(p) });
    v.open(); v.showSection("agents");
    await vi.waitFor(() => {
      expect(v.element.querySelector(".canon-skill-row")).toBeTruthy();
    });
    expect(labels(v)).toEqual(expect.arrayContaining(["Open in editor", "Publish to registry", "Delete"]));

    v.element.querySelector<HTMLButtonElement>("[aria-label='Open in editor']")!.click();
    await vi.waitFor(() => {
      expect(canonUnitPath).toHaveBeenCalledWith("/x", "agent", "reviewer");
      expect(opened).toEqual(["/x/.covenant/canon/agents/reviewer.md"]);
    });
  });

  it("deletes through the confirm card, with the kind the section owns", async () => {
    vi.mocked(canonLocalStatus).mockResolvedValueOnce(withAgent(null));
    vi.mocked(canonDeleteUnit).mockClear();
    const v = new CanonCockpitView(opts);
    v.open(); v.showSection("agents");
    await vi.waitFor(() => {
      expect(v.element.querySelector("[aria-label='Delete']")).toBeTruthy();
    });
    v.element.querySelector<HTMLButtonElement>("[aria-label='Delete']")!.click();
    document.querySelector<HTMLButtonElement>(".workspace-confirm-confirm")!.click();
    await vi.waitFor(() => {
      expect(canonDeleteUnit).toHaveBeenCalledWith("/x", "agent", "reviewer");
    });
  });

  it("detected rows offer Adopt and never Delete — a foreign file isn't Canon's to remove", async () => {
    vi.mocked(canonLocalStatus).mockResolvedValueOnce(withAgent(".claude/agents"));
    const v = new CanonCockpitView(opts);
    v.open(); v.showSection("agents");
    await vi.waitFor(() => {
      expect(v.element.querySelector(".canon-skill-row.is-detected")).toBeTruthy();
    });
    expect(labels(v)).toContain("Adopt into Canon");
    expect(labels(v)).not.toContain("Delete");
    expect(labels(v)).not.toContain("Publish to registry");
  });
});

describe("CanonCockpitView finder", () => {
  it("searches every kind at once and lands on the owning section, pre-filtered", async () => {
    vi.mocked(canonLocalStatus).mockResolvedValue({
      installed: [], agents: [{ name: "reviewer" }],
      commands: [{ name: "deploy", description: null }, { name: "review-diff", description: null }],
      contexts: [], memory: [], mcp: [], specs: [], detectedSkills: [],
    });
    const v = new CanonCockpitView(opts);
    v.open();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
    const finder = document.querySelector<HTMLElement>(".canon-finder")!;
    expect(finder).toBeTruthy();
    await vi.waitFor(() => {
      expect(finder.querySelectorAll(".command-palette-item").length).toBe(3); // across two kinds
    });

    const input = finder.querySelector<HTMLInputElement>(".command-palette-input")!;
    input.value = "review";
    input.dispatchEvent(new Event("input"));
    const shown = [...finder.querySelectorAll(".cp-title")].map((e) => e.textContent);
    expect(shown).toEqual(["reviewer", "review-diff"]);

    // Picking a command jumps to Commands with its name already in the filter.
    finder.querySelectorAll<HTMLElement>(".command-palette-item")[1].click();
    expect(document.querySelector(".canon-finder")).toBeNull();
    expect(v.element.querySelector('[data-section="commands"].is-active')).toBeTruthy();
    await vi.waitFor(() => {
      const rows = [...v.element.querySelectorAll<HTMLElement>(".canon-skill-row")];
      expect(rows.length).toBe(2);
      expect(rows.filter((r) => !r.hidden).map((r) => r.textContent)).toEqual([
        expect.stringContaining("review-diff"),
      ]);
    });
    vi.mocked(canonLocalStatus).mockResolvedValue({
      installed: [], agents: [], contexts: [], memory: [], commands: [], mcp: [], specs: [], detectedSkills: [],
    });
  });
});

describe("CanonCockpitView doors", () => {
  it("opens at the section it was asked for", () => {
    const v = new CanonCockpitView({ ...opts, section: "registry" });
    v.open();
    expect(v.element.querySelector('[data-section="registry"].is-active')).toBeTruthy();
  });

  it("empty states offer the crawler as a second CTA", async () => {
    vi.mocked(canonLocalStatus).mockResolvedValueOnce({
      installed: [], agents: [], contexts: [], memory: [], commands: [], mcp: [], specs: [], detectedSkills: [],
    });
    let crawled = false;
    const v = new CanonCockpitView({ ...opts, onNewContext: () => { crawled = true; } });
    v.open(); v.showSection("agents");
    await vi.waitFor(() => {
      expect(v.element.querySelector(".canon-cockpit-empty")).toBeTruthy();
    });
    const btns = [...v.element.querySelectorAll<HTMLButtonElement>(".rail-empty-btn")];
    expect(btns.map((b) => b.textContent)).toEqual(["New subagent", "Crawl repo"]);
    btns[1].click();
    expect(crawled).toBe(true);
  });
});

describe("CanonCockpitView Overview", () => {
  const populated = {
    installed: [{ name: "kyc", version: "1.0.0", source: "registry:karluiz", sha: "a", signer: null, installedAt: "t" }],
    agents: [{ name: "reviewer" }], contexts: [], memory: [],
    commands: [{ name: "deploy", description: null }], mcp: [], specs: [], detectedSkills: [],
  };

  it("counts every kind and routes to its section", async () => {
    vi.mocked(canonLocalStatus).mockResolvedValueOnce(populated);
    const v = new CanonCockpitView(opts);
    v.open();
    await vi.waitFor(() => {
      expect(v.element.querySelectorAll(".canon-cockpit-inventory .canon-cockpit-listitem").length).toBe(7);
    });
    const rows = [...v.element.querySelectorAll(".canon-cockpit-inventory .canon-cockpit-listitem")]
      .map((r) => r.textContent);
    expect(rows[0]).toContain("Subagents");
    expect(rows[0]).toContain("1");
    v.element.querySelectorAll<HTMLButtonElement>(".canon-cockpit-inventory .canon-cockpit-listitem")[1].click();
    expect(v.element.querySelector('[data-section="commands"].is-active')).toBeTruthy();
  });

  it("names the org defaults this repo is missing, and installs them", async () => {
    vi.mocked(canonLocalStatus).mockResolvedValue(populated);
    vi.mocked(canonOrgDefaults).mockResolvedValue([
      { kind: "skill", name: "kyc" }, { kind: "agent", name: "reviewer" }, { kind: "command", name: "lint" },
    ]);
    vi.mocked(canonUnitInstalled).mockImplementation(async (_c, _k, name) => name === "kyc");
    vi.mocked(canonInstallRegistryUnit).mockClear();
    const v = new CanonCockpitView(opts);
    v.open();
    await vi.waitFor(() => {
      expect(v.element.textContent).toContain("2 of 3 org defaults missing here");
    });
    v.element.querySelector<HTMLButtonElement>(".canon-cockpit-listitem-action")!.click();
    await vi.waitFor(() => {
      expect(canonInstallRegistryUnit).toHaveBeenCalledWith("/x", "karluiz", "reviewer", "latest", "agent");
      expect(canonInstallRegistryUnit).toHaveBeenCalledWith("/x", "karluiz", "lint", "latest", "command");
    });
    vi.mocked(canonOrgDefaults).mockResolvedValue([]);
    vi.mocked(canonUnitInstalled).mockImplementation(async () => false);
    vi.mocked(canonLocalStatus).mockResolvedValue({
      installed: [], agents: [], contexts: [], memory: [], commands: [], mcp: [], specs: [], detectedSkills: [],
    });
  });

  it("says nothing when nothing needs attention", async () => {
    vi.mocked(canonLocalStatus).mockResolvedValueOnce(populated);
    vi.mocked(scoreSkillUsage).mockResolvedValueOnce([{ skill: "kyc", uses: 4 }]);
    const v = new CanonCockpitView(opts);
    v.open();
    await vi.waitFor(() => {
      expect(v.element.textContent).toContain("Inventory");
    });
    expect(v.element.textContent).not.toContain("Needs attention");
  });
});

describe("Canon dead weight", () => {
  it("unusedUnits keeps only what nothing has used", () => {
    const installed = [{ name: "kyc" }, { name: "dead" }, { name: "never-recorded" }];
    const usage = [{ skill: "kyc", uses: 3 }, { skill: "dead", uses: 0 }];
    expect(unusedUnits(installed, usage)).toEqual(["dead", "never-recorded"]);
    expect(unusedUnits([], usage)).toEqual([]);
  });

  it("inventoryRows counts detected skills alongside installed ones", () => {
    const rows = inventoryRows({
      installed: [{ name: "kyc" }] as never, detectedSkills: [{ name: "foreign" }] as never,
      agents: [], contexts: [], memory: [], commands: [], mcp: [], specs: [],
    } as never);
    expect(rows.find((r) => r.section === "skills")?.count).toBe(2);
  });

  it("Loop lists unused skills with the uninstall that removes them", async () => {
    vi.mocked(canonLocalStatus).mockResolvedValueOnce({
      installed: [{ name: "dead", version: "1.0.0", source: "registry:karluiz", sha: "a", signer: null, installedAt: "t" }],
      agents: [], contexts: [], memory: [], commands: [], mcp: [], specs: [], detectedSkills: [],
    });
    vi.mocked(canonUninstallSkill).mockClear();
    const v = new CanonCockpitView(opts);
    v.open(); v.showSection("loop");
    await vi.waitFor(() => {
      expect(v.element.textContent).toContain("Unused");
      expect(v.element.querySelector(".canon-skill-row [aria-label='Uninstall skill']")).toBeTruthy();
    });
    v.element.querySelector<HTMLButtonElement>("[aria-label='Uninstall skill']")!.click();
    document.querySelector<HTMLButtonElement>(".workspace-confirm-confirm")!.click();
    await vi.waitFor(() => {
      expect(canonUninstallSkill).toHaveBeenCalledWith("/x", "dead");
    });
  });
});

describe("Canon staleness", () => {
  it("skillCurrency prefers local edits, then version drift, then silence", () => {
    const kyc = { name: "kyc", version: "1.0.0" };
    expect(skillCurrency(kyc, "1.0.0", [])).toBeNull();
    expect(skillCurrency(kyc, undefined, [])).toBeNull();
    expect(skillCurrency(kyc, "2.1.0", [])).toBe("update available · v2.1.0");
    // A local edit is the more actionable fact — it outranks the version gap.
    expect(skillCurrency(kyc, "2.1.0", ["kyc"])).toBe("modified locally");
  });

  it("marks an installed skill the registry has moved past", async () => {
    vi.mocked(canonLocalStatus).mockResolvedValueOnce({
      installed: [{ name: "kyc", version: "1.0.0", source: "registry:karluiz", sha: "a", signer: null, installedAt: "t" }],
      agents: [], contexts: [], memory: [], commands: [], mcp: [], specs: [], detectedSkills: [],
      modifiedSkills: [],
    });
    vi.mocked(canonSearch).mockResolvedValueOnce([
      { id: 1, name: "kyc", version: "2.1.0", description: "", publisher_login: "karluiz", installs: 9, sha: "zzz", kind: "skill", eval_passed: 0, eval_total: 0 },
    ]);
    const v = new CanonCockpitView(opts);
    v.open(); v.showSection("skills");
    await vi.waitFor(() => {
      expect(v.element.querySelector(".canon-skill-row")?.textContent).toContain("update available · v2.1.0");
    });
  });
});

describe("CanonCockpitView projection strip", () => {
  it("names every executor and offers a re-project when one drifted", async () => {
    vi.mocked(canonProjectionStatus).mockResolvedValue({
      executors: [{ tool: "claude", state: "synced" }, { tool: "codex", state: "stale" }],
      source_edited_unix: Math.floor(Date.now() / 1000) - 120,
    });
    vi.mocked(canonExport).mockClear();
    const v = new CanonCockpitView(opts);
    v.open();
    await vi.waitFor(() => {
      expect(v.element.querySelectorAll(".canon-projection-chip").length).toBe(2);
    });
    const strip = v.element.querySelector(".canon-projection")!;
    expect(strip.textContent).toContain("claude");
    expect(strip.textContent).toContain("sources edited 2m ago");
    expect(strip.querySelector(".canon-projection-chip.is-stale")).toBeTruthy();

    strip.querySelector<HTMLButtonElement>(".canon-cockpit-listitem-action")!.click();
    await vi.waitFor(() => {
      expect(canonExport).toHaveBeenCalledWith("/x");
    });
    vi.mocked(canonProjectionStatus).mockResolvedValue({ executors: [], source_edited_unix: null });
  });

  it("stays out of the way when everything is in sync", async () => {
    vi.mocked(canonProjectionStatus).mockResolvedValueOnce({
      executors: [{ tool: "claude", state: "synced" }], source_edited_unix: null,
    });
    const v = new CanonCockpitView(opts);
    v.open();
    await vi.waitFor(() => {
      expect(v.element.querySelector(".canon-projection-chip")).toBeTruthy();
    });
    expect(v.element.querySelector(".canon-projection .canon-cockpit-listitem-action")).toBeNull();
  });
});

describe("CanonCockpitView nav", () => {
  it("groups sections by what they are for, and Loop is Impact", () => {
    const v = new CanonCockpitView(opts);
    v.open();
    const groups = [...v.element.querySelectorAll(".canon-cockpit-nav-group")].map((g) => g.textContent);
    expect(groups).toEqual(["Authoring", "Sharing", "Impact"]);
    expect(v.element.querySelector('[data-section="loop"]')?.textContent).toBe("Impact");
    // Every section still reachable — grouping is presentation, not pruning.
    expect(v.element.querySelectorAll(".canon-cockpit-nav-btn").length).toBe(13);
  });
});

describe("CanonCockpitView eval from the row", () => {
  it("runs a skill's evals behind the confirm card", async () => {
    vi.mocked(canonLocalStatus).mockResolvedValueOnce({
      installed: [{ name: "kyc", version: "1.0.0", source: "local:x", sha: "a", signer: null, installedAt: "t" }],
      agents: [], contexts: [], memory: [], commands: [], mcp: [], specs: [], detectedSkills: [],
    });
    vi.mocked(canonRunEvals).mockClear();
    const v = new CanonCockpitView(opts);
    v.open(); v.showSection("skills");
    await vi.waitFor(() => {
      expect(v.element.querySelector(".canon-skill-row [aria-label='Run evals']")).toBeTruthy();
    });
    v.element.querySelector<HTMLButtonElement>("[aria-label='Run evals']")!.click();
    document.querySelector<HTMLButtonElement>(".workspace-confirm-confirm")!.click();
    await vi.waitFor(() => {
      expect(canonRunEvals).toHaveBeenCalledWith("/x", "kyc");
    });
  });

  it("shows the lift verdict on the row it judges", async () => {
    vi.mocked(canonLocalStatus).mockResolvedValueOnce({
      installed: [{ name: "kyc", version: "1.0.0", source: "local:x", sha: "a", signer: null, installedAt: "t" }],
      agents: [], contexts: [], memory: [], commands: [], mcp: [], specs: [], detectedSkills: [],
    });
    vi.mocked(canonEvalSummary).mockResolvedValueOnce([
      { skill: "kyc", passed: 4, total: 5, baseline_passed: 2, baseline_total: 5 },
    ]);
    const v = new CanonCockpitView(opts);
    v.open(); v.showSection("skills");
    await vi.waitFor(() => {
      expect(v.element.querySelector(".canon-skill-row")?.textContent).toContain("lift");
    });
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
      // Same head action as every other kind, not a floating bar in the body.
      expect(v.element.querySelector(".canon-cockpit-sec-head .canon-sec-head-action")).toBeTruthy();
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
    // The section joins status + registry catalogue + eval summary, so wait on
    // the render rather than counting microtasks.
    await vi.waitFor(() => {
      expect(v.element.querySelector(".canon-cockpit-empty")).toBeTruthy();
    });
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

describe("CanonCockpitView authoring", () => {
  const memberOpts = {
    ...opts,
    orgs: [{ id: 1, slug: "acme", name: "Acme", role: "member", personal: false }],
    getActiveOrg: () => "acme",
  };
  const noOrgOpts = { ...opts, orgs: [], getActiveOrg: () => null };

  it("shows the New action to an org owner", () => {
    const v = new CanonCockpitView(opts);
    v.open();
    v.showSection("agents");
    expect(v.element.querySelector(".canon-sec-head-action")).toBeTruthy();
    v.close();
  });

  it("hides the New action from a non-owner member", () => {
    const v = new CanonCockpitView(memberOpts);
    v.open();
    v.showSection("agents");
    expect(v.element.querySelector(".canon-sec-head-action")).toBeNull();
    v.close();
  });

  it("shows the New action when there is no organization at all", () => {
    const v = new CanonCockpitView(noOrgOpts);
    v.open();
    v.showSection("commands");
    expect(v.element.querySelector(".canon-sec-head-action")).toBeTruthy();
    v.close();
  });

  it("creates the unit and hands the path to onOpenFile", async () => {
    const onOpenFile = vi.fn();
    const v = new CanonCockpitView({ ...opts, onOpenFile });
    v.open();
    v.showSection("agents");
    const input = v.element.querySelector<HTMLInputElement>(".canon-import-input");
    expect(input).toBeTruthy();
    input!.value = "reviewer";
    v.element.querySelector<HTMLFormElement>(".canon-import-bar")!
      .dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(canonNewUnit).toHaveBeenCalledWith("/x", "agent", "reviewer"));
    await vi.waitFor(() =>
      expect(onOpenFile).toHaveBeenCalledWith("/x/.covenant/canon/agents/reviewer.md"));
  });

  it("routes a slash-bearing value to the skills.sh import", async () => {
    const v = new CanonCockpitView(opts);
    v.open();
    v.showSection("skills");
    const input = v.element.querySelector<HTMLInputElement>(".canon-import-input")!;
    input.value = "obra/skills --skill deploy";
    v.element.querySelector<HTMLFormElement>(".canon-import-bar")!
      .dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() =>
      expect(canonImportSkill).toHaveBeenCalledWith("/x", "obra/skills --skill deploy"));
    expect(canonNewUnit).not.toHaveBeenCalledWith("/x", "skill", "obra/skills --skill deploy");
    v.close();
  });

  it("routes a bare name to a new skill", async () => {
    const v = new CanonCockpitView(opts);
    v.open();
    v.showSection("skills");
    const input = v.element.querySelector<HTMLInputElement>(".canon-import-input")!;
    input.value = "deploy-notes";
    v.element.querySelector<HTMLFormElement>(".canon-import-bar")!
      .dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(canonNewUnit).toHaveBeenCalledWith("/x", "skill", "deploy-notes"));
  });

  it("opens the spec creator scoped to the group's repo", () => {
    const onNewSpec = vi.fn();
    const v = new CanonCockpitView({ ...opts, onNewSpec });
    v.open();
    v.showSection("spec");
    v.element.querySelector<HTMLButtonElement>(".canon-sec-head-action")!.click();
    expect(onNewSpec).toHaveBeenCalledWith("/x");
  });
});

describe("evalChip", () => {
  const pkg = (eval_passed: number, eval_total: number): PkgMeta => ({
    id: 1, name: "kyc-peru", version: "2.1.0", description: "",
    publisher_login: "karluiz", installs: 14, sha: "abc1234", kind: "skill",
    eval_passed, eval_total,
  });

  it("reads as a pass-rate when the org has run evals", () => {
    expect(evalChip(pkg(12, 14))).toBe("12/14 eval runs");
  });

  it("is absent when nobody has run any", () => {
    // 0/0 would read as a failing package rather than an unmeasured one.
    expect(evalChip(pkg(0, 0))).toBeNull();
  });

  it("shows a total wipeout rather than hiding it", () => {
    expect(evalChip(pkg(0, 3))).toBe("0/3 eval runs");
  });
});
