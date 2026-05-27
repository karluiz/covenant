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
