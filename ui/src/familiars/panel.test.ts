// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { FamiliarPanel } from "./panel";
import { Familiars } from "./api";

// Module-level mock so all tests share the same vi.fn instances.
vi.mock("./api", () => ({
  Familiars: {
    list: vi.fn().mockResolvedValue([]),
    snapshot: vi.fn().mockResolvedValue({
      rolling_summary: "",
      last_event_ms: 0,
      recent_missions: [],
      spend_today_usd: 0,
      frozen: false,
    }),
    audit: vi.fn().mockResolvedValue([]),
    hasRecentClosedMission: vi.fn().mockResolvedValue(false),
  },
}));

function mountHost(): HTMLElement {
  document.body.innerHTML = `<aside id="familiar-panel" class="hidden"></aside>`;
  return document.getElementById("familiar-panel")!;
}

describe("FamiliarPanel", () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = "";
  });

  it("mounts header, tabs and body inside #familiar-panel", () => {
    mountHost();
    new FamiliarPanel();
    const host = document.getElementById("familiar-panel")!;
    expect(host.querySelector(".familiar-panel__header")).not.toBeNull();
    expect(host.querySelectorAll(".familiar-panel__tab").length).toBe(3);
    expect(host.querySelector(".familiar-panel__body")).not.toBeNull();
  });
});

describe("FamiliarPanel — toggle and persistence", () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = "";
  });

  it("starts hidden by default and toggle() shows then hides", () => {
    mountHost();
    const p = new FamiliarPanel();
    const host = document.getElementById("familiar-panel")!;
    expect(host.classList.contains("hidden")).toBe(true);

    p.toggle();
    expect(host.classList.contains("hidden")).toBe(false);
    expect(document.body.classList.contains("familiar-panel-open")).toBe(true);
    expect(localStorage.getItem("familiar-panel-open")).toBe("true");

    p.toggle();
    expect(host.classList.contains("hidden")).toBe(true);
    expect(document.body.classList.contains("familiar-panel-open")).toBe(false);
    expect(localStorage.getItem("familiar-panel-open")).toBe("false");
  });

  it("restores open state from localStorage", () => {
    mountHost();
    localStorage.setItem("familiar-panel-open", "true");
    new FamiliarPanel();
    const host = document.getElementById("familiar-panel")!;
    expect(host.classList.contains("hidden")).toBe(false);
  });

  it("persists the active sub-tab and restores it", () => {
    mountHost();
    const p = new FamiliarPanel();
    // Cast to access private via bracket — vitest runs against TS source.
    (p as unknown as { selectTab: (t: "chat" | "status" | "audit") => void })
      .selectTab("audit");
    expect(localStorage.getItem("familiar-panel-tab")).toBe("audit");

    document.body.innerHTML = "";
    mountHost();
    new FamiliarPanel();
    const host = document.getElementById("familiar-panel")!;
    const auditTab = host.querySelector('[data-tab="audit"]') as HTMLElement;
    expect(auditTab.classList.contains("familiar-panel__tab--active")).toBe(true);
  });
});

describe("FamiliarPanel — bindToSession", () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = "";
    vi.mocked(Familiars.list).mockReset();
    vi.mocked(Familiars.list).mockResolvedValue([]);
  });

  it("shows empty state when no Familiar matches the session", async () => {
    mountHost();
    const p = new FamiliarPanel();
    vi.mocked(Familiars.list).mockResolvedValueOnce([]);
    await p.bindToSession("session-xyz");
    const host = document.getElementById("familiar-panel")!;
    const empty = host.querySelector(".familiar-panel__empty") as HTMLElement;
    expect(empty.hidden).toBe(false);
    expect(host.querySelector(".familiar-panel__title")!.textContent).toBe("Familiar");
  });

  it("sets header and enables tabs when a Familiar exists", async () => {
    mountHost();
    const p = new FamiliarPanel();
    vi.mocked(Familiars.list).mockResolvedValueOnce([{
      id: "fam-1",
      session_id: "session-xyz",
      name: "Vex",
      style: "conversational",
      daily_cap_usd: 5,
    }]);
    await p.bindToSession("session-xyz");
    const host = document.getElementById("familiar-panel")!;
    expect(host.querySelector(".familiar-panel__title")!.textContent).toBe("Vex");
    const empty = host.querySelector(".familiar-panel__empty") as HTMLElement;
    expect(empty.hidden).toBe(true);
    const chatTab = host.querySelector('[data-tab="chat"]') as HTMLButtonElement;
    expect(chatTab.disabled).toBe(false);
  });

  it("shows empty state when sessionId is null", async () => {
    mountHost();
    const p = new FamiliarPanel();
    await p.bindToSession(null);
    const host = document.getElementById("familiar-panel")!;
    const empty = host.querySelector(".familiar-panel__empty") as HTMLElement;
    expect(empty.hidden).toBe(false);
  });
});
