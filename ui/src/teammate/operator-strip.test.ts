import { beforeEach, describe, expect, it } from "vitest";
import type { OperatorStatus } from "../api";
import { OperatorStrip, formatStripPhase, stripLineText } from "./operator-strip";

function status(over: Partial<OperatorStatus> = {}): OperatorStatus {
  return {
    sessionId: "s1",
    operatorId: "op1",
    operatorName: "Pi",
    operatorEmoji: "🟣",
    enabled: true,
    live: true,
    phase: "deciding",
    phaseSinceUnixMs: 0,
    mind: null,
    lastDecision: null,
    aom: null,
    mission: null,
    ...over,
  };
}

describe("formatStripPhase", () => {
  it("shows elapsed seconds for observing", () => {
    expect(formatStripPhase("observing", 4_200)).toBe("observing 4s");
  });
  it("collapses deciding to an ellipsis", () => {
    expect(formatStripPhase("deciding", 12_000)).toBe("deciding…");
  });
  it("idle for unknown/idle", () => {
    expect(formatStripPhase("idle", 0)).toBe("idle");
  });
});

describe("stripLineText", () => {
  it("formats emoji · name · phase with mission suffix", () => {
    const s = status({
      operatorName: "Zeta",
      operatorEmoji: "🟢",
      phase: "observing",
      phaseSinceUnixMs: 1_000,
      mission: { kind: "covenant", name: "feat-foo.md", tasksDone: null, tasksTotal: null },
    });
    expect(stripLineText(s, 5_000)).toBe("🟢 Zeta · observing 4s · feat-foo.md");
  });
  it("omits mission suffix when no mission", () => {
    expect(stripLineText(status({ phase: "deciding" }), 0)).toBe("🟣 Pi · deciding…");
  });
});

describe("OperatorStrip", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("renders one row per enabled session", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const strip = new OperatorStrip(host);
    strip.apply(status({ sessionId: "a", operatorName: "Pi" }));
    strip.apply(status({ sessionId: "b", operatorName: "Zeta", live: false }));
    expect(strip.count()).toBe(2);
    expect(host.querySelectorAll(".operator-strip__row").length).toBe(2);
    // Live session sorts first.
    const first = host.querySelector(".operator-strip__row") as HTMLElement;
    expect(first.dataset.session).toBe("a");
  });

  it("drops a session when its operator goes disabled", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const strip = new OperatorStrip(host);
    strip.apply(status({ sessionId: "a" }));
    expect(strip.count()).toBe(1);
    strip.apply(status({ sessionId: "a", enabled: false }));
    expect(strip.count()).toBe(0);
    expect(host.querySelector(".operator-strip")?.hasAttribute("hidden")).toBe(true);
  });

  it("updates a row in place on a new event for the same session", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const strip = new OperatorStrip(host);
    strip.apply(status({ sessionId: "a", phase: "observing", phaseSinceUnixMs: 1 }));
    strip.apply(status({ sessionId: "a", phase: "deciding" }));
    expect(strip.count()).toBe(1);
    const row = host.querySelector(".operator-strip__row") as HTMLElement;
    expect(row.dataset.phase).toBe("deciding");
  });

  it("remove() clears a session's row", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const strip = new OperatorStrip(host);
    strip.apply(status({ sessionId: "a" }));
    strip.remove("a");
    expect(strip.count()).toBe(0);
  });
});
