// First-run Ollama adoption.
//
// Covenant ships with zero LLM credentials, so a fresh install can't
// exercise any agentic feature — the super-agent, fix suggestions and
// AOM all need a model. Many of our users already run Ollama locally;
// detect it and offer one-click adoption so the agent works out of the
// box with no key and no server round-trip.
//
// Ollama already speaks the OpenAI-compatible API we support, so this is
// purely detection + wiring — no new provider plumbing. (For a hosted
// "try it" path that demos real frontier-model quality, see B.)

import { getSettings, listModelsOpenAiCompat, type Settings } from "../api";

export const OLLAMA_BASE_URL = "http://localhost:11434/v1";
const OLLAMA_PROVIDER_ID = "ollama";

/// The roles we repoint when no routes are seeded yet. Mirrors the Rust
/// `Role` enum (snake_case). Normally `getSettings()` already returns
/// every role, so this fallback only matters for an empty registry.
const FALLBACK_ROLES = ["summary", "chat", "operator", "triage", "spec_creator"];

/// Point EVERY model route at `providerId`+`model`. On a fresh install one
/// provider drives the whole agent, so we don't guess which roles matter.
/// Existing route keys are preserved; if none are seeded we fall back to
/// the known role set. Returns a new Settings; does not mutate the input.
/// Shared by the Ollama and free-cloud-key onboarding paths.
export function repointAllRoles(
  current: Settings,
  providerId: string,
  model: string,
): Settings {
  const next: Settings = JSON.parse(JSON.stringify(current));
  const seeded = Object.keys(next.model_routes ?? {});
  const roles = seeded.length ? seeded : FALLBACK_ROLES;
  next.model_routes = {};
  for (const r of roles) {
    next.model_routes[r] = { provider_id: providerId, model };
  }
  return next;
}

/// Probe a locally-running Ollama. Returns its model ids (in the order
/// Ollama reports them), or null if nothing is listening or the call
/// fails. Reuses the existing `list_models_openai_compat` command — a
/// successful model list IS the health check.
export async function detectOllama(): Promise<string[] | null> {
  try {
    const models = await listModelsOpenAiCompat(OLLAMA_BASE_URL);
    if (!models.length) return null;
    return models.map((m) => m.id);
  } catch {
    return null;
  }
}

/// Pure: a copy of `current` with an "ollama" provider added and EVERY
/// model route repointed at it. We repoint all roles rather than guess
/// which ones matter — on a fresh install one local model drives the
/// whole agent. Existing route keys are preserved; if none are seeded
/// we fall back to the known role set.
export function buildOllamaSettings(
  current: Settings,
  model: string,
  baseUrl: string = OLLAMA_BASE_URL,
): Settings {
  const next = repointAllRoles(current, OLLAMA_PROVIDER_ID, model);
  next.providers = { ...(next.providers ?? {}) };
  next.providers[OLLAMA_PROVIDER_ID] = {
    kind: "openai_compat",
    label: "Ollama (local)",
    base_url: baseUrl,
  };
  return next;
}

/// Adopt Ollama: build the settings from the live config and persist
/// them via `set_settings`. Throws if the backend is unreachable.
export async function adoptOllama(model: string): Promise<void> {
  const current = await getSettings();
  const next = buildOllamaSettings(current, model);
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("set_settings", { settings: next });
}
