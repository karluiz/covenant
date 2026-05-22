import { describe, it, expect, beforeEach } from "vitest";
import { ActivityTracker, type BlockFinishedEvent } from "./activity";

describe("ActivityTracker", () => {
  let t: ActivityTracker;
  beforeEach(() => {
    t = new ActivityTracker();
  });

  it("starts empty", () => {
    expect(t.state).toEqual({ unseenBlocks: 0, hasFailure: false, hasAgentNote: false });
  });

  it("increments on a successful block", () => {
    t.recordBlock({ exitCode: 0 });
    expect(t.state.unseenBlocks).toBe(1);
    expect(t.state.hasFailure).toBe(false);
  });

  it("flags failure on non-zero exit and keeps counter", () => {
    t.recordBlock({ exitCode: 0 });
    t.recordBlock({ exitCode: 1 });
    expect(t.state).toEqual({ unseenBlocks: 2, hasFailure: true, hasAgentNote: false });
  });

  it("notes agent action", () => {
    t.recordAgentNote();
    expect(t.state.hasAgentNote).toBe(true);
  });

  it("reset() clears everything", () => {
    t.recordBlock({ exitCode: 1 });
    t.recordAgentNote();
    t.reset();
    expect(t.state).toEqual({ unseenBlocks: 0, hasFailure: false, hasAgentNote: false });
  });

  it("emits change events", () => {
    const calls: ActivityTracker["state"][] = [];
    t.onChange((s) => calls.push({ ...s }));
    t.recordBlock({ exitCode: 0 });
    t.recordBlock({ exitCode: 2 });
    t.reset();
    expect(calls.length).toBe(3);
    expect(calls[2]).toEqual({ unseenBlocks: 0, hasFailure: false, hasAgentNote: false });
  });
});

// keep the BlockFinishedEvent type import used (lint).
const _unused: BlockFinishedEvent | undefined = undefined;
void _unused;
