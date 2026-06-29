import { describe, it, expect } from "vitest";
import { buildFreeKeySettings, GEMINI_BASE_URL } from "./freekey";
import type { Settings } from "../api";

function baseSettings(over: Partial<Settings> = {}): Settings {
  return {
    providers: { anthropic: { kind: "anthropic", label: "Anthropic", api_key: null } },
    model_routes: {
      summary: { provider_id: "anthropic", model: "claude-sonnet-4-6" },
      chat: { provider_id: "anthropic", model: "claude-opus-4-7" },
    },
    ...over,
  } as unknown as Settings;
}

describe("buildFreeKeySettings", () => {
  it("adds a gemini openai_compat provider with the pasted key", () => {
    const next = buildFreeKeySettings(baseSettings(), "AIza-xyz");
    expect(next.providers!.gemini).toEqual({
      kind: "openai_compat",
      label: "Gemini (free)",
      base_url: GEMINI_BASE_URL,
      api_key: "AIza-xyz",
    });
  });

  it("repoints every seeded role at gemini", () => {
    const next = buildFreeKeySettings(baseSettings(), "k");
    expect(next.model_routes!.summary.provider_id).toBe("gemini");
    expect(next.model_routes!.chat.provider_id).toBe("gemini");
  });

  it("seeds the full role set when no routes exist yet", () => {
    const next = buildFreeKeySettings(baseSettings({ model_routes: {} }), "k");
    expect(Object.keys(next.model_routes!).sort()).toEqual(
      ["chat", "operator", "spec_creator", "summary", "triage"].sort(),
    );
  });

  it("does not mutate the input", () => {
    const input = baseSettings();
    buildFreeKeySettings(input, "k");
    expect(input.providers!.gemini).toBeUndefined();
    expect(input.model_routes!.summary.provider_id).toBe("anthropic");
  });
});
