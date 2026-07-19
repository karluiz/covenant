import { describe, expect, it, beforeAll, vi } from "vitest";
import { TabManager, applyInferredTitle, shouldRetire, type TabManifestV1 } from "./manager";

// activate() reports the new active tab to the backend; jsdom has no Tauri
// IPC bridge, so stub it out. Kept as a vi.fn() (via vi.hoisted, since
// vi.mock factories are hoisted above imports) so worktree-retirement tests
// can assert which backend commands actually fired.
const mocks = vi.hoisted(() => ({
  invoke: vi.fn((_cmd: string, ..._args: unknown[]) => Promise.resolve(undefined)),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
  Channel: class {
    onmessage: ((d: unknown) => void) | null = null;
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: () => Promise.resolve(() => {}),
  emit: () => Promise.resolve(),
}));

// jsdom doesn't implement matchMedia; TabManager's constructor arms a
// DPR-change listener via matchMedia unconditionally, so it throws on
// `new TabManager(...)` without this polyfill (no other test in this
// repo constructs the real class — this is the only file that does).
beforeAll(() => {
  if (typeof window.matchMedia !== "function") {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }
});

// Minimal harness: TabManager's constructor only needs real DOM nodes
// (no xterm/Tauri setup happens until a tab is actually spawned).
function makeManager(): TabManager {
  const tabbarHost = document.createElement("div");
  const workspace = document.createElement("div");
  const newTabBtn = document.createElement("button");
  document.body.appendChild(tabbarHost);
  document.body.appendChild(workspace);
  return new TabManager(tabbarHost, workspace, newTabBtn, () => {});
}

describe("TabManager group active-org persistence", () => {
  it("groupCanonOrg defaults to null and setGroupCanonOrg updates it", () => {
    const m = makeManager();
    const groupId = m.createEmptyGroup();
    expect(m.groupCanonOrg(groupId)).toBeNull();
    m.setGroupCanonOrg(groupId, "cleverit");
    expect(m.groupCanonOrg(groupId)).toBe("cleverit");
  });

  it("serializeManifest emits canon_org for a group with an active org set", () => {
    const m = makeManager();
    const groupId = m.createEmptyGroup();
    m.setGroupCanonOrg(groupId, "cleverit");
    const manifest = m.serializeManifest();
    const g = manifest.groups.find((x) => x.id === groupId);
    expect(g?.canon_org).toBe("cleverit");
  });

  it("restoreFromManifest hydrates a group's canon_org back into canonOrg", async () => {
    const groupId = "g1";
    const manifest: TabManifestV1 = {
      version: 1,
      active_index: 0,
      // restoreFromManifest bails out to a fresh blank tab when tabs is
      // empty, so a tab referencing the group is required to reach the
      // group-hydration code path at all.
      tabs: [
        {
          kind: "shell",
          custom_name: null,
          cwd: null,
          color: null,
          group_id: groupId,
          mission_path: null,
          operator_id: null,
        },
      ],
      groups: [
        { id: groupId, name: "grp", color: null, collapsed: false, root_dir: null, canon_org: "cleverit" },
      ],
    };
    const restored = makeManager();
    try {
      // Group hydration runs synchronously before the (real) PTY spawn
      // is awaited, so it's already applied by the time this rejects —
      // xterm.js can't render without a canvas backend under jsdom, so
      // the tab-spawn half of restore is expected to throw here; that's
      // an existing environment limitation unrelated to this feature.
      await restored.restoreFromManifest(manifest);
    } catch {
      // expected under jsdom — see comment above.
    }
    expect(restored.groupCanonOrg(groupId)).toBe("cleverit");
  });
});

describe("TabManager setActivePill fast path", () => {
  it("moves .active to the target pill and reports false when the pill is absent", () => {
    const m = makeManager();
    const host = (m as unknown as { tabbarHost: HTMLElement }).tabbarHost;
    const a = document.createElement("div");
    a.className = "tab-btn active";
    a.dataset.tabId = "a";
    const b = document.createElement("div");
    b.className = "tab-btn";
    b.dataset.tabId = "b";
    host.append(a, b);

    const setActivePill = (m as unknown as { setActivePill: (id: string) => boolean })
      .setActivePill.bind(m);

    // Switching to an existing pill moves the highlight in place.
    expect(setActivePill("b")).toBe(true);
    expect(a.classList.contains("active")).toBe(false);
    expect(b.classList.contains("active")).toBe(true);
    expect(host.querySelectorAll(".tab-btn.active").length).toBe(1);

    // Target not painted yet (new tab) → caller must fall back to a full render.
    expect(setActivePill("ghost")).toBe(false);
    // A failed lookup leaves the strip untouched rather than clearing it.
    expect(b.classList.contains("active")).toBe(true);
  });
});

describe("TabManager closing the active tab sweeps its pill", () => {
  // Regression: 48bc3565 made activate() swap the .active class in place
  // instead of re-rendering the strip. That fast path assumes the strip's
  // structure is unchanged — true on a tab switch, false right after a
  // close, where finalizeCloseTab splices the tab out and then activates a
  // neighbour. The closed tab's pill then survived in the DOM until some
  // unrelated later renderTabbar() swept it, so users saw the closed tab
  // linger in the sidebar for seconds.
  it("leaves no pill behind for a tab removed from this.tabs", () => {
    const m = makeManager();
    const priv = m as unknown as {
      tabs: Array<Record<string, unknown>>;
      renderTabbar: () => void;
      activeId: string | null;
      tabbarHost: HTMLElement;
    };
    const fakeTab = (id: string): Record<string, unknown> => ({
      id,
      groupId: null,
      kind: "shell",
      pane: document.createElement("div"),
      panes: [
        {
          kind: "shell",
          sessionId: null,
          cwd: "/tmp",
          el: null,
          xterm: null,
          operator: null,
          observer_ids: [],
        },
      ],
      layout: { kind: "single", activePaneIdx: 0 },
      disposers: [],
    });
    priv.tabs.push(fakeTab("a"), fakeTab("b"));
    priv.renderTabbar.call(m);
    expect(priv.tabbarHost.querySelectorAll(".tab-btn").length).toBe(2);

    // "a" is the ACTIVE tab — the case users hit with ⌘W. A null sessionId
    // keeps closeTab on its synchronous path (no mind-preview round-trip).
    priv.activeId = "a";
    m.closeTab("a");

    const ids = Array.from(priv.tabbarHost.querySelectorAll<HTMLElement>(".tab-btn"))
      .map((el) => el.dataset.tabId);
    expect(ids).not.toContain("a");
    expect(ids).toEqual(["b"]);
  });

  it("leaves no pill behind when the closed active tab is a browser tab", () => {
    const m = makeManager();
    const priv = m as unknown as {
      tabs: Array<Record<string, unknown>>;
      renderTabbar: () => void;
      activeId: string | null;
      tabbarHost: HTMLElement;
    };
    const fakeTab = (id: string, kind: string): Record<string, unknown> => ({
      id,
      groupId: null,
      kind,
      pane: document.createElement("div"),
      panes: [
        {
          kind: "shell",
          sessionId: null,
          cwd: "/tmp",
          el: null,
          xterm: null,
          operator: null,
          observer_ids: [],
        },
      ],
      layout: { kind: "single", activePaneIdx: 0 },
      disposers: [],
    });
    priv.tabs.push(fakeTab("web", "browser"), fakeTab("b", "shell"));
    priv.renderTabbar.call(m);
    priv.activeId = "web";
    m.closeTab("web");

    const ids = Array.from(priv.tabbarHost.querySelectorAll<HTMLElement>(".tab-btn"))
      .map((el) => el.dataset.tabId);
    expect(ids).toEqual(["b"]);
  });
});

describe("TabManager disposeHibernated leaves the live strip intact", () => {
  // disposeHibernated swaps the hibernated stash into this.tabs so each
  // stashed tab can go through the real finalizeCloseTab teardown, then
  // restores the live tabs. finalizeCloseTab renders the strip as it goes,
  // so by the last stashed tab the strip has been painted from an EMPTY
  // this.tabs — and nothing repaints it after `live` is put back.
  it("repaints the live tabs after tearing down a hibernated workspace", () => {
    const m = makeManager();
    const priv = m as unknown as {
      tabs: Array<Record<string, unknown>>;
      renderTabbar: () => void;
      activeId: string | null;
      tabbarHost: HTMLElement;
      hibernated: Map<string, { tabs: unknown[]; groups: Map<string, unknown>; activeId: string | null }>;
    };
    const fakeTab = (id: string): Record<string, unknown> => ({
      id,
      groupId: null,
      kind: "shell",
      pane: document.createElement("div"),
      panes: [
        {
          kind: "shell",
          sessionId: null,
          cwd: "/tmp",
          el: null,
          xterm: null,
          operator: null,
          observer_ids: [],
        },
      ],
      layout: { kind: "single", activePaneIdx: 0 },
      disposers: [],
    });

    const live = fakeTab("live");
    priv.tabs.push(live);
    priv.activeId = "live";
    priv.renderTabbar.call(m);
    expect(
      Array.from(priv.tabbarHost.querySelectorAll<HTMLElement>(".tab-btn")).map(
        (el) => el.dataset.tabId,
      ),
    ).toEqual(["live"]);

    priv.hibernated.set("ws-old", {
      tabs: [fakeTab("stashed")],
      groups: new Map(),
      activeId: "stashed",
    });
    m.disposeHibernated("ws-old");

    // The live tab is still in the model...
    expect(priv.tabs.map((t) => t.id)).toEqual(["live"]);
    // ...so the sidebar must still show it.
    expect(
      Array.from(priv.tabbarHost.querySelectorAll<HTMLElement>(".tab-btn")).map(
        (el) => el.dataset.tabId,
      ),
    ).toEqual(["live"]);
  });
});

describe("worktree retirement on tab close", () => {
  it("does not retire a worktree another tab is still standing in", async () => {
    const occupied = ["/repo/.covenant/worktrees/agent-codex-0719-aaa"];
    expect(shouldRetire("/repo/.covenant/worktrees/agent-codex-0719-aaa", occupied)).toBe(false);
  });

  it("retires a worktree no remaining tab occupies", () => {
    expect(shouldRetire("/repo/.covenant/worktrees/agent-codex-0719-aaa", ["/repo"])).toBe(true);
  });

  it("treats a nested cwd as occupying the worktree", () => {
    // The agent cd'd into a subdirectory; the worktree is still in use.
    const occupied = ["/repo/.covenant/worktrees/agent-codex-0719-aaa/crates/app"];
    expect(shouldRetire("/repo/.covenant/worktrees/agent-codex-0719-aaa", occupied)).toBe(false);
  });

  it("never retires when the closing tab has no cwd", () => {
    expect(shouldRetire(null, [])).toBe(false);
  });
});

function fakePane(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "shell",
    sessionId: null,
    cwd: "/tmp",
    el: null,
    xterm: null,
    operator: null,
    observer_ids: [],
    ...overrides,
  };
}

