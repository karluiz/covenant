// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";

// --- Module-level stubs for Tauri-bound dependencies ---------------------
// bar.ts imports telegramStatus, getDirContext, etc. which call
// @tauri-apps/api/core#invoke at import time or in the constructor.
// We stub the whole module so jsdom doesn't explode.
vi.mock("../api", () => ({
  telegramStatus: vi.fn().mockResolvedValue("disabled"),
  getDirContext: vi.fn().mockResolvedValue({ git: null, runtime: null }),
  aomStatus: vi.fn().mockResolvedValue(null),
  gitRepoSummary: vi.fn().mockResolvedValue(null),
  gitSwitchBranch: vi.fn().mockResolvedValue(null),
  getSessionMissionContent: vi.fn().mockResolvedValue(null),
  getSessionPlanContent: vi.fn().mockResolvedValue(null),
  setSessionMissionContent: vi.fn().mockResolvedValue(null),
}));

vi.mock("../aom/connectivity", () => ({
  isOnline: vi.fn().mockReturnValue(true),
  subscribeOnline: vi.fn(),
}));

vi.mock("../score/chip", () => ({
  makeScoreChip: vi.fn(() => ({
    el: document.createElement("span"),
    refresh: vi.fn().mockResolvedValue(undefined),
    setOnClick: vi.fn(),
  })),
}));

vi.mock("../release/markdown", () => ({
  renderMarkdown: vi.fn((s: string) => s),
}));

// -------------------------------------------------------------------------
import { StatusBar } from "./bar";
import type { MissionInfo } from "../api";

describe("StatusBar.setTwoRow", () => {
  let host: HTMLDivElement;
  let bar: StatusBar;

  beforeEach(() => {
    (globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = "0.0.0-test";
    host = document.createElement("div");
    document.body.appendChild(host);
    bar = new StatusBar(host);
    // Force a transition so setEnabled actually fires render — `enabled`
    // defaults to true at runtime, so a redundant setEnabled(true) here
    // would early-return via the no-op guard.
    bar.setEnabled(false);
    bar.setEnabled(true);
  });

  it("renders two .sb-row containers by default", () => {
    const rows = host.querySelectorAll(".sb-row");
    expect(rows.length).toBe(2);
    expect(rows[0].classList.contains("sb-row--top")).toBe(true);
    expect(rows[1].classList.contains("sb-row--bot")).toBe(true);
  });

  it("setTwoRow(false) flattens to a single-row layout", () => {
    bar.setTwoRow(false);
    const rows = host.querySelectorAll(".sb-row");
    expect(rows.length).toBe(0);
    expect(host.children.length).toBeGreaterThanOrEqual(4);
  });

  it("setTwoRow(true) returns to the two-row layout", () => {
    bar.setTwoRow(false);
    bar.setTwoRow(true);
    const rows = host.querySelectorAll(".sb-row");
    expect(rows.length).toBe(2);
  });

  it("repeated setTwoRow with same value is a no-op", () => {
    bar.setTwoRow(true);
    bar.setTwoRow(true);
    const rows = host.querySelectorAll(".sb-row");
    expect(rows.length).toBe(2);
  });
});

describe("StatusBar mission chip", () => {
  let host: HTMLDivElement;
  let bar: StatusBar;

  const mission = (path: string): MissionInfo => ({
    kind: "covenant",
    path,
    content_preview: "",
    loaded_at_unix_ms: 1,
    mtime_unix_ms: 1,
    plan: null,
  });

  beforeEach(() => {
    (globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = "0.0.0-test";
    host = document.createElement("div");
    document.body.appendChild(host);
    bar = new StatusBar(host);
    bar.setEnabled(false);
    bar.setEnabled(true);
  });

  it("renders a remove affordance inside the chip", () => {
    bar.setMission(mission("/repo/specs/2026-06-12-some-design.md"), "s1");
    const chip = host.querySelector("button.status-mission");
    expect(chip).not.toBeNull();
    const x = chip!.querySelector<HTMLElement>(".status-mission-remove");
    expect(x).not.toBeNull();
    expect(x!.getAttribute("role")).toBe("button");
    expect(x!.getAttribute("aria-label")).toBe("Remove mission");
  });

  it("clicking remove fires onMissionClearRequested without opening the spec", () => {
    const cleared = vi.fn();
    bar.onMissionClearRequested = cleared;
    bar.setMission(mission("/repo/specs/a.md"), "s1");
    const open = vi.spyOn(
      bar as unknown as { openMission: () => Promise<void> },
      "openMission",
    );
    const x = host.querySelector<HTMLElement>(".status-mission-remove")!;
    x.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(cleared).toHaveBeenCalledWith("s1");
    expect(open).not.toHaveBeenCalled();
  });
});
