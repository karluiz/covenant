import type { Settings } from "../api";
import { listModelsAnthropic, listModelsOpenAiCompat } from "../api";

type Role = "summary" | "chat" | "operator" | "triage";

const ROLE_LABEL: Record<Role, string> = {
  summary:  "Summary",
  chat:     "Chat (⌘K)",
  operator: "Operator",
  triage:   "Triage (cheap classifier)",
};

const ROLE_HINT: Record<Role, string> = {
  summary:  "Used for per-session rolling summaries (frequent, cheap).",
  chat:     "Used when you ask the agent a question.",
  operator: "Tool use required — provider must support it.",
  triage:   "Used to gate expensive operator calls. Tiny model is fine.",
};

export function renderModelsTab(
  root: HTMLElement,
  settings: Settings,
  onChange: (next: Settings) => void,
): void {
  root.innerHTML = "";
  for (const role of ["summary", "chat", "operator", "triage"] as Role[]) {
    root.appendChild(renderRoleRow(role, settings, onChange));
  }
}

function renderRoleRow(
  role: Role,
  settings: Settings,
  onChange: (next: Settings) => void,
): HTMLElement {
  const route = settings.model_routes?.[role] ?? { provider_id: "anthropic", model: "" };
  const wrap = document.createElement("div");
  wrap.className = "model-route-row";

  const title = document.createElement("h4");
  title.textContent = ROLE_LABEL[role];
  wrap.appendChild(title);

  const providerSel = document.createElement("select");
  for (const [id, entry] of Object.entries(settings.providers ?? {})) {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = entry.label;
    if (id === route.provider_id) opt.selected = true;
    providerSel.appendChild(opt);
  }

  const modelSel = document.createElement("select");
  const warn = document.createElement("p");
  warn.className = "field-warning";

  const refreshModels = async () => {
    const providerId = providerSel.value;
    const entry = settings.providers?.[providerId];
    modelSel.innerHTML = "";
    if (!entry) {
      updateWarning();
      return;
    }
    let models;
    try {
      if (entry.kind === "anthropic") {
        models = await listModelsAnthropic();
      } else {
        models = await listModelsOpenAiCompat(entry.base_url ?? "");
      }
    } catch (e) {
      const opt = document.createElement("option");
      opt.value = route.model;
      opt.textContent = `${route.model || "(none)"} (couldn't probe: ${e})`;
      modelSel.appendChild(opt);
      updateWarning();
      return;
    }
    for (const m of models) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.id;
      if (m.id === route.model) opt.selected = true;
      modelSel.appendChild(opt);
    }
    if (route.model && ![...modelSel.options].some((o) => o.value === route.model)) {
      const opt = document.createElement("option");
      opt.value = route.model;
      opt.textContent = `${route.model} (current)`;
      modelSel.appendChild(opt);
      modelSel.value = route.model;
    }
    updateWarning();
  };

  const updateWarning = () => {
    const providerId = providerSel.value;
    const entry = settings.providers?.[providerId];
    warn.textContent = "";
    if (role === "operator" && entry?.kind === "openai_compat") {
      warn.textContent =
        "⚠ Local providers don't translate Anthropic tool-use yet — operator will fall back to SuggestOnly.";
    } else {
      warn.textContent = ROLE_HINT[role];
    }
  };

  providerSel.onchange = () => {
    const next: Settings = structuredClone(settings);
    next.model_routes = next.model_routes ?? {};
    next.model_routes[role] = { provider_id: providerSel.value, model: route.model };
    onChange(next);
    void refreshModels();
  };
  modelSel.onchange = () => {
    const next: Settings = structuredClone(settings);
    next.model_routes = next.model_routes ?? {};
    next.model_routes[role] = {
      provider_id: providerSel.value,
      model: modelSel.value,
    };
    onChange(next);
  };

  wrap.appendChild(labeled("Provider", providerSel));
  wrap.appendChild(labeled("Model", modelSel));
  wrap.appendChild(warn);

  void refreshModels();
  return wrap;
}

function labeled(text: string, ctl: HTMLElement): HTMLElement {
  const w = document.createElement("label");
  w.className = "field";
  const span = document.createElement("span");
  span.textContent = text;
  w.appendChild(span);
  w.appendChild(ctl);
  return w;
}
