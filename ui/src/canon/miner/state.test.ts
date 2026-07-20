import { describe, it, expect } from "vitest";
import type { MinerEvent } from "../../api";
import {
  createMinerState, reduceMinerEvent, setUnitSelected, setUnitKind, setFindingStatus,
  selectedUnits, applyStates, compilePreview, slugify,
} from "./state";

const unitEv = (id: string, kind: string, name: string) =>
  ({ kind: "unit_proposed", id, unit: { kind, name, summary: "A summary." } }) as MinerEvent;
const findingEv = (id: string, unit: string, title: string) =>
  ({
    kind: "finding", id,
    finding: { unit, category: "convention", title, bodyMd: "Do it.", evidence: ["a.ts:1"], confidence: "high", kind: unitKindOf(unit) },
  }) as MinerEvent;
const unitKindOf = (unit: string) => (unit === "Retry budget" ? "memory" : "skill");

describe("crawler inventory state", () => {
  it("slugify matches the Rust rule", () => {
    expect(slugify("PTY Conventions")).toBe("pty-conventions");
    expect(slugify("Foo/Bar baz")).toBe("foo-bar-baz");
    expect(slugify("  edge  ")).toBe("edge");
  });

  it("groups findings under their proposed unit", () => {
    const s = createMinerState();
    reduceMinerEvent(s, unitEv("u1", "skill", "PTY Conventions"));
    reduceMinerEvent(s, findingEv("f1", "PTY Conventions", "one"));
    reduceMinerEvent(s, findingEv("f2", "PTY Conventions", "two"));
    expect(s.units).toHaveLength(1);
    expect(s.units[0].slug).toBe("pty-conventions");
    expect(s.units[0].findings).toHaveLength(2);
  });

  it("drops a finding whose unit was never proposed", () => {
    const s = createMinerState();
    reduceMinerEvent(s, findingEv("f1", "Ghost", "one"));
    expect(s.units).toHaveLength(0);
  });

  it("new units are selected, exists/detected are not", () => {
    const s = createMinerState();
    reduceMinerEvent(s, unitEv("u1", "skill", "A"));
    reduceMinerEvent(s, unitEv("u2", "skill", "B"));
    reduceMinerEvent(s, findingEv("f1", "A", "one"));
    reduceMinerEvent(s, findingEv("f2", "B", "two"));
    applyStates(s, {
      states: [
        { kind: "skill", slug: "a", state: "new" },
        { kind: "skill", slug: "b", state: "exists" },
      ],
      detected: [],
    });
    expect(s.units.find((u) => u.slug === "a")!.selected).toBe(true);
    expect(s.units.find((u) => u.slug === "b")!.selected).toBe(false);
  });

  it("selectedUnits only returns selected units with accepted findings", () => {
    const s = createMinerState();
    reduceMinerEvent(s, unitEv("u1", "skill", "A"));
    reduceMinerEvent(s, findingEv("f1", "A", "one"));
    reduceMinerEvent(s, findingEv("f2", "A", "two"));
    setUnitSelected(s, "skill:a", true);
    setFindingStatus(s, "f1", "accepted");
    setFindingStatus(s, "f2", "discarded");
    const out = selectedUnits(s);
    expect(out).toHaveLength(1);
    expect(out[0].findings).toHaveLength(1);
    expect(out[0].findings[0].title).toBe("one");
  });

  it("an unselected unit contributes nothing", () => {
    const s = createMinerState();
    reduceMinerEvent(s, unitEv("u1", "skill", "A"));
    reduceMinerEvent(s, findingEv("f1", "A", "one"));
    setFindingStatus(s, "f1", "accepted");
    setUnitSelected(s, "skill:a", false);
    expect(selectedUnits(s)).toHaveLength(0);
  });

  it("a re-routed unit's stale resolved state is deselected", () => {
    const s = createMinerState();
    reduceMinerEvent(s, unitEv("u1", "skill", "A"));
    reduceMinerEvent(s, findingEv("f1", "A", "one"));
    applyStates(s, { states: [{ kind: "skill", slug: "a", state: "new" }], detected: [] });
    expect(s.units.find((u) => u.slug === "a")!.selected).toBe(true);

    setUnitKind(s, "skill:a", "memory");
    const row = s.units.find((u) => u.slug === "a")!;
    expect(row.selected).toBe(false);
    expect(selectedUnits(s).find((u) => u.name === "A")).toBeUndefined();
  });

  it("preview groups by destination path", () => {
    const s = createMinerState();
    reduceMinerEvent(s, unitEv("u1", "skill", "A"));
    reduceMinerEvent(s, findingEv("f1", "A", "one"));
    setUnitSelected(s, "skill:a", true);
    setFindingStatus(s, "f1", "accepted");
    expect(compilePreview(s)).toContain(".covenant/canon/skills/a/");
  });
});
