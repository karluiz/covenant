import { describe, expect, it } from "vitest";
import { VitalsSurface, type VitalsDataSource } from "./page";

const source: VitalsDataSource = {
  summary: async () => [
    { metric: "switch", app_version: "0.11.2", n: 40, p50: 35, p95: 120, max: 300, first_seen: 2 },
    { metric: "switch", app_version: "0.11.1", n: 90, p50: 60, p95: 2100, max: 3200, first_seen: 1 },
    { metric: "input", app_version: "0.11.2", n: 500, p50: 14, p95: 28, max: 90, first_seen: 2 },
  ],
  worst: async () => [
    { ts: 1753849000000, app_version: "0.11.1", value_ms: 3200, aux_ms: 1800, detail: '{"colsDelta":40,"hiddenOutputBytes":2097152,"fitMs":180,"nudgeMs":12}' },
  ],
  daily: async () => [
    { day: "2026-07-28", p95: 90, n: 12 },
    { day: "2026-07-29", p95: 40, n: 20 },
  ],
  currentVersion: async () => "0.11.2",
};

describe("VitalsSurface", () => {
  it("renders metric cards for the current version and the by-version table", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const surface = new VitalsSurface(host, source);
    await surface.open();
    expect(surface.isOpen()).toBe(true);
    const text = host.textContent ?? "";
    expect(text).toContain("Switch");
    expect(text).toContain("Input");
    expect(text).toContain("Boot");
    expect(text).toContain("0.11.2");
    expect(text).toContain("0.11.1");
    expect(host.querySelectorAll("svg polyline").length).toBeGreaterThan(0);
    expect(text).toContain("3200"); // worst switch value
    surface.close();
    expect(surface.isOpen()).toBe(false);
  });

  it("renders an empty state when there is no data yet", async () => {
    const empty: VitalsDataSource = {
      summary: async () => [],
      worst: async () => [],
      daily: async () => [],
      currentVersion: async () => "0.11.2",
    };
    const host = document.createElement("div");
    const surface = new VitalsSurface(host, empty);
    await surface.open();
    expect(host.textContent).toContain("No vitals recorded yet");
  });
});
