import { describe, expect, it } from "vitest";
import { liftLegacyTab, type SerializedTab } from "./manager";

describe("liftLegacyTab", () => {
  it("wraps a legacy single-pane tab into the new shape", () => {
    const legacy: SerializedTab = {
      kind: "shell",
      custom_name: "tests",
      cwd: "/repo",
      color: null,
      group_id: null,
      mission_path: "docs/specs/foo.md",
      operator_id: "claude",
      observer_ids: ["codex"],
      replay_key: "rk1",
    };
    const lifted = liftLegacyTab(legacy);
    expect(lifted.panes).toHaveLength(1);
    expect(lifted.panes![0].cwd).toBe("/repo");
    expect(lifted.panes![0].mission_path).toBe("docs/specs/foo.md");
    expect(lifted.panes![0].operator_id).toBe("claude");
    expect(lifted.panes![0].replay_key).toBe("rk1");
    expect(lifted.layout).toEqual({ kind: "single", active: 0 });
  });

  it("leaves a new-shape tab unchanged", () => {
    const modern: SerializedTab = {
      kind: "shell",
      custom_name: null,
      cwd: null,
      color: null,
      group_id: null,
      mission_path: null,
      operator_id: null,
      panes: [
        { id: "p0", kind: "terminal", cwd: "/a", mission_path: null, operator_id: null, replay_key: "r0" },
        { id: "p1", kind: "terminal", cwd: "/b", mission_path: null, operator_id: null, replay_key: "r1" },
      ],
      layout: { kind: "split", orientation: "horizontal", active: 1, ratio: 0.6 },
    };
    const lifted = liftLegacyTab(modern);
    expect(lifted).toBe(modern);
  });

  it("wraps a legacy tab missing replay_key", () => {
    const legacy: SerializedTab = {
      kind: "shell",
      custom_name: null,
      cwd: "/home",
      color: null,
      group_id: null,
      mission_path: null,
      operator_id: null,
      // no replay_key — exercises the crypto.randomUUID() fallback
    };
    const lifted = liftLegacyTab(legacy);
    expect(lifted.panes).toHaveLength(1);
    expect(lifted.panes![0].replay_key).toBe("");
    expect(lifted.panes![0].id).toMatch(/^legacy-[0-9a-f-]+$/i);
  });

  it("heals a partial-shape tab (panes without layout)", () => {
    const partial: SerializedTab = {
      kind: "shell",
      custom_name: null,
      cwd: null,
      color: null,
      group_id: null,
      mission_path: null,
      operator_id: null,
      panes: [
        { id: "p0", kind: "terminal", cwd: "/preserved", mission_path: null, operator_id: null, replay_key: "rk-preserved" },
      ],
      // no layout
    };
    const lifted = liftLegacyTab(partial);
    expect(lifted.panes).toHaveLength(1);
    expect(lifted.panes![0].cwd).toBe("/preserved");     // original pane preserved
    expect(lifted.panes![0].replay_key).toBe("rk-preserved");
    expect(lifted.layout).toEqual({ kind: "single", active: 0 });
  });
});