function retireCalls(): unknown[][] {
  return mocks.invoke.mock.calls.filter(([cmd]) => cmd === "worktree_retire");
}

describe("worktree retirement occupancy covers every pane, not just active", () => {
  // finalizeCloseTab builds its occupancy list to feed shouldRetire(). If
  // that list only reflects each remaining tab's ACTIVE pane, a background
  // (non-active) pane standing in the closing worktree is invisible and the
  // backend genuinely deletes the directory out from under that live shell.
  it("does not retire when a remaining tab's NON-active pane occupies the worktree", () => {
    const m = makeManager();
    const priv = m as unknown as {
      tabs: Array<Record<string, unknown>>;
      activeId: string | null;
    };
    const worktree = "/repo/.covenant/worktrees/agent-codex-0719-aaa";

    // Split tab "bg": pane[0] (ACTIVE) sits elsewhere in the repo; pane[1]
    // (background, NOT active) is cd'd into the worktree about to close.
    const bgTab = {
      id: "bg",
      groupId: null,
      kind: "shell",
      pane: document.createElement("div"),
      panes: [fakePane({ cwd: "/repo" }), fakePane({ cwd: worktree })],
      layout: { kind: "split", orientation: "vertical", activePaneIdx: 0 },
      disposers: [],
    };
    // Tab "closer" is the one actually closing; its cwd is the worktree.
    const closerTab = {
      id: "closer",
      groupId: null,
      kind: "shell",
      pane: document.createElement("div"),
      panes: [fakePane({ cwd: worktree })],
      layout: { kind: "single", activePaneIdx: 0 },
      disposers: [],
    };
    priv.tabs.push(bgTab, closerTab);
    priv.activeId = "closer";

    mocks.invoke.mockClear();
    m.closeTab("closer");

    expect(retireCalls()).toHaveLength(0);
  });

  it("still retires when no remaining pane (active or background) occupies the worktree", () => {
    const m = makeManager();
    const priv = m as unknown as {
      tabs: Array<Record<string, unknown>>;
      activeId: string | null;
    };
    const worktree = "/repo/.covenant/worktrees/agent-codex-0719-ccc";

    const bgTab = {
      id: "bg",
      groupId: null,
      kind: "shell",
      pane: document.createElement("div"),
      panes: [fakePane({ cwd: "/repo" }), fakePane({ cwd: "/repo/other" })],
      layout: { kind: "split", orientation: "vertical", activePaneIdx: 0 },
      disposers: [],
    };
    const closerTab = {
      id: "closer",
      groupId: null,
      kind: "shell",
      pane: document.createElement("div"),
      panes: [fakePane({ cwd: worktree })],
      layout: { kind: "single", activePaneIdx: 0 },
      disposers: [],
    };
    priv.tabs.push(bgTab, closerTab);
    priv.activeId = "closer";

    mocks.invoke.mockClear();
    m.closeTab("closer");

    const calls = retireCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1]).toEqual({ cwd: worktree, path: worktree });
  });
});

