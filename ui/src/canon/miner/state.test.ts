import { describe, it, expect } from "vitest";
import type { MinerEvent } from "../../api";
import {
  createMinerState, reduceMinerEvent, setUnitSelected, setUnitKind, setFindingStatus,
  selectedUnits, applyStates, compilePreview, slugify, pendingUnits, editFindingBody,
} from "./state";

const unitEv = (id: string, kind: string, name: string) =>
  ({ kind: "unit_proposed", id, unit: { kind, name, summary: "A summary." } }) as MinerEvent;
const findingEv = (id: string, unit: string, title: string) =>
  ({
    kind: "finding", id,
    finding: { unit, category: "convention", title, bodyMd: "Do it.", evidence: ["a.ts:1"], confidence: "high", kind: unitKindOf(unit) },
  }) as MinerEvent;
const unitKindOf = (unit: string) => (unit === "Retry budget" ? "memory" : "skill");

/** Duplicated verbatim as `SLUG_CORPUS` in `crates/app/src/canon_miner.rs`,
 *  where the same list pins the two Rust implementations against each other.
 *  Keep the two in sync — one corpus, two languages. Drift between the three
 *  slug rules means the path a unit's state is RESOLVED against stops being
 *  the path it is WRITTEN to: the badge lies and the write clobbers. */
const SLUG_CORPUS: [string, string][] = [
  ["PTY Conventions", "pty-conventions"],
  ["retry budget", "retry-budget"],
  ["Foo/Bar baz", "foo-bar-baz"],
  ["  edge  ", "edge"],
  // Consecutive punctuation must collapse to a single dash.
  ["a!!!b", "a-b"],
  ["Rate limit -- per session", "rate-limit-per-session"],
  // Underscores are separators, not word characters.
  ["foo_bar_baz", "foo-bar-baz"],
  // Leading digits are legal in a slug.
  ["133 OSC markers", "133-osc-markers"],
  // Non-ASCII is dropped, and drops a separator in its place.
  ["café", "caf"],
  ["Ünïcödé", "n-c-d"],
  // Slugifies to empty — the case `write_md_entry` rejects outright.
  ["!!!", ""],
  ["…", ""],
  // Leading / trailing separators are trimmed off the result.
  [" -foo- ", "foo"],
  ["--a--", "a"],
];

describe("crawler inventory state", () => {
  it.each(SLUG_CORPUS)("slugify(%j) matches the Rust rule → %j", (input, want) => {
    expect(slugify(input)).toBe(want);
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

  it("marks a unit that came back with no state row as unknown, not new", () => {
    // The slug-drift failure: the backend resolved `pty-conventions` while the
    // frontend indexed the row under something else, so no row matches. Left
    // alone the unit keeps `unit_proposed`'s `new` + `selected` and is armed
    // for an unconditional write against a path nobody checked.
    const s = createMinerState();
    reduceMinerEvent(s, unitEv("u1", "skill", "A"));
    reduceMinerEvent(s, findingEv("f1", "A", "one"));
    setFindingStatus(s, "f1", "accepted");
    applyStates(s, { states: [{ kind: "skill", slug: "drifted", state: "new" }], detected: [] });
    const row = s.units.find((u) => u.slug === "a")!;
    expect(row.state).toBe("unknown");
    expect(row.selected).toBe(false);
    // And it is out of the write payload entirely.
    setUnitSelected(s, "skill:a", true);
    expect(selectedUnits(s)).toHaveLength(0);
  });

  it("leaves detected rows alone when nothing resolved", () => {
    const s = createMinerState();
    applyStates(s, {
      states: [],
      detected: [{ kind: "skill", name: "Foreign", summary: null, detectedIn: ".claude/skills" }],
    });
    expect(s.units[0].state).toBe("detected");
    // A second pass must not demote the detected row to unknown.
    applyStates(s, { states: [], detected: [] });
    expect(s.units[0].state).toBe("detected");
  });

  it("pendingUnits resolves the same bytes selectedUnits writes", () => {
    const s = createMinerState();
    reduceMinerEvent(s, unitEv("u1", "skill", "A"));
    reduceMinerEvent(s, findingEv("f1", "A", "one"));
    reduceMinerEvent(s, findingEv("f2", "A", "two"));
    // Nothing accepted yet: not writable, so nothing to resolve either.
    expect(pendingUnits(s)).toHaveLength(0);

    setFindingStatus(s, "f1", "discarded");
    setFindingStatus(s, "f2", "accepted");
    editFindingBody(s, "f2", "Edited body.");
    applyStates(s, { states: [{ kind: "skill", slug: "a", state: "new" }], detected: [] });

    // The discarded finding must not reach the resolver, and the edit must.
    expect(pendingUnits(s)).toEqual(selectedUnits(s));
    expect(pendingUnits(s)[0].findings.map((f) => f.title)).toEqual(["two"]);
    expect(pendingUnits(s)[0].findings[0].bodyMd).toBe("Edited body.");
  });

  it("pendingUnits slices a non-skill unit to the finding the backend renders", () => {
    // `render_unit` resolves `findings[0]`; `canon_compile_units` writes
    // `findings[0]`. Discarding the first accepted finding must move BOTH.
    const s = createMinerState();
    reduceMinerEvent(s, unitEv("u1", "memory", "Retry budget"));
    reduceMinerEvent(s, findingEv("f1", "Retry budget", "one"));
    reduceMinerEvent(s, findingEv("f2", "Retry budget", "two"));
    setFindingStatus(s, "f1", "discarded");
    setFindingStatus(s, "f2", "accepted");
    const sent = pendingUnits(s);
    expect(sent[0].findings).toHaveLength(1);
    expect(sent[0].findings[0].title).toBe("two");
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
