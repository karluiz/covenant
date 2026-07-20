// Pure, testable pieces of the Context Crawler view. Rendering itself is not
// under test — these are the functions whose answers are load-bearing for
// what the user is shown and what a write is armed against.
import { describe, it, expect } from "vitest";
import { inventoryKinds, stateHint, overwriteTargets } from "./view";
import {
  applyStates, createMinerState, reduceMinerEvent, setFindingStatus, setUnitSelected,
  selectedUnits, unitTarget, type MinerState, type UnitRow,
} from "./state";
import type { MinerEvent } from "../../api";

const unitEv = (id: string, kind: string, name: string) =>
  ({ kind: "unit_proposed", id, unit: { kind, name, summary: "A summary." } }) as MinerEvent;
const findingEv = (id: string, unit: string, title: string, kind: string) =>
  ({
    kind: "finding", id,
    finding: { unit, category: "convention", title, bodyMd: "Do it.", evidence: [], confidence: "high", kind },
  }) as MinerEvent;

const row = (over: Partial<UnitRow>): UnitRow => ({
  id: "skill:a", slug: "a", kind: "skill", name: "A", summary: "",
  findings: [], state: "new", selected: false, ...over,
});

/** One proposed unit with one accepted finding, resolved to `state`. */
function armedState(state: "new" | "exists" | "changed", name = "A"): MinerState {
  const s = createMinerState();
  reduceMinerEvent(s, unitEv("u1", "skill", name));
  reduceMinerEvent(s, findingEv("f1", name, "one", "skill"));
  setFindingStatus(s, "f1", "accepted");
  applyStates(s, { states: [{ kind: "skill", slug: name.toLowerCase(), state }], detected: [] });
  setUnitSelected(s, `skill:${name.toLowerCase()}`, true);
  return s;
}

describe("unitTarget", () => {
  it("maps every kind the crawler proposes to its Canon source path", () => {
    expect(unitTarget("skill", "a")).toBe(".covenant/canon/skills/a/");
    expect(unitTarget("memory", "a")).toBe(".covenant/canon/memory/a.md");
    expect(unitTarget("command", "a")).toBe(".covenant/canon/commands/a.md");
    expect(unitTarget("subagent", "a")).toBe(".covenant/canon/agents/a.md");
  });

  it("routes mcp to Canon's own mcp source, not the memory fallthrough", () => {
    expect(unitTarget("mcp", "ctx7")).toBe(".covenant/canon/mcp/ctx7.json");
    expect(unitTarget("mcp", "ctx7")).not.toContain("memory");
  });

  it("returns empty for an unknown kind rather than a plausible wrong path", () => {
    expect(unitTarget("spec", "a")).toBe("");
    expect(unitTarget("", "a")).toBe("");
  });
});

describe("inventoryKinds", () => {
  it("is KIND_ORDER alone when nothing exotic was surfaced", () => {
    expect(inventoryKinds([row({})])).toEqual(["skill", "memory", "command", "subagent"]);
  });

  it("appends off-KIND_ORDER kinds once each, after the ordered groups", () => {
    const units = [
      row({ id: "mcp:x", kind: "mcp", slug: "x" }),
      row({ id: "mcp:y", kind: "mcp", slug: "y" }),
      row({ id: "skill:a" }),
    ];
    expect(inventoryKinds(units)).toEqual(["skill", "memory", "command", "subagent", "mcp"]);
  });
});

describe("stateHint", () => {
  it("names the destination for a resolvable state", () => {
    expect(stateHint(row({ state: "new" }))).toContain(".covenant/canon/skills/a/");
    expect(stateHint(row({ state: "changed" }))).toContain("OVERWRITES");
  });

  it("says where a detected item was found", () => {
    expect(stateHint(row({ state: "detected", detectedIn: ".claude/skills" })))
      .toContain(".claude/skills");
    expect(stateHint(row({ state: "detected" }))).toBe("Foreign item, no Canon source");
  });

  it("admits an unknown row was never checked and cannot be written", () => {
    const hint = stateHint(row({ state: "unknown" }));
    expect(hint).toContain("never verified");
    expect(hint).toContain("cannot be written");
  });
});

describe("the unknown state is not selectable", () => {
  it("setUnitSelected refuses to arm it", () => {
    const s = armedState("new");
    expect(s.units[0].selected).toBe(true);
    s.units[0].state = "unknown";
    s.units[0].selected = false;
    setUnitSelected(s, "skill:a", true);
    expect(s.units[0].selected).toBe(false);
  });

  it("keeps the unit out of the write payload", () => {
    const s = armedState("new");
    expect(selectedUnits(s)).toHaveLength(1);
    s.units[0].state = "unknown";
    expect(selectedUnits(s)).toHaveLength(0);
  });

  it("still allows deselecting (the guard is one-way)", () => {
    const s = armedState("new");
    s.units[0].state = "unknown";
    setUnitSelected(s, "skill:a", false);
    expect(s.units[0].selected).toBe(false);
  });
});

describe("overwriteTargets", () => {
  it("is empty for a brand-new unit — creating is not overwriting", () => {
    expect(overwriteTargets(armedState("new"))).toHaveLength(0);
  });

  it("counts a checked row that already exists in Canon", () => {
    const out = overwriteTargets(armedState("changed"));
    expect(out.map((u) => u.name)).toEqual(["A"]);
  });

  it("ignores a row whose findings never reach the payload", () => {
    // `exists`, checked, but every finding discarded: selectedUnits drops the
    // unit, so nothing is written and nothing is overwritten.
    const s = armedState("exists");
    setFindingStatus(s, "f1", "discarded");
    expect(selectedUnits(s)).toHaveLength(0);
    expect(overwriteTargets(s)).toHaveLength(0);
  });

  it("ignores an unchecked row that exists in Canon", () => {
    const s = armedState("exists");
    setUnitSelected(s, "skill:a", false);
    expect(overwriteTargets(s)).toHaveLength(0);
  });

  it("never counts a detected row — Adopt is its only verb", () => {
    const s = armedState("exists");
    applyStates(s, {
      states: [],
      detected: [{ kind: "skill", name: "Foreign", summary: null, detectedIn: ".claude/skills" }],
    });
    const detected = s.units.find((u) => u.name === "Foreign");
    expect(detected?.state).toBe("detected");
    expect(overwriteTargets(s).map((u) => u.name)).toEqual(["A"]);
  });
});
