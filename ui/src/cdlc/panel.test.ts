import { describe, it, expect, vi } from "vitest";
import { CdlcPanel } from "./panel";

// Mock the api module so tests don't invoke Tauri IPC.
vi.mock("../api", () => ({
  cdlcLocalStatus: vi.fn().mockResolvedValue({ installed: [], contextFiles: [] }),
}));

describe("CdlcPanel", () => {
  it("renders installed skills and context files", () => {
    const host = document.createElement("div");
    const panel = new CdlcPanel({
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
    expect(host.textContent).toContain("kyc-peru.md");
  });

  it("shows fallback when no skills installed", () => {
    const host = document.createElement("div");
    const panel = new CdlcPanel({
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
    new CdlcPanel({
      groupId: "g3",
      groupLabel: "Bare",
      groupColor: null,
      groupRootDir: null,
    }).mount(host);
    expect(host.querySelector(".cdlc-panel")).not.toBeNull();
  });

  it("calls onNewContext when New context button is clicked", () => {
    let called = false;
    const host = document.createElement("div");
    const panel = new CdlcPanel({
      groupId: "g4",
      groupLabel: "Test",
      groupColor: null,
      groupRootDir: "/repo",
      onNewContext: () => { called = true; },
    }).mount(host);
    panel.renderStatus({ installed: [], contextFiles: [] });
    const btn = host.querySelector(".cdlc-new-context-btn") as HTMLButtonElement;
    btn.click();
    expect(called).toBe(true);
  });

  it("calls onClose when close button is clicked", () => {
    let closed = false;
    const host = document.createElement("div");
    new CdlcPanel({
      groupId: "g5",
      groupLabel: "Test",
      groupColor: null,
      groupRootDir: "/repo",
      onClose: () => { closed = true; },
    }).mount(host);
    const btn = host.querySelector(".cdlc-close-btn") as HTMLButtonElement;
    btn.click();
    expect(closed).toBe(true);
  });
});
