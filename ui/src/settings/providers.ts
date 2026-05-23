import type { Settings, ProviderEntry } from "../api";
import { listModelsOpenAiCompat, listModelsAzureFoundry } from "../api";
import { CustomSelect } from "../ui/select";

export function renderProvidersTab(
  root: HTMLElement,
  settings: Settings,
  onChange: (next: Settings) => void,
): void {
  root.innerHTML = "";

  const list = document.createElement("div");
  list.className = "providers-list";
  for (const [id, entry] of Object.entries(settings.providers ?? {})) {
    list.appendChild(renderProviderCard(id, entry, settings, onChange));
  }
  root.appendChild(list);

  const addBar = document.createElement("div");
  addBar.className = "add-provider-bar";

  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.textContent = "+ Add provider";
  addBtn.className = "btn-secondary";
  addBar.appendChild(addBtn);

  const formWrap = document.createElement("div");
  formWrap.className = "add-provider-form";
  formWrap.style.display = "none";
  formWrap.innerHTML = `
    <span class="add-provider-preset-host"></span>
    <input class="add-provider-id" type="text" placeholder="id (e.g. ollama)" />
    <input class="add-provider-url" type="text" placeholder="base URL" />
    <button type="button" class="btn-secondary add-provider-confirm">Add</button>
    <button type="button" class="add-provider-cancel">Cancel</button>
  `;
  addBar.appendChild(formWrap);

  const presetHost = formWrap.querySelector<HTMLElement>(".add-provider-preset-host")!;
  const preset = new CustomSelect({
    className: "add-provider-preset",
    ariaLabel: "Provider preset",
    value: "ollama",
    options: [
      { value: "ollama", label: "Ollama (http://localhost:11434/v1)" },
      { value: "lmstudio", label: "LM Studio (http://localhost:1234/v1)" },
      { value: "azure_foundry", label: "Azure Foundry" },
      { value: "custom", label: "Custom OpenAI-compatible…" },
    ],
  });
  presetHost.replaceWith(preset.element);
  const idInput = formWrap.querySelector<HTMLInputElement>(".add-provider-id")!;
  const urlInput = formWrap.querySelector<HTMLInputElement>(".add-provider-url")!;
  const confirmBtn = formWrap.querySelector<HTMLButtonElement>(".add-provider-confirm")!;
  const cancelBtn = formWrap.querySelector<HTMLButtonElement>(".add-provider-cancel")!;

  const applyPreset = () => {
    if (preset.value === "ollama") {
      idInput.value = "ollama";
      urlInput.value = "http://localhost:11434/v1";
    } else if (preset.value === "lmstudio") {
      idInput.value = "lmstudio";
      urlInput.value = "http://localhost:1234/v1";
    } else if (preset.value === "azure_foundry") {
      idInput.value = "azure";
      urlInput.value = "";
    } else {
      idInput.value = "";
      urlInput.value = "http://localhost:8080/v1";
    }
  };
  applyPreset();
  preset.element.addEventListener("change", applyPreset);

  addBtn.onclick = () => {
    addBtn.style.display = "none";
    formWrap.style.display = "flex";
    idInput.focus();
  };
  cancelBtn.onclick = () => {
    addBtn.style.display = "";
    formWrap.style.display = "none";
  };
  confirmBtn.onclick = () => {
    const id = idInput.value.trim();
    const url = urlInput.value.trim();
    if (!id) { idInput.focus(); return; }
    if (settings.providers?.[id]) { idInput.focus(); return; }
    const next = JSON.parse(JSON.stringify(settings)) as Settings;
    next.providers = { ...(next.providers ?? {}) };
    if (preset.value === "azure_foundry") {
      next.providers[id] = {
        kind: "azure_foundry",
        label: id,
        base_url: url,
        api_key: "",
        azure_mode: "ai_inference",
        azure_api_version: "2024-05-01-preview",
      };
    } else {
      next.providers[id] = {
        kind: "openai_compat",
        label: id,
        base_url: url || "http://localhost:11434/v1",
      };
    }
    onChange(next);
  };

  root.appendChild(addBar);
}

function renderProviderCard(
  id: string,
  entry: ProviderEntry,
  settings: Settings,
  onChange: (next: Settings) => void,
): HTMLElement {
  const card = document.createElement("div");
  card.className = "settings-card provider-card";

  const title = document.createElement("h3");
  title.className = "settings-card-title";
  title.textContent = `${entry.label} (${entry.kind})`;
  card.appendChild(title);

  if (entry.kind === "anthropic") {
    const keyInput = document.createElement("input");
    keyInput.type = "password";
    keyInput.placeholder = "sk-ant-...";
    keyInput.value = entry.api_key ?? "";
    // Field edits mutate the entry in place. We do NOT re-render the
    // providers tab on each keystroke — that destroys the input and
    // throws away focus + caret position. Persistence still works
    // because `settings` is the same reference as `panel.current`,
    // and the Save submit serializes it as-is.
    keyInput.oninput = () => {
      entry.api_key = keyInput.value.trim();
    };
    card.appendChild(labeled("API key", keyInput));
  } else if (entry.kind === "azure_foundry") {
    renderAzureFoundryCard(card, id, entry, settings, onChange);
  } else {
    const urlInput = document.createElement("input");
    urlInput.type = "text";
    urlInput.value = entry.base_url ?? "http://localhost:11434/v1";
    urlInput.oninput = () => {
      entry.base_url = urlInput.value;
    };
    card.appendChild(labeled("Base URL", urlInput));

    const testBtn = document.createElement("button");
    testBtn.textContent = "Test connection";
    testBtn.type = "button";
    testBtn.className = "settings-btn";
    const status = document.createElement("span");
    status.className = "provider-status";
    testBtn.onclick = async () => {
      status.textContent = "…";
      try {
        const models = await listModelsOpenAiCompat(urlInput.value);
        status.textContent = `OK — ${models.length} models`;
      } catch (e) {
        status.textContent = `Error: ${String(e)}`;
      }
    };
    card.appendChild(testBtn);
    card.appendChild(status);
  }

  if (id !== "anthropic") {
    const del = document.createElement("button");
    del.textContent = "Delete";
    del.type = "button";
    del.className = "settings-btn is-danger";
    del.onclick = () => {
      const next = JSON.parse(JSON.stringify(settings)) as Settings;
      next.providers = { ...next.providers };
      delete next.providers![id];
      onChange(next);
    };
    card.appendChild(del);
  }

  return card;
}

