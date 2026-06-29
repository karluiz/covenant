import { describe, it, expect } from "vitest";
import { buildOllamaSettings, OLLAMA_BASE_URL } from "./ollama";
import type { Settings } from "../api";

// Minimal Settings stub — only the fields buildOllamaSettings touches.
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

describe("buildOllamaSettings", () => {
  it("adds an ollama openai_compat provider at the default base url", () => {
    const next = buildOllamaSettings(baseSettings(), "llama3.2");
    expect(next.providers!.ollama).toEqual({
      kind: "openai_compat",
      label: "Ollama (local)",
      base_url: OLLAMA_BASE_URL,
    });
  });

  it("repoints every seeded role at ollama + the chosen model", () => {
    const next = buildOllamaSettings(baseSettings(), "qwen2.5");
    expect(next.model_routes).toEqual({
      summary: { provider_id: "ollama", model: "qwen2.5" },
      chat: { provider_id: "ollama", model: "qwen2.5" },
    });
  });

  it("seeds the full role set when no routes exist yet", () => {
    const next = buildOllamaSettings(baseSettings({ model_routes: {} }), "phi3");
    expect(Object.keys(next.model_routes!).sort()).toEqual(
      ["chat", "operator", "spec_creator", "summary", "triage"].sort(),
    );
    expect(next.model_routes!.operator).toEqual({ provider_id: "ollama", model: "phi3" });
  });

  it("does not mutate the input settings", () => {
    const input = baseSettings();
    buildOllamaSettings(input, "llama3.2");
    expect(input.model_routes!.summary.provider_id).toBe("anthropic");
    expect(input.providers!.ollama).toBeUndefined();
  });

  it("preserves a custom base url (e.g. remote ollama)", () => {
    const next = buildOllamaSettings(baseSettings(), "llama3.2", "http://box.lan:11434/v1");
    expect(next.providers!.ollama.base_url).toBe("http://box.lan:11434/v1");
  });
});
