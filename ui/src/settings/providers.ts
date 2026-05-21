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
    <select class="add-provider-preset">
      <option value="ollama">Ollama (http://localhost:11434/v1)</option>
      <option value="lmstudio">LM Studio (http://localhost:1234/v1)</option>
      <option value="custom">Custom OpenAI-compatible…</option>
    </select>
    <input class="add-provider-id" type="text" placeholder="id (e.g. ollama)" />
    <input class="add-provider-url" type="text" placeholder="base URL" />
    <button type="button" class="btn-secondary add-provider-confirm">Add</button>
    <button type="button" class="add-provider-cancel">Cancel</button>
  `;
  addBar.appendChild(formWrap);

  const preset = formWrap.querySelector<HTMLSelectElement>(".add-provider-preset")!;
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
    } else {
      idInput.value = "";
      urlInput.value = "http://localhost:8080/v1";
    }
  };
  applyPreset();
  preset.onchange = applyPreset;

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
    next.providers[id] = {
      kind: "openai_compat",
      label: id,
      base_url: url || "http://localhost:11434/v1",
    };
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
    keyInput.oninput = () => {
      const next = JSON.parse(JSON.stringify(settings)) as Settings;
      // Trim — pasted keys often pick up trailing whitespace which
      // Anthropic rejects without a clear error.
      next.providers![id] = { ...entry, api_key: keyInput.value.trim() };
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
