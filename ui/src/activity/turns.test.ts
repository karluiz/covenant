import { describe, expect, it } from "vitest";

import { TurnAggregator, liveTail, type PhasePush } from "./turns";
import type { ExecutorPhase } from "../../notch/store";

function push(agg: TurnAggregator, session: string, phase: ExecutorPhase, now: number, tokens = 0): void {
  const p: PhasePush = { session, tag: `tab-${session}`, agent: "claude", phase, tokens };
  agg.push(p, now);
}

describe("TurnAggregator", () => {
  it("folds a thinking metronome into one turn with no thinking events", () => {
    const agg = new TurnAggregator();
    let t = 1000;
    // Heartbeats: thinking every 3s, interleaved with a couple of reads.
    for (let i = 0; i < 10; i++) push(agg, "s1", { kind: "thinking" }, (t += 3000), 100);
    push(agg, "s1", { kind: "reading", file: "a.rs" }, (t += 100));
    for (let i = 0; i < 5; i++) push(agg, "s1", { kind: "thinking" }, (t += 3000), 100);
    push(agg, "s1", { kind: "reading", file: "b.rs" }, (t += 100));
    push(agg, "s1", { kind: "reading", file: "a.rs" }, (t += 100));

    expect(agg.turns).toHaveLength(1);
    const turn = agg.turns[0];
    expect(turn.events).toHaveLength(0);
    expect(turn.readFiles.size).toBe(2);
    expect(turn.tokens).toBe(1500);
    expect(turn.status).toBe("live");
    expect(liveTail(turn)).toBe("thinking");
  });

  it("records meaningful events and merges consecutive heartbeat repeats", () => {
    const agg = new TurnAggregator();
    let t = 0;
    push(agg, "s1", { kind: "running", cmd: "cargo test" }, (t += 1));
    // Heartbeat re-emits of the same running phase — merged, no dup.
    push(agg, "s1", { kind: "running", cmd: "cargo test" }, (t += 3000));
    push(agg, "s1", { kind: "running", cmd: "cargo test" }, (t += 3000));
    push(agg, "s1", { kind: "writing", file: "notch.rs" }, (t += 1));
    push(agg, "s1", { kind: "running", cmd: "cargo test" }, (t += 1));
    push(agg, "s1", { kind: "waiting", reason: "needs input" }, (t += 1));

    const turn = agg.turns[0];
    expect(turn.events.map((e) => e.label)).toEqual([
      "running cargo test",
      "writing notch.rs",
      "running cargo test",
      "waiting · needs input",
    ]);
    expect(turn.waiting).toBe(true);
    expect(liveTail(turn)).toBe("waiting · needs input");
  });

  it("closes a turn on done and opens a fresh one on the next activity", () => {
    const agg = new TurnAggregator();
    push(agg, "s1", { kind: "thinking" }, 1000);
    push(agg, "s1", { kind: "done", summary: "fixed the bug" }, 2000);

    expect(agg.turns).toHaveLength(1);
    expect(agg.turns[0].status).toBe("done");
    expect(agg.turns[0].endedAt).toBe(2000);
    expect(liveTail(agg.turns[0])).toBe("done · fixed the bug");

    push(agg, "s1", { kind: "thinking" }, 3000);
    expect(agg.turns).toHaveLength(2);
    expect(agg.turns[1].status).toBe("live");
  });

  it("freezes a turn as ended when the session goes idle without done", () => {
    const agg = new TurnAggregator();
    push(agg, "s1", { kind: "thinking" }, 1000);
    push(agg, "s1", { kind: "idle" }, 2000);
    expect(agg.turns[0].status).toBe("ended");
    // Idle/done with no live turn (startup replay) creates nothing.
    push(agg, "s2", { kind: "idle" }, 3000);
    push(agg, "s3", { kind: "done" }, 3000);
    expect(agg.turns).toHaveLength(1);
  });

  it("keeps sessions separate and caps history at 30 turns", () => {
    const agg = new TurnAggregator();
    push(agg, "a", { kind: "thinking" }, 1);
    push(agg, "b", { kind: "running", cmd: "ls" }, 2);
    expect(agg.turns).toHaveLength(2);

    for (let i = 0; i < 40; i++) {
      push(agg, `s${i}`, { kind: "thinking" }, 10 + i);
      push(agg, `s${i}`, { kind: "done" }, 50 + i);
    }
    expect(agg.turns).toHaveLength(30);
    // Evicted live turns must not keep aggregating into the map.
    push(agg, "a", { kind: "running", cmd: "pwd" }, 1000);
    expect(agg.turns.filter((t) => t.session === "a")).toHaveLength(1);
  });

  it("caps events per turn at 50 and flags the drop", () => {
    const agg = new TurnAggregator();
    for (let i = 0; i < 60; i++) {
      push(agg, "s1", { kind: "running", cmd: `cmd-${i}` }, i);
    }
    const turn = agg.turns[0];
    expect(turn.events).toHaveLength(50);
    expect(turn.eventsDropped).toBe(true);
    expect(turn.events[0].label).toBe("running cmd-10");
  });
});
