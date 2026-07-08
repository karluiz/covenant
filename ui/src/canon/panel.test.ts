import { describe, it, expect, vi, type Mock } from "vitest";
import { CanonPanel, slugify } from "./panel";

// Mock the api module so tests don't invoke Tauri IPC. Only the calls
// panel.ts's compact rail actually makes — registry search, install, and
// the score/eval Loop dashboards moved to the cockpit (see cockpit tests).
vi.mock("../api", () => ({
  canonLocalStatus: vi.fn().mockResolvedValue({ installed: [], contextFiles: [] }),
  canonMyOrgs: vi.fn().mockResolvedValue([]),
  canonCreateOrg: vi.fn().mockResolvedValue({}),
  canonPublish: vi.fn().mockResolvedValue({}),
  canonReadLocal: vi.fn().mockResolvedValue(""),
  canonExport: vi.fn().mockResolvedValue(undefined),
  canonRunEvals: vi.fn().mockResolvedValue(undefined),
  onCanonEvalProgress: vi.fn().mockResolvedValue(() => {}),
}));

vi.mock("../notifications/toast", () => ({
  pushInfoToast: vi.fn(),
}));

describe("CanonPanel", () => {
  // Compact rail summary: skill count + a compact card list. Context files
  // and the registry/adoption/eval dashboards now render in the cockpit
  // (see cockpit/view.test.ts's Context/Loop section suites).
  it("renders installed skills with a compact count", () => {
    const host = document.createElement("div");
    const panel = new CanonPanel({
      groupId: "g1",
      groupLabel: "Payments",
      groupColor: null,
      groupRootDir: "/repo",
    }).mount(host);
    panel.renderStatus({
      installed: [
        { name: "kyc-peru", version: "2.1.0", source: "local:/x", sha: "a", signer: "github:mibanco", installedAt: "2026-06-24T00:00:00Z" },
      ],
      contextFiles: ["kyc-peru.md"],
    });
    expect(host.textContent).toContain("kyc-peru");
    expect(host.textContent).toContain("2.1.0");
    expect(host.textContent).toContain("1 skill installed");
  });

  it("shows fallback when no skills installed", () => {
    const host = document.createElement("div");
    const panel = new CanonPanel({
      groupId: "g2",
      groupLabel: "Empty Group",
      groupColor: null,
      groupRootDir: "/repo",
    }).mount(host);
    panel.renderStatus({ installed: [], contextFiles: [] });
    expect(host.textContent).toContain("No skills installed.");
  });

  it("shows the panel root when groupRootDir is absent", () => {
    const host = document.createElement("div");
    new CanonPanel({
      groupId: "g3",
      groupLabel: "Bare",
      groupColor: null,
      groupRootDir: null,
    }).mount(host);
    expect(host.querySelector(".canon-panel")).not.toBeNull();
  });

  it("calls onClose when close() is invoked (rail teardown path)", () => {
    // The panel has no in-head × — the rail toggle closes it by calling
    // close() (see main.ts). Verify that path fires onClose.
    let closed = false;
    const host = document.createElement("div");
    const panel = new CanonPanel({
      groupId: "g5",
      groupLabel: "Test",
      groupColor: null,
      groupRootDir: "/repo",
      onClose: () => { closed = true; },
    }).mount(host);
    panel.close();
    expect(closed).toBe(true);
  });

  it("shows a Publish button per installed skill when orgs exist", async () => {
    const host = document.createElement("div");
    const panel = new CanonPanel({
      groupId: "g1", groupLabel: "Payments", groupColor: null, groupRootDir: "/repo",
    }).mount(host);
    // simulate orgs loaded + a status with one installed skill
    panel.setOrgs([{ id: 1, slug: "mibanco", name: "Mibanco", role: "owner", personal: false }]);
    panel.renderStatus({
      installed: [
        { name: "kyc-peru", version: "1.0.0", source: "local:/x", sha: "a", signer: null, installedAt: "t" },
      ],
      contextFiles: [],
    });
    expect(host.querySelector('button[aria-label="Publish to registry"]')).not.toBeNull();
    expect(host.textContent).toContain("kyc-peru");
  });

  it("exposes a Run evals action on each installed skill", async () => {
    const { canonLocalStatus } = await import("../api");
    (canonLocalStatus as Mock).mockResolvedValueOnce({
      installed: [{ name: "kyc-peru", version: "1.0.0", source: "registry:payments", sha: "a", signer: null, installedAt: "t" }],
      contextFiles: [],
    });
    const panel = new CanonPanel({ groupId: "g-eval-btn", groupLabel: "Payments", groupColor: null, groupRootDir: "/repo" });
    await panel.refresh();
    const btn = panel.element.querySelector('button[aria-label="Run evals"]');
    expect(btn).not.toBeNull();
  });

  it("toasts a helpful message instead of 'finished' when a skill has no evals", async () => {
    const { canonLocalStatus, onCanonEvalProgress } = await import("../api");
    const { pushInfoToast } = await import("../notifications/toast");
    (canonLocalStatus as Mock).mockResolvedValueOnce({
      installed: [{ name: "kyc-peru", version: "1.0.0", source: "registry:payments", sha: "a", signer: null, installedAt: "t" }],
      contextFiles: [],
    });
    // Backend signals an empty run via the done note.
    (onCanonEvalProgress as Mock).mockImplementationOnce(
      async (handler: (e: { skill: string; eval_id: string; status: string; reason: string }) => void) => {
        handler({ skill: "kyc-peru", eval_id: "", status: "done", reason: "no evals found" });
        return () => {};
      },
    );
    vi.spyOn(window, "confirm").mockReturnValueOnce(true);
    const panel = new CanonPanel({ groupId: "g-no-evals", groupLabel: "Payments", groupColor: null, groupRootDir: "/repo" });
    await panel.refresh();
    panel.element.querySelector<HTMLButtonElement>('button[aria-label="Run evals"]')!.click();
    await vi.waitFor(() => {
      const msgs = (pushInfoToast as Mock).mock.calls.map((c) => c[0].message as string);
      expect(msgs.some((m) => m.startsWith("No evals for kyc-peru"))).toBe(true);
      expect(msgs.some((m) => m.includes("finished"))).toBe(false);
    });
  });

  it("resolves active org from the group callback, else the personal org", () => {
    const orgs = [
      { id: 1, slug: "cleverit", name: "Cleverit", role: "member", personal: false },
      { id: 2, slug: "karluiz", name: "karluiz", role: "owner", personal: true },
    ];
    const p = new CanonPanel({ groupId: "g1", groupLabel: "G1", groupRootDir: "/x",
      getActiveOrg: () => null, setActiveOrg: () => {} });
    p.setOrgs(orgs);
    expect(p.activeOrg()?.slug).toBe("karluiz"); // personal wins when group unset
    const p2 = new CanonPanel({ groupId: "g1", groupLabel: "G1", groupRootDir: "/x",
      getActiveOrg: () => "cleverit", setActiveOrg: () => {} });
    p2.setOrgs(orgs);
    expect(p2.activeOrg()?.slug).toBe("cleverit"); // group choice wins
  });

  it("slugifies a display name to a valid slug", () => {
    expect(slugify("Cleverit SpA")).toBe("cleverit-spa");
    expect(slugify("  Banco de Chile ")).toBe("banco-de-chile");
    expect(slugify("--weird__name--")).toBe("weird-name");
  });
});