describe("worktree retirement respects the inReplace guard", () => {
  // The previous wave added `this.inReplace ||` to the retirement guard so
  // that workspace-switch teardown (moveGroupTo, replaceFromManifest,
  // disposeHibernated) never retires a worktree a respawn is about to reuse.
  // That divergence from the original brief had zero regression coverage.
  it("retires on an ordinary close (inReplace false)", () => {
    const m = makeManager();
    const priv = m as unknown as {
      tabs: Array<Record<string, unknown>>;
      activeId: string | null;
      inReplace: boolean;
    };
    const worktree = "/repo/.covenant/worktrees/agent-codex-0719-ddd";
    const closerTab = {
      id: "closer",
      groupId: null,
      kind: "shell",
      pane: document.createElement("div"),
      panes: [fakePane({ cwd: worktree })],
      layout: { kind: "single", activePaneIdx: 0 },
      disposers: [],
    };
    priv.tabs.push(closerTab);
    priv.activeId = "closer";
    priv.inReplace = false;

    mocks.invoke.mockClear();
    m.closeTab("closer");

    const calls = retireCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1]).toEqual({ cwd: worktree, path: worktree });
  });

  it("does not retire during workspace-switch teardown (inReplace true)", () => {
    const m = makeManager();
    const priv = m as unknown as {
      tabs: Array<Record<string, unknown>>;
      activeId: string | null;
      inReplace: boolean;
    };
    const worktree = "/repo/.covenant/worktrees/agent-codex-0719-eee";
    const closerTab = {
      id: "closer",
      groupId: null,
      kind: "shell",
      pane: document.createElement("div"),
      panes: [fakePane({ cwd: worktree })],
      layout: { kind: "single", activePaneIdx: 0 },
      disposers: [],
    };
    priv.tabs.push(closerTab);
    priv.activeId = "closer";
    priv.inReplace = true;

    mocks.invoke.mockClear();
    m.closeTab("closer");

    expect(retireCalls()).toHaveLength(0);
  });
});

describe("inferred title -> branch rename", () => {
  const tab = (cwd: string) => ({ defaultTitle: null as string | null, panes: [{ cwd }] });

  it("sets the title and repaints before any git work", () => {
    const t = tab("/repo/.covenant/worktrees/agent-claude-0719-y72");
    let painted = false;
    applyInferredTitle(t, "  Worktree prevention  ", () => { painted = true; });
    // Trimmed, applied, and the tabbar repainted synchronously — the rename is
    // fire-and-forget and must never gate the visible update.
    expect(t.defaultTitle).toBe("Worktree prevention");
    expect(painted).toBe(true);
  });

  it("ignores an empty title without touching the tab", () => {
    const t = tab("/repo/.covenant/worktrees/agent-claude-0719-y72");
    t.defaultTitle = "kept";
    let painted = false;
    applyInferredTitle(t, "   ", () => { painted = true; });
    expect(t.defaultTitle).toBe("kept");
    expect(painted).toBe(false);
  });

  it("still applies the title when the tab has no cwd to rename against", () => {
    const t = tab("");
    applyInferredTitle(t, "No cwd", () => {});
    expect(t.defaultTitle).toBe("No cwd");
  });
});
