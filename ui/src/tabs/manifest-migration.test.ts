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

  it("preserves a new-shape tab structure (backfills top-level from pane[0])", () => {
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
    // panes and layout are untouched
    expect(lifted.panes).toHaveLength(2);
    expect(lifted.layout).toEqual({ kind: "split", orientation: "horizontal", active: 1, ratio: 0.6 });
    // top-level cwd is backfilled from pane[0]
    expect(lifted.cwd).toBe("/a");
    // replay_key backfilled from pane[0]
    expect(lifted.replay_key).toBe("r0");
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

  it("backfills top-level scalars from pane[0] when panes is present", () => {
    const newFormat: SerializedTab = {
      kind: "shell",
      custom_name: null,
      cwd: null,            // serializeTab writes null
      color: null,
      group_id: null,
      mission_path: null,
      operator_id: null,
      panes: [
        { id: "p0", kind: "terminal", cwd: "/repo", mission_path: "docs/specs/foo.md", operator_id: "claude", replay_key: "rk-p0", observer_ids: ["codex"], spawn_id: "spawn-1", aom_excluded: true },
      ],
      layout: { kind: "single", active: 0 },
    };
    const lifted = liftLegacyTab(newFormat);
    // top-level should now mirror pane[0]
    expect(lifted.cwd).toBe("/repo");
    expect(lifted.mission_path).toBe("docs/specs/foo.md");
    expect(lifted.operator_id).toBe("claude");
    expect(lifted.replay_key).toBe("rk-p0");
    expect(lifted.observer_ids).toEqual(["codex"]);
    expect(lifted.spawn_id).toBe("spawn-1");
    expect(lifted.aom_excluded).toBe(true);
    // panes stays intact
    expect(lifted.panes).toHaveLength(1);
  });

  it("does not override top-level when both are present", () => {
    const mixed: SerializedTab = {
      kind: "shell",
      custom_name: null,
      cwd: "/explicit",      // explicit non-null
      color: null,
      group_id: null,
      mission_path: null,
      operator_id: null,
      panes: [{ id: "p0", kind: "terminal", cwd: "/from-pane", mission_path: null, operator_id: null, replay_key: "" }],
      layout: { kind: "single", active: 0 },
    };
    const lifted = liftLegacyTab(mixed);
    expect(lifted.cwd).toBe("/explicit"); // top-level wins via ??
  });
});
