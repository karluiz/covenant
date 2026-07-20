import type { Settings } from "../api";
import { listModelsAnthropic, listModelsAzureFoundry, listModelsOpenAiCompat } from "../api";
import { CustomSelect, type SelectOption } from "../ui/select";
import { attachTooltip } from "../tooltip/tooltip";
import { formatChord } from "../platform";

type Role = "summary" | "chat" | "operator" | "triage" | "spec_creator" | "context_miner";

// ponytail: cache successful probes for 60s. Rows share providers (4+ use the
// same Azure endpoint), so without caching, mounting all 6 fired parallel
// /openai/deployments calls that blew past the backend's 8s timeout → false
// "unreachable". Failures aren't cached, so a broken provider retries.
// ponytail: 60s TTL, bump if provider model lists change more often than that.
const PROBE_TTL_MS = 60_000;
const probeCache = new Map<string, { at: number; p: Promise<{ id: string }[]> }>();
function probe(key: string, fn: () => Promise<{ id: string }[]>) {
  const hit = probeCache.get(key);
  if (hit && Date.now() - hit.at < PROBE_TTL_MS) return hit.p;
  const p = fn().catch((e) => {
    probeCache.delete(key);
    throw e;
  });
  probeCache.set(key, { at: Date.now(), p });
  return p;
}

const ROLE_LABEL: Record<Role, string> = {
  summary:      "Summary",
  chat:         "Chat",
  operator:     "Operator",
  triage:       "Triage",
  spec_creator: "Spec Creator",
  // The route key stays `context_miner` (backend contract); the label is the
  // surface's user-visible name.
  context_miner: "Context Crawler",
};

/** A ⌘K-style key hint shown as a chip next to the role name, when it has one. */
function roleKbd(role: Role): string | undefined {
  return role === "chat" ? formatChord(["mod", "K"]) : undefined;
}

/** One-line tagline shown under each role title. */
function roleTaglines(): Record<Role, string> {
  return {
  summary:      "Rolling world-model summaries, per session",
  chat:         `${formatChord(["mod", "K"])} agent · commit messages · Changes explanations`,
  operator:     "Autonomous agent that runs tools across your sessions",
  triage:       "Cheap gate before an expensive operator call",
  spec_creator: "The immersive Spec Creator's research agent",
  context_miner: "The Canon Context Crawler's repo-surveying agent",
  };
}

/** Longer explanation — now a hover tooltip on the row, not an always-on footer. */
function roleHints(): Record<Role, string> {
  return {
  summary:
    "Runs after every command to keep a short rolling summary of each session. Fires often, so favour a cheap, fast model.",
  chat:
    `Every one-shot ask in the app: the ${formatChord(["mod", "K"])} agent panel, the generated commit message, and the AI explanation in Changes (${formatChord(["mod", "shift", "C"])}). Mid-tier model is plenty.`,
  operator:
    "Drives the autonomous operator that observes sessions and runs commands. Requires a tool-use-capable provider (Anthropic, Azure gpt-4o, …).",
  triage:
    "A tiny classifier that decides whether the operator should wake up at all. The smallest model you have is fine.",
  spec_creator:
    "The streaming agent behind the immersive Spec Creator: it greps/reads your repo and drafts the spec. Needs tool use. Opus 4.8 explores deepest; Azure gpt-4o is faster/cheaper but shallower on long tool loops.",
  context_miner:
    "The agent behind the Canon “New context” Miner: it scans your repo and emits findings that compile into a skill. Needs tool use (Anthropic, an OpenAI-compatible server, or Azure).",
  };
}

/** How hot each route runs (0–4 bars). Drives the frequency meter + cadence group. */
const ROLE_FREQ: Record<Role, number> = {
  summary: 4,
  triage: 3,
  chat: 1,
  operator: 1,
  spec_creator: 1,
  context_miner: 1,
};

