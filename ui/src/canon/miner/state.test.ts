import { describe, expect, it } from "vitest";
import {
  acceptedFindings,
  compilePreview,
  createMinerState,
  editFindingBody,
  reduceMinerEvent,
  setFindingStatus,
} from "./state";
import type { MinerEvent } from "../../api";

const finding = (id: string, title: string, category = "convention"): MinerEvent => ({
  kind: "finding",
  id,
  finding: { category, title, bodyMd: `Do ${title}.`, evidence: ["src/a.rs:1"], confidence: "high" },
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

  it("compilePreview groups by category in fixed order", () => {
    const s = createMinerState();
    reduceMinerEvent(s, finding("f1", "trap", "gotcha"));
    reduceMinerEvent(s, finding("f2", "style", "convention"));
    setFindingStatus(s, "f1", "accepted");
    setFindingStatus(s, "f2", "accepted");
    const md = compilePreview("my-skill", s);
    expect(md.indexOf("## Conventions")).toBeGreaterThan(-1);
    expect(md.indexOf("## Conventions")).toBeLessThan(md.indexOf("## Gotchas"));
    expect(md).toContain("`src/a.rs:1`");
  });
});
