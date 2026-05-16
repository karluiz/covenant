import type { Settings, ProviderEntry } from "../api";
import { listModelsOpenAiCompat } from "../api";

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

  const addBtn = document.createElement("button");
  addBtn.textContent = "+ Add provider";
  addBtn.className = "btn-secondary";
  addBtn.onclick = () => {
    const id = prompt("Provider id (e.g. ollama, lmstudio):")?.trim();
    if (!id || settings.providers?.[id]) return;
    const next = JSON.parse(JSON.stringify(settings)) as Settings;
    next.providers = { ...(next.providers ?? {}) };
    next.providers[id] = {
      kind: "openai_compat",
      label: id,
      base_url: "http://localhost:11434/v1",
    };
    onChange(next);
  };
  root.appendChild(addBtn);
}

function renderProviderCard(
  id: string,
  entry: ProviderEntry,
  settings: Settings,
  onChange: (next: Settings) => void,
): HTMLElement {
  const card = document.createElement("div");
  card.className = "provider-card";

  const title = document.createElement("h3");
  title.textContent = `${entry.label} (${entry.kind})`;
  card.appendChild(title);

  if (entry.kind === "anthropic") {
    const keyInput = document.createElement("input");
    keyInput.type = "password";
    keyInput.placeholder = "sk-ant-...";
    keyInput.value = entry.api_key ?? "";
    keyInput.oninput = () => {
      const next = JSON.parse(JSON.stringify(settings)) as Settings;
      next.providers![id] = { ...entry, api_key: keyInput.value };
      onChange(next);
    };
    card.appendChild(labeled("API key", keyInput));
  } else {
    const urlInput = document.createElement("input");
    urlInput.type = "text";
    urlInput.value = entry.base_url ?? "http://localhost:11434/v1";
    urlInput.oninput = () => {
      const next = JSON.parse(JSON.stringify(settings)) as Settings;
      next.providers![id] = { ...entry, base_url: urlInput.value };
      onChange(next);
    };
    card.appendChild(labeled("Base URL", urlInput));

    const testBtn = document.createElement("button");
    testBtn.textContent = "Test connection";
    testBtn.type = "button";
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
    del.className = "btn-danger";
    del.onclick = () => {
      if (!confirm(`Delete provider "${id}"?`)) return;
      const next = JSON.parse(JSON.stringify(settings)) as Settings;
      next.providers = { ...next.providers };
      delete next.providers![id];
      onChange(next);
    };
    card.appendChild(del);
  }

  return card;
}

function labeled(text: string, input: HTMLElement): HTMLElement {
  const wrap = document.createElement("label");
  wrap.className = "field";
  const span = document.createElement("span");
  span.textContent = text;
  wrap.appendChild(span);
  wrap.appendChild(input);
  return wrap;
}