/** Routes grouped by call cadence — the tab's whole point is cheap-frequent vs. powerful-rare. */
const CADENCE: { title: string; desc: string; roles: Role[] }[] = [
  { title: "Hot path",   desc: "Fires on every command — favour a cheap, fast model.", roles: ["summary", "triage"] },
  { title: "Deliberate", desc: "Fires on demand — spend where it counts.",             roles: ["chat", "operator", "spec_creator", "context_miner"] },
];

export function renderModelsTab(
  root: HTMLElement,
  settings: Settings,
  onChange: (next: Settings) => void,
): void {
  root.innerHTML = "";

  const intro = document.createElement("p");
  intro.className = "settings-section-intro";
  intro.textContent =
    "Covenant routes each kind of LLM work to its own provider + model, so you can mix a cheap model for frequent jobs with a powerful one where it counts. Pick a provider, then a model it actually serves — the chip confirms it's reachable.";
  root.appendChild(intro);

  const matrix = document.createElement("div");
  matrix.className = "route-matrix";
  for (const group of CADENCE) {
    const sec = document.createElement("div");
    sec.className = "route-cadence";

    const head = document.createElement("div");
    head.className = "route-cadence-head";
    const t = document.createElement("span");
    t.className = "route-cadence-title";
    t.textContent = group.title;
    const d = document.createElement("span");
    d.className = "route-cadence-desc";
    d.textContent = group.desc;
    head.append(t, d);
    sec.appendChild(head);

    for (const role of group.roles) {
      sec.appendChild(renderRoleRow(role, settings, onChange));
    }
    matrix.appendChild(sec);
  }
  root.appendChild(matrix);
}

/** Small N-of-4 bar meter for how often a route fires. */
function freqMeter(level: number): HTMLElement {
  const m = document.createElement("span");
  m.className = "route-freq" + (level >= 3 ? " is-hot" : "");
  for (let i = 0; i < 4; i++) {
    const bar = document.createElement("i");
    if (i >= level) bar.className = "off";
    m.appendChild(bar);
  }
  return m;
}

