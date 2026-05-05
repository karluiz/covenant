import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createSpecPromptState,
  type TabSnapshot,
} from "./spec-prompt-state";
import type { SpecCandidate } from "../api";

// ---------------------------------------------------------------------------
// Integration tests for spec-prompt toast rendering (single-toast semantics)
// ---------------------------------------------------------------------------

// Capture the handler registered via subscribeSpecCandidates so tests can
// emit candidates directly without Tauri.
let capturedCandidateHandler: ((c: SpecCandidate) => void) | null = null;

vi.mock("../api", async (importOriginal) => {
  const original = await importOriginal<typeof import("../api")>();
  return {
    ...original,
    specDetectorApi: { start: vi.fn().mockResolvedValue(undefined) },
    subscribeSpecCandidates: vi.fn().mockImplementation((handler: (c: SpecCandidate) => void) => {
      capturedCandidateHandler = handler;
      return Promise.resolve(() => { capturedCandidateHandler = null; });
    }),
  };
});

type MakeHostOpts = { activeTabId?: string };

function makeHost(tabs: TabSnapshot[], opts: MakeHostOpts = {}) {
  return {
    listTabs: () => tabs,
    getActiveTabId: () => opts.activeTabId ?? null,
    setMissionForTab: vi.fn().mockResolvedValue(undefined),
    getTabLabel: (tabId: string) => {
      const t = tabs.find((x) => x.id === tabId);
      return t ? `Tab ${tabId}` : tabId;
    },
  };
}

function emitCandidate(c: Partial<SpecCandidate>) {
  const full: SpecCandidate = {
    repo_root: "/repo",
    path: "/repo/docs/specs/3.20.md",
    source: "covenant",
    title: "3.20",
    goal_snippet: "...",
    ...c,
  };
  capturedCandidateHandler?.(full);
}

describe("spec-prompt toast rendering", () => {
  beforeEach(async () => {
    // Reset module-level state between tests by re-importing with a fresh state.
    // We do this by clearing the DOM and resetting the singleton via the export.
    document.body.innerHTML = "";
    capturedCandidateHandler = null;
    // Reset the singleton so startSpecPrompts re-subscribes.
    // Each test calls vi.resetModules() and re-imports spec-prompt so the
    // module-level singleton (unlisten) is cleared, allowing a fresh subscription.
  });

  it("renders exactly one toast bound to the active eligible tab", async () => {
    vi.resetModules();
    capturedCandidateHandler = null;
    document.body.innerHTML = "";

    // Re-import after resetModules so unlisten is null and a fresh subscription fires.
    vi.mock("../api", async (importOriginal) => {
      const original = await importOriginal<typeof import("../api")>();
      return {
        ...original,
        specDetectorApi: { start: vi.fn().mockResolvedValue(undefined) },
        subscribeSpecCandidates: vi.fn().mockImplementation((handler: (c: SpecCandidate) => void) => {
          capturedCandidateHandler = handler;
          return Promise.resolve(() => { capturedCandidateHandler = null; });
        }),
      };
    });

    const { startSpecPrompts } = await import("./spec-prompt");
    const tabs: TabSnapshot[] = [
      { id: "t1", cwd: "/repo", hasMission: false, hasOperator: true },
      { id: "t2", cwd: "/repo", hasMission: false, hasOperator: true },
    ];
    const host = makeHost(tabs, { activeTabId: "t2" });
    await startSpecPrompts(host);

    emitCandidate({ path: "/repo/docs/specs/3.20.md", repo_root: "/repo", source: "covenant", goal_snippet: "..." });

    const toasts = document.querySelectorAll(".spec-prompt-toast");
    expect(toasts.length).toBe(1);
    expect((toasts[0] as HTMLElement).dataset.tabId).toBe("t2");
  });

  it("falls back to first eligible tab if active is not eligible", async () => {
    vi.resetModules();
    capturedCandidateHandler = null;
    document.body.innerHTML = "";

    vi.mock("../api", async (importOriginal) => {
      const original = await importOriginal<typeof import("../api")>();
      return {
        ...original,
        specDetectorApi: { start: vi.fn().mockResolvedValue(undefined) },
        subscribeSpecCandidates: vi.fn().mockImplementation((handler: (c: SpecCandidate) => void) => {
          capturedCandidateHandler = handler;
          return Promise.resolve(() => { capturedCandidateHandler = null; });
        }),
      };
    });

    const { startSpecPrompts } = await import("./spec-prompt");
    const tabs: TabSnapshot[] = [
      { id: "t1", cwd: "/other", hasMission: false, hasOperator: true },
      { id: "t2", cwd: "/repo",  hasMission: true,  hasOperator: true },
      { id: "t3", cwd: "/repo",  hasMission: false, hasOperator: true },
    ];
    const host = makeHost(tabs, { activeTabId: "t1" });
    await startSpecPrompts(host);

    emitCandidate({ path: "/repo/docs/specs/3.20.md", repo_root: "/repo", source: "covenant", goal_snippet: "..." });

    const toasts = document.querySelectorAll(".spec-prompt-toast");
    expect(toasts.length).toBe(1);
    expect((toasts[0] as HTMLElement).dataset.tabId).toBe("t3");
  });
});