function renderAzureFoundryCard(
  card: HTMLElement,
  id: string,
  entry: ProviderEntry,
  settings: Settings,
  onChange: (next: Settings) => void,
): void {
  // Structural change: triggers a parent re-render. Used for the mode
  // toggle, which shows/hides the Deployment field.
  const restructure = (patch: Partial<ProviderEntry>) => {
    const next = JSON.parse(JSON.stringify(settings)) as Settings;
    next.providers![id] = { ...entry, ...patch };
    onChange(next);
  };

  const modeSelect = new CustomSelect({
    className: "settings-select",
    ariaLabel: "Azure mode",
    value: entry.azure_mode ?? "ai_inference",
    options: [
      { value: "ai_inference", label: "AI Inference (/models)" },
      { value: "azure_open_ai", label: "Azure OpenAI (deployments)" },
    ],
  });
  modeSelect.element.addEventListener("change", () => {
    const mode = modeSelect.value as "ai_inference" | "azure_open_ai";
    const defaultVersion =
      mode === "azure_open_ai" ? "2024-10-21" : "2024-05-01-preview";
    const keep =
      entry.azure_api_version &&
      entry.azure_api_version !== "2024-05-01-preview" &&
      entry.azure_api_version !== "2024-10-21";
    restructure({
      azure_mode: mode,
      azure_api_version: keep ? entry.azure_api_version : defaultVersion,
    });
  });
  card.appendChild(labeled("Mode", modeSelect.element));

  // Field edits mutate `entry` in place — no re-render, focus and caret
  // survive. `settings` is the same reference as `panel.current`, so the
  // Save submit picks up these mutations as-is.
  const endpoint = document.createElement("input");
  endpoint.type = "text";
  endpoint.placeholder = "https://my-resource.services.ai.azure.com";
  endpoint.value = entry.base_url ?? "";
  endpoint.oninput = () => { entry.base_url = endpoint.value.trim(); };
  card.appendChild(labeled("Endpoint", endpoint));

  const apiKey = document.createElement("input");
  apiKey.type = "password";
  apiKey.value = entry.api_key ?? "";
  apiKey.oninput = () => { entry.api_key = apiKey.value.trim(); };
  card.appendChild(labeled("API key", apiKey));

  const apiVersion = document.createElement("input");
  apiVersion.type = "text";
  apiVersion.value =
    entry.azure_api_version ??
    (entry.azure_mode === "azure_open_ai" ? "2024-10-21" : "2024-05-01-preview");
  apiVersion.oninput = () => { entry.azure_api_version = apiVersion.value.trim(); };
  card.appendChild(labeled("API version", apiVersion));

  if ((entry.azure_mode ?? "ai_inference") === "azure_open_ai") {
    const deployment = document.createElement("input");
    deployment.type = "text";
    deployment.placeholder = "e.g. gpt-4o-deployment";
    deployment.value = entry.azure_deployment ?? "";
    deployment.oninput = () => { entry.azure_deployment = deployment.value.trim(); };
    card.appendChild(labeled("Deployment", deployment));
  }

  const testBtn = document.createElement("button");
  testBtn.textContent = "Test connection";
  testBtn.type = "button";
  testBtn.className = "settings-btn";
  const status = document.createElement("span");
  status.className = "provider-status";
  testBtn.onclick = async () => {
    status.textContent = "…";
    try {
      const models = await listModelsAzureFoundry({
        endpoint: endpoint.value.trim(),
        apiKey: apiKey.value.trim(),
        mode: (entry.azure_mode ?? "ai_inference") as
          | "ai_inference"
          | "azure_open_ai",
        apiVersion: apiVersion.value.trim(),
      });
      status.textContent = `OK — ${models.length} models`;
    } catch (e) {
      status.textContent = `Error: ${String(e)}`;
    }
  };
  card.appendChild(testBtn);
  card.appendChild(status);
}

function labeled(text: string, input: HTMLElement): HTMLElement {
  const wrap = document.createElement("label");
  wrap.className = "field";
  const span = document.createElement("span");
  span.className = "settings-field-label";
  span.textContent = text;
  wrap.appendChild(span);
  wrap.appendChild(input);
  return wrap;
}
