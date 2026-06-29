// Free cloud-key onboarding.
//
// The zero-cost alternative to a locally-running Ollama: the user pastes
// a key from a provider with a real free tier, so a fresh install can
// exercise the agent against a hosted model without us hosting or paying
// for anything.
//
// We point at Google Gemini's OpenAI-compatible endpoint — its free tier
// needs no credit card and is generous enough to feel the super-agent.
// It rides the existing `openai_compat` provider path (bearer key +
// /chat/completions), so there's no new provider plumbing.

import { getSettings, type Settings } from "../api";
import { repointAllRoles } from "./ollama";

/// Gemini's OpenAI-compatible base. The provider appends /chat/completions.
export const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";
/// Where the user grabs a free key (no credit card).
export const GEMINI_KEY_URL = "https://aistudio.google.com/apikey";
/// The forge how-to that walks through both zero-cost paths.
export const START_GUIDE_URL = "https://forge.covenant.uno/start";
const GEMINI_MODEL = "gemini-2.0-flash";
const GEMINI_PROVIDER_ID = "gemini";

/// Pure: a copy of `current` with a free Gemini provider added and every
/// role repointed at it. Does not mutate the input.
export function buildFreeKeySettings(
  current: Settings,
  apiKey: string,
  baseUrl: string = GEMINI_BASE_URL,
  model: string = GEMINI_MODEL,
): Settings {
  const next = repointAllRoles(current, GEMINI_PROVIDER_ID, model);
  next.providers = { ...(next.providers ?? {}) };
  next.providers[GEMINI_PROVIDER_ID] = {
    kind: "openai_compat",
    label: "Gemini (free)",
    base_url: baseUrl,
    api_key: apiKey,
  };
  return next;
}

/// Adopt a pasted free key: build the settings and persist them. Throws
/// on an empty key or if the backend is unreachable.
export async function adoptFreeKey(apiKey: string): Promise<void> {
  const key = apiKey.trim();
  if (!key) throw new Error("empty key");
  const current = await getSettings();
  const next = buildFreeKeySettings(current, key);
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("set_settings", { settings: next });
}