const cand = (over: Partial<SpecCandidate> = {}): SpecCandidate => ({
  repo_root: "/tmp/repo",
  path: "/tmp/repo/docs/specs/3.16-foo.md",
  source: "covenant",
  title: "3.16 — Foo",
  goal_snippet: "Does the foo.",
  ...over,
});

const tab = (over: Partial<TabSnapshot> = {}): TabSnapshot => ({
  id: "t1",
  cwd: "/tmp/repo/sub",
  hasMission: false,
  hasOperator: true,
  ...over,
});

describe("specPromptState", () => {
  it("returns eligible tabs only (cwd ⊂ repo, no mission, has operator)", () => {
    const s = createSpecPromptState();
    const tabs = [
      tab({ id: "ok" }),
      tab({ id: "wrong-repo", cwd: "/elsewhere" }),
      tab({ id: "with-mission", hasMission: true }),
      tab({ id: "no-operator", hasOperator: false }),
    ];
    const elig = s.eligibleTabs(cand(), tabs);
    expect(elig.map((t) => t.id)).toEqual(["ok"]);
  });

  it("dismiss prevents future toasts for that tab/path", () => {
    const s = createSpecPromptState();
    const c = cand();
    s.recordCandidate(c, 1000);
    s.dismiss("t1", c.path);
    expect(s.isDismissed("t1", c.path)).toBe(true);
    expect(s.isDismissed("t2", c.path)).toBe(false);
  });

  it("getPendingForTab returns candidates within the 10-min window", () => {
    const s = createSpecPromptState();
    const c1 = cand({ path: "/r/a.md" });
    const c2 = cand({ path: "/r/b.md" });
    s.recordCandidate(c1, 0);
    s.recordCandidate(c2, 9 * 60 * 1000);

    const pending = s.getPendingForTab(
      tab(),
      [tab()],
      10 * 60 * 1000 - 1,
    );
    expect(pending.map((c) => c.path).sort()).toEqual(["/r/a.md", "/r/b.md"]);
  });

  it("getPendingForTab drops candidates older than 10 min", () => {
    const s = createSpecPromptState();
    const c = cand();
    s.recordCandidate(c, 0);
    const pending = s.getPendingForTab(tab(), [tab()], 11 * 60 * 1000);
    expect(pending).toEqual([]);
  });

  it("getPendingForTab excludes dismissed", () => {
    const s = createSpecPromptState();
    const c = cand();
    s.recordCandidate(c, 0);
    s.dismiss("t1", c.path);
    const pending = s.getPendingForTab(tab(), [tab()], 1000);
    expect(pending).toEqual([]);
  });

  it("acceptOnTab clears the candidate from pending for that tab", () => {
    const s = createSpecPromptState();
    const c = cand();
    s.recordCandidate(c, 0);
    s.acceptOnTab("t1", c.path);
    const pending = s.getPendingForTab(tab(), [tab()], 1000);
    expect(pending).toEqual([]);
  });
});