function renderRoleRow(
  role: Role,
  settings: Settings,
  onChange: (next: Settings) => void,
): HTMLElement {
  const route = settings.model_routes?.[role] ?? { provider_id: "anthropic", model: "" };
  const wrap = document.createElement("div");
  wrap.className = "route-row";

  // identity: name (+ kbd + freq) over its one-line job
  const id = document.createElement("div");
  id.className = "route-id";
  const nameRow = document.createElement("div");
  nameRow.className = "route-name";
  const name = document.createElement("span");
  name.textContent = ROLE_LABEL[role];
  nameRow.appendChild(name);
  const roleKbdText = roleKbd(role);
  if (roleKbdText) {
    const kbd = document.createElement("span");
    kbd.className = "route-kbd";
    kbd.textContent = roleKbdText;
    nameRow.appendChild(kbd);
  }
  nameRow.appendChild(freqMeter(ROLE_FREQ[role]));
  const job = document.createElement("div");
  job.className = "route-job";
  job.textContent = roleTaglines()[role];
  id.append(nameRow, job);
  attachTooltip(id, roleHints()[role]);
  wrap.appendChild(id);

  const providerSel = new CustomSelect({
    className: "model-route-select",
    ariaLabel: `${ROLE_LABEL[role]} provider`,
    value: route.provider_id,
    options: Object.entries(settings.providers ?? {}).map(([id, entry]) => ({
      value: id,
      label: entry.label,
    })),
  });

  const modelSel = new CustomSelect({
    className: "model-route-select is-model",
    ariaLabel: `${ROLE_LABEL[role]} model`,
    value: route.model,
    placeholder: "Pick a model…",
    options: [],
  });

  const pair = document.createElement("div");
  pair.className = "route-pair";
  const arrow = document.createElement("span");
  arrow.className = "route-arrow";
  arrow.textContent = "→";
  pair.append(providerSel.element, arrow, modelSel.element);
  wrap.appendChild(pair);

  const status = document.createElement("span");
  status.className = "route-chip";

  const setStatus = (kind: "ok" | "native" | "warn" | "err" | "idle", text: string) => {
    status.textContent = text;
    status.classList.remove("is-ok", "is-native", "is-warn", "is-err", "is-idle");
    status.classList.add(`is-${kind}`);
  };

  let lastModelCount = 0;
  const refreshModels = async () => {
    const providerId = providerSel.value;
    const entry = settings.providers?.[providerId];
    if (!entry) {
      modelSel.setOptions([], "");
      setStatus("err", "not configured");
      updateWarning();
      return;
    }
    setStatus("idle", "checking…");
    let models;
    try {
      if (entry.kind === "anthropic") {
        models = await probe(`anthropic:${providerId}`, () => listModelsAnthropic());
      } else if (entry.kind === "azure_foundry") {
        const args = {
          endpoint: entry.base_url ?? "",
          apiKey: entry.api_key ?? "",
          mode: entry.azure_mode ?? "azure_open_ai",
          apiVersion:
            entry.azure_api_version ??
            (entry.azure_mode === "ai_inference"
              ? "2024-05-01-preview"
              : "2024-10-21"),
        };
        models = await probe(`azure:${JSON.stringify(args)}`, () =>
          listModelsAzureFoundry(args),
        );
      } else {
        const base = entry.base_url ?? "";
        models = await probe(`compat:${base}`, () => listModelsOpenAiCompat(base));
      }
    } catch (e) {
      modelSel.setOptions([
        { value: route.model, label: `${route.model || "(none)"} (unreachable)` },
      ], route.model);
      const msg = String(e).replace(/^Error:\s*/, "");
      setStatus("err", "✗ unreachable");
      attachTooltip(status, msg.slice(0, 200));
      updateWarning();
      return;
    }
    const modelOptions: SelectOption[] = models.map((m) => ({
      value: m.id,
      label: m.id,
    }));
    const modelPresent =
      route.model && modelOptions.some((o) => o.value === route.model);
    if (route.model && !modelPresent) {
      modelOptions.push({ value: route.model, label: `${route.model} (not found)` });
    }
    modelSel.setOptions(modelOptions, route.model);
    lastModelCount = models.length;
    if (!route.model) {
      setStatus("warn", "⚠ pick a model");
    } else if (!modelPresent && entry.kind !== "anthropic") {
      setStatus("warn", "⚠ not listed");
    } else if (entry.kind === "anthropic") {
      setStatus("native", "✓ anthropic");
    } else {
      setStatus("ok", `✓ reachable · ${models.length}`);
    }
    updateWarning();
  };

  const warn = document.createElement("p");
  warn.className = "route-warn";
  warn.hidden = true;
  const updateWarning = () => {
    const providerId = providerSel.value;
    const entry = settings.providers?.[providerId];
    if (role === "operator" && entry?.kind === "openai_compat") {
      warn.textContent =
        "⚠ Local providers don't translate Anthropic tool-use yet — operator falls back to SuggestOnly.";
      warn.hidden = false;
    } else {
      warn.textContent = "";
      warn.hidden = true;
    }
  };

  providerSel.element.addEventListener("change", () => {
    // Switching provider clears the model — the old one rarely exists on the
    // new provider, and a blank model gives a clear "pick one" prompt.
    route.model = "";
    modelSel.setOptions([], "");
    const next: Settings = structuredClone(settings);
    next.model_routes = next.model_routes ?? {};
    next.model_routes[role] = { provider_id: providerSel.value, model: "" };
    onChange(next);
    void refreshModels();
  });
  modelSel.element.addEventListener("change", () => {
    // Model pick needs no re-probe — the list is already loaded.
    route.model = modelSel.value;
    const next: Settings = structuredClone(settings);
    next.model_routes = next.model_routes ?? {};
    next.model_routes[role] = { provider_id: providerSel.value, model: modelSel.value };
    onChange(next);
    const entry = settings.providers?.[providerSel.value];
    if (entry?.kind === "anthropic") setStatus("native", "✓ anthropic");
    else setStatus("ok", `✓ reachable · ${lastModelCount}`);
    updateWarning();
  });

  wrap.appendChild(status);
  wrap.appendChild(warn); // full-width, spans the grid; hidden unless the operator/compat case fires

  void refreshModels();
  return wrap;
}
