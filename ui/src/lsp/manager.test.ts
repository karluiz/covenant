import { describe, expect, it, beforeEach } from "vitest";
import { lspLanguageId, consentState, grantConsentFor } from "./manager";

describe("lspLanguageId", () => {
  it("maps .rs to rust and everything else to null in P1", () => {
    expect(lspLanguageId("/repo/src/main.rs")).toBe("rust");
    expect(lspLanguageId("/repo/src/app.ts")).toBeNull();
    expect(lspLanguageId("/repo/README.md")).toBeNull();
    expect(lspLanguageId("/repo/Makefile")).toBeNull();
  });
});

describe("consent", () => {
  beforeEach(() => localStorage.clear());
  it("defaults to not granted, persists a grant", () => {
    expect(consentState("rust")).toBe(false);
    grantConsentFor("rust");
    expect(consentState("rust")).toBe(true);
    expect(localStorage.getItem("lsp.consent.rust")).toBe("granted");
  });
});
