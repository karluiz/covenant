import { describe, expect, it, beforeEach, vi } from "vitest";
import { lspLanguageId } from "./manager";
import type { Settings } from "../api";

// consentState/grantConsentFor persist through the settings store
// (getSettings/setSettings), not localStorage directly, so the API
// surface under test is mocked here rather than Tauri's `invoke`.
let fakeSettings: Partial<Settings>;

vi.mock("../api", () => ({
  getSettings: vi.fn(async () => fakeSettings),
  setSettings: vi.fn(async (s: Partial<Settings>) => {
    fakeSettings = s;
  }),
  lspDownloadServer: vi.fn(),
  lspSend: vi.fn(),
  lspServerStatus: vi.fn(),
  lspStart: vi.fn(),
  lspStop: vi.fn(),
}));

describe("lspLanguageId", () => {
  it("maps .rs to rust and everything else to null in P1", () => {
    expect(lspLanguageId("/repo/src/main.rs")).toBe("rust");
    expect(lspLanguageId("/repo/src/app.ts")).toBeNull();
    expect(lspLanguageId("/repo/README.md")).toBeNull();
    expect(lspLanguageId("/repo/Makefile")).toBeNull();
  });
});

describe("consent (settings-store backed)", () => {
  beforeEach(() => {
    localStorage.clear();
    fakeSettings = {};
    // manager.ts caches settings at module scope — force a fresh module
    // instance per test so the cache doesn't leak across cases.
    vi.resetModules();
  });

  it("defaults to not granted, persists a grant into the settings store", async () => {
    const { consentState, grantConsentFor } = await import("./manager");
    expect(await consentState("rust")).toBe(false);
    await grantConsentFor("rust");
    expect(await consentState("rust")).toBe(true);
    expect(fakeSettings.code_intelligence?.consented_languages).toContain("rust");
    // Never touches localStorage — the migration only reads it.
    expect(localStorage.getItem("lsp.consent.rust")).toBeNull();
  });

  // ponytail: one-time migration path — a legacy P1 install granted
  // consent via `lsp.consent.<language>` in localStorage. The first
  // settings load must import it into the store and never look at
  // localStorage again.
  it("migrates a legacy localStorage grant into the settings store on first load", async () => {
    localStorage.setItem("lsp.consent.rust", "granted");
    const { consentState } = await import("./manager");
    expect(await consentState("rust")).toBe(true);
    expect(fakeSettings.code_intelligence?.consented_languages).toContain("rust");
  });

  it("ignores localStorage entries that were never granted", async () => {
    localStorage.setItem("lsp.consent.rust", "denied");
    const { consentState } = await import("./manager");
    expect(await consentState("rust")).toBe(false);
  });

  it("master toggle off overrides a per-language grant", async () => {
    fakeSettings = { code_intelligence: { enabled: false, consented_languages: ["rust"] } };
    const { consentState } = await import("./manager");
    expect(await consentState("rust")).toBe(false);
  });

  it("refreshCodeIntelSettings re-reads the store after an external save", async () => {
    const { consentState, refreshCodeIntelSettings } = await import("./manager");
    expect(await consentState("rust")).toBe(false);
    // Simulate the Settings panel saving a change out from under the cache.
    fakeSettings = { code_intelligence: { enabled: true, consented_languages: ["rust"] } };
    await refreshCodeIntelSettings();
    expect(await consentState("rust")).toBe(true);
  });
});
