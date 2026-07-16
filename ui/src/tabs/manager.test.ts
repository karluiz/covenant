import { describe, expect, it, beforeAll, vi } from "vitest";
import { TabManager, type TabManifestV1 } from "./manager";

// activate() reports the new active tab to the backend; jsdom has no Tauri
// IPC bridge, so stub it out. Nothing here asserts on backend calls.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: () => Promise.resolve(),
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
