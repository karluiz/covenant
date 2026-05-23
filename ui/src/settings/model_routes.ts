import type { Settings } from "../api";
import { listModelsAnthropic, listModelsOpenAiCompat } from "../api";
import { CustomSelect, type SelectOption } from "../ui/select";

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
  wrap.className = "settings-card model-route-row";

  const title = document.createElement("h4");
  title.className = "settings-card-title";
  title.textContent = ROLE_LABEL[role];
  wrap.appendChild(title);

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
    className: "model-route-select",
    ariaLabel: `${ROLE_LABEL[role]} model`,
    value: route.model,
    placeholder: "Pick a model…",
    options: [],
  });
  const status = document.createElement("span");
  status.className = "route-status";
  const warn = document.createElement("p");
  warn.className = "field-warning";

  const setStatus = (kind: "ok" | "warn" | "err" | "idle", text: string) => {
    status.textContent = text;
    status.classList.remove("is-ok", "is-warn", "is-err", "is-idle");
    status.classList.add(`is-${kind}`);
  };

  const refreshModels = async () => {
    const providerId = providerSel.value;
    const entry = settings.providers?.[providerId];
    if (!entry) {
      modelSel.setOptions([], "");
      setStatus("err", "provider not configured");
      updateWarning();
      return;
    }
    setStatus("idle", "checking…");
    let models;
    try {
      if (entry.kind === "anthropic") {
        models = await listModelsAnthropic();
      } else {
        models = await listModelsOpenAiCompat(entry.base_url ?? "");
      }
    } catch (e) {
      modelSel.setOptions([
        { value: route.model, label: `${route.model || "(none)"} (unreachable)` },
      ], route.model);
      const msg = String(e).replace(/^Error:\s*/, "");
      setStatus("err", `✗ unreachable: ${msg.slice(0, 80)}`);
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
    if (!route.model) {
      setStatus("warn", `⚠ ${models.length} models — pick one`);
    } else if (!modelPresent && entry.kind !== "anthropic") {
      setStatus("warn", `⚠ "${route.model}" not in ${models.length} listed models`);
    } else {
      setStatus("ok", `✓ ${entry.kind === "anthropic" ? "anthropic" : `reachable, ${models.length} models`}`);
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
      warn.classList.add("is-warning");
    } else {
      warn.textContent = ROLE_HINT[role];
      warn.classList.remove("is-warning");
    }
  };

  providerSel.element.addEventListener("change", () => {
    const next: Settings = structuredClone(settings);
    next.model_routes = next.model_routes ?? {};
    next.model_routes[role] = { provider_id: providerSel.value, model: route.model };
    onChange(next);
    void refreshModels();
  });
  modelSel.element.addEventListener("change", () => {
    const next: Settings = structuredClone(settings);
    next.model_routes = next.model_routes ?? {};
    next.model_routes[role] = {
      provider_id: providerSel.value,
      model: modelSel.value,
    };
    onChange(next);
    void refreshModels();
  });

  wrap.appendChild(labeled("Provider", providerSel.element));
  wrap.appendChild(labeled("Model", modelSel.element));
  wrap.appendChild(status);
  wrap.appendChild(warn);

  void refreshModels();
  return wrap;
}

function labeled(text: string, ctl: HTMLElement): HTMLElement {
  const w = document.createElement("label");
  w.className = "field";
  const span = document.createElement("span");
  span.className = "settings-field-label";
  span.textContent = text;
  w.appendChild(span);
  w.appendChild(ctl);
  return w;
}
