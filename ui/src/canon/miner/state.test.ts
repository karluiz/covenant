import { describe, expect, it } from "vitest";
import {
  acceptedFindings,
  compilePreview,
  createMinerState,
  editFindingBody,
  reduceMinerEvent,
  setFindingKind,
  setFindingStatus,
} from "./state";
import type { MinerEvent } from "../../api";

const finding = (id: string, title: string, category = "convention", kind = "skill"): MinerEvent => ({
  kind: "finding",
  id,
  finding: { category, title, bodyMd: `Do ${title}.`, evidence: ["src/a.rs:1"], confidence: "high", kind },
});

describe("reduceMinerEvent", () => {
  it("appends tool activity and pairs results by id", () => {
    const s = createMinerState();
    reduceMinerEvent(s, { kind: "tool_start", id: "t1", tool: "grep", arg: "{\"needle\":\"unwrap\"}" });
    reduceMinerEvent(s, { kind: "tool_result", id: "t1", summary: "12 hits", ok: true });
    expect(s.activity).toHaveLength(1);
    expect(s.activity[0].summary).toBe("12 hits");
  });

  it("collects findings as pending cards and flags done", () => {
    const s = createMinerState();
    reduceMinerEvent(s, finding("f1", "snake case"));
    reduceMinerEvent(s, { kind: "run_done", findingsTotal: 1, stopped: false });
    expect(s.findings[0].status).toBe("pending");
    expect(s.done).toBe(true);
    expect(s.stopped).toBe(false);
  });

  it("accept/edit/discard drive acceptedFindings with edits applied", () => {
    const s = createMinerState();
    reduceMinerEvent(s, finding("f1", "one"));
    reduceMinerEvent(s, finding("f2", "two"));
    setFindingStatus(s, "f1", "accepted");
    editFindingBody(s, "f1", "Edited body.");
    setFindingStatus(s, "f2", "discarded");
    const out = acceptedFindings(s);
    expect(out).toHaveLength(1);
    expect(out[0].bodyMd).toBe("Edited body.");
  });

  it("compilePreview groups accepted findings by destination kind", () => {
    const s = createMinerState();
    reduceMinerEvent(s, finding("f1", "trap", "gotcha", "memory"));
    reduceMinerEvent(s, finding("f2", "style", "convention", "skill"));
    setFindingStatus(s, "f1", "accepted");
    setFindingStatus(s, "f2", "accepted");
    const md = compilePreview("my-skill", s);
    expect(md.indexOf("Skill package")).toBeGreaterThan(-1);
    expect(md.indexOf("Skill package")).toBeLessThan(md.indexOf("Memory"));
    expect(md).toContain("`src/a.rs:1`");
  });
});

function seed() {
  const s = createMinerState();
  const ev: MinerEvent = { kind: "finding", id: "a", finding: { category: "domain_rule", title: "PEP", bodyMd: "x", evidence: [], confidence: "high", kind: "memory" } };
  reduceMinerEvent(s, ev);
  return s;
}

describe("miner kind routing", () => {
  it("carries kind from the finding event", () => {
    const s = seed();
    expect(s.findings[0].kind).toBe("memory");
  });
  it("re-routes a finding kind", () => {
    const s = seed();
    setFindingKind(s, "a", "subagent");
    expect(s.findings[0].kind).toBe("subagent");
  });
  it("accepted findings expose their kind", () => {
    const s = seed();
    setFindingStatus(s, "a", "accepted");
    expect(acceptedFindings(s)[0].kind).toBe("memory");
  });
});
