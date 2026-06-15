import type { Settings, ProviderEntry } from "../api";
import { listModelsOpenAiCompat, listModelsAzureFoundry, testAnthropicKey } from "../api";
import { CustomSelect } from "../ui/select";
import { Icons } from "../icons";

/// Master/detail providers settings: left rail lists providers (with
/// status dots), right pane edits the selected one. State (selected id +
/// per-provider test results) is stashed on the root element so it
/// survives re-renders within the same settings open.

type TestStatus = "ok" | "warn" | "err" | "unknown";
interface TestResult {
  status: TestStatus;
  message?: string;
  count?: number;
  durationMs?: number;
  testedAt?: number;
}
interface PanelState {
  selectedId: string | null;
  testResults: Map<string, TestResult>;
}

interface RootWithState extends HTMLElement {
  __providersState?: PanelState;
}

function getState(root: HTMLElement): PanelState {
  const r = root as RootWithState;
  if (!r.__providersState) {
    r.__providersState = { selectedId: null, testResults: new Map() };
  }
  return r.__providersState;
}

export function renderProvidersTab(
  root: HTMLElement,
  settings: Settings,
  onChange: (next: Settings) => void,
): void {
  const state = getState(root);
  const providers = settings.providers ?? {};
  const ids = Object.keys(providers);

  /// Pick a default selection if none is set or the current one was deleted.
  if (state.selectedId == null || !providers[state.selectedId]) {
    state.selectedId = ids.includes("anthropic") ? "anthropic" : (ids[0] ?? null);
  }

  root.innerHTML = "";
  root.classList.add("providers-md");

  const frame = document.createElement("div");
  frame.className = "providers-md__frame";

  /// Left rail
  const rail = document.createElement("aside");
  rail.className = "providers-md__rail";
  rail.appendChild(renderRailHead(root, settings, onChange));
  rail.appendChild(renderRailList(root, settings, onChange));
  rail.appendChild(renderRailFoot(state, ids));
  frame.appendChild(rail);

  /// Right pane
  const pane = document.createElement("section");
  pane.className = "providers-md__pane";
  if (state.selectedId && providers[state.selectedId]) {
    renderDetailPane(pane, state.selectedId, providers[state.selectedId], settings, onChange, root);
  } else {
    renderEmptyPane(pane);
  }
  frame.appendChild(pane);

  root.appendChild(frame);
}

// ─────────────────────────────────────────────────────────────────────
// Rail
// ─────────────────────────────────────────────────────────────────────

function renderRailHead(
  root: HTMLElement,
  settings: Settings,
  onChange: (next: Settings) => void,
): HTMLElement {
  const head = document.createElement("div");
  head.className = "providers-md__rail-head";

  const label = document.createElement("span");
  label.className = "providers-md__rail-title";
  label.textContent = "Providers";
  head.appendChild(label);

  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "providers-md__rail-add";
  addBtn.title = "Add provider";
  addBtn.setAttribute("aria-label", "Add provider");
  addBtn.textContent = "+";
  addBtn.onclick = () => openAddDialog(root, settings, onChange);
  head.appendChild(addBtn);

  return head;
}

function renderRailList(
  root: HTMLElement,
  settings: Settings,
  onChange: (next: Settings) => void,
): HTMLElement {
  const state = getState(root);
  const list = document.createElement("div");
  list.className = "providers-md__rail-list";

  const providers = settings.providers ?? {};
  for (const [id, entry] of Object.entries(providers)) {
    list.appendChild(renderRailItem(id, entry, state, root, settings, onChange));
  }

  return list;
}

function renderRailItem(
  id: string,
  entry: ProviderEntry,
  state: PanelState,
  root: HTMLElement,
  settings: Settings,
  onChange: (next: Settings) => void,
): HTMLElement {
  const item = document.createElement("div");
  item.className = "providers-md__rail-item";
  if (id === state.selectedId) item.classList.add("is-active");

  const glyph = document.createElement("span");
  glyph.className = `providers-md__glyph providers-md__glyph--${providerGlyphKind(entry)}`;
  glyph.textContent = providerGlyphLetter(entry);
  item.appendChild(glyph);

  const text = document.createElement("div");
  text.className = "providers-md__rail-text";
  const name = document.createElement("div");
  name.className = "providers-md__rail-name";
  name.textContent = entry.label || id;
  const sub = document.createElement("div");
  sub.className = "providers-md__rail-sub";
  sub.textContent = providerPreview(entry);
  text.appendChild(name);
  text.appendChild(sub);
  item.appendChild(text);

  const dot = document.createElement("span");
  const status = state.testResults.get(id)?.status ?? "unknown";
  dot.className = `providers-md__dot providers-md__dot--${status}`;
  dot.title = statusLabel(status);
  item.appendChild(dot);

  item.onclick = () => {
    state.selectedId = id;
    renderProvidersTab(root, settings, onChange);
  };

  return item;
}

function renderRailFoot(state: PanelState, ids: string[]): HTMLElement {
  const foot = document.createElement("div");
  foot.className = "providers-md__rail-foot";
  if (ids.length === 0) {
    foot.textContent = "No providers configured";
    return foot;
  }
  const healthy = ids.filter((id) => state.testResults.get(id)?.status === "ok").length;
  foot.textContent = `${ids.length} provider${ids.length === 1 ? "" : "s"} · ${healthy} healthy`;
  return foot;
}

// ─────────────────────────────────────────────────────────────────────
// Detail pane
// ─────────────────────────────────────────────────────────────────────

function renderEmptyPane(pane: HTMLElement): void {
  pane.innerHTML = "";
  const empty = document.createElement("div");
  empty.className = "providers-md__empty";
  empty.innerHTML = `
    <div class="providers-md__empty-title">No provider selected</div>
    <div class="providers-md__empty-sub">Add a provider from the rail to get started.</div>
  `;
  pane.appendChild(empty);
}

function renderDetailPane(
  pane: HTMLElement,
  id: string,
  entry: ProviderEntry,
  settings: Settings,
  onChange: (next: Settings) => void,
  root: HTMLElement,
): void {
  pane.innerHTML = "";

  /// Header
  const head = document.createElement("header");
  head.className = "providers-md__pane-head";

  const glyph = document.createElement("span");
  glyph.className = `providers-md__pane-glyph providers-md__glyph--${providerGlyphKind(entry)}`;
  glyph.textContent = providerGlyphLetter(entry);
  head.appendChild(glyph);

  const titleWrap = document.createElement("div");
  titleWrap.className = "providers-md__pane-title-wrap";
  const title = document.createElement("div");
  title.className = "providers-md__pane-title";
  title.textContent = entry.label || id;
  const subId = document.createElement("div");
  subId.className = "providers-md__pane-subid";
  subId.textContent = `${id} · ${entry.kind}`;
  titleWrap.appendChild(title);
  titleWrap.appendChild(subId);
  head.appendChild(titleWrap);

  const statusPill = document.createElement("span");
  statusPill.className = "providers-md__pane-status";
  head.appendChild(statusPill);

  pane.appendChild(head);

  /// Endpoint section
  const endpointSection = document.createElement("div");
  endpointSection.className = "providers-md__section";
  const endpointHead = document.createElement("div");
  endpointHead.className = "providers-md__section-head";
  endpointHead.textContent = entry.kind === "anthropic" ? "Credentials" : "Endpoint";
  endpointSection.appendChild(endpointHead);

  const grid = document.createElement("div");
  grid.className = "providers-md__grid";
  endpointSection.appendChild(grid);

  let testRunner: (() => Promise<TestResult>) | null = null;

  if (entry.kind === "anthropic") {
    testRunner = renderAnthropicFields(grid, entry);
  } else if (entry.kind === "azure_foundry") {
    testRunner = renderFoundryFields(grid, id, entry, settings, onChange, root);
  } else {
    testRunner = renderOpenAiCompatFields(grid, entry);
  }

  /// Test row
  const testRow = document.createElement("div");
  testRow.className = "providers-md__test-row";
  const testBtn = document.createElement("button");
  testBtn.type = "button";
  testBtn.className = "providers-md__btn";
  testBtn.textContent = "Test connection";
  const testStat = document.createElement("span");
  testStat.className = "providers-md__test-stat";
  testRow.appendChild(testBtn);
  testRow.appendChild(testStat);
  endpointSection.appendChild(testRow);

  pane.appendChild(endpointSection);

  /// Footer (delete / save area)
  const foot = document.createElement("div");
  foot.className = "providers-md__pane-foot";

  if (id !== "anthropic") {
    const del = document.createElement("button");
    del.type = "button";
    del.className = "providers-md__btn providers-md__btn--danger";
    del.textContent = "Delete provider";
    del.onclick = () => {
      const next = JSON.parse(JSON.stringify(settings)) as Settings;
      next.providers = { ...next.providers };
      delete next.providers![id];
      const state = getState(root);
      state.testResults.delete(id);
      state.selectedId = null;
      onChange(next);
    };
    foot.appendChild(del);
  }

  pane.appendChild(foot);

  /// Render status pill from current state
  paintStatusPill(statusPill, getState(root).testResults.get(id));

  /// Wire test button
  if (testRunner) {
    const run = testRunner;
    testBtn.onclick = async () => {
      testStat.textContent = "Testing…";
      testStat.className = "providers-md__test-stat providers-md__test-stat--pending";
      try {
        const result = await run();
        const state = getState(root);
        state.testResults.set(id, { ...result, testedAt: Date.now() });
        paintTestStat(testStat, result);
        paintStatusPill(statusPill, result);
        const dot = root.querySelector<HTMLElement>(
          `.providers-md__rail-item.is-active .providers-md__dot`,
        );
        if (dot) {
          dot.className = `providers-md__dot providers-md__dot--${result.status}`;
        }
        updateRailFoot(root, settings);
      } catch (e) {
        const result: TestResult = { status: "err", message: String(e), testedAt: Date.now() };
        const state = getState(root);
        state.testResults.set(id, result);
        paintTestStat(testStat, result);
        paintStatusPill(statusPill, result);
      }
    };
  }

  /// Show last test result if we have one
  const last = getState(root).testResults.get(id);
  if (last) paintTestStat(testStat, last);
  else {
    testStat.textContent = "";
  }
}

function updateRailFoot(root: HTMLElement, settings: Settings): void {
  const state = getState(root);
  const ids = Object.keys(settings.providers ?? {});
  const foot = root.querySelector<HTMLElement>(".providers-md__rail-foot");
  if (!foot) return;
  if (ids.length === 0) {
    foot.textContent = "No providers configured";
    return;
  }
  const healthy = ids.filter((id) => state.testResults.get(id)?.status === "ok").length;
  foot.textContent = `${ids.length} provider${ids.length === 1 ? "" : "s"} · ${healthy} healthy`;
}

function paintTestStat(el: HTMLElement, r: TestResult): void {
  el.className = `providers-md__test-stat providers-md__test-stat--${r.status}`;
  if (r.status === "ok") {
    /// Providers can supply a custom OK message (e.g. Anthropic's
    /// "claude-haiku-4-5 · 1/1 tok") which replaces the generic
    /// "{count} models" rendering used by model-listing endpoints.
    const head = r.message ?? (r.count != null ? `${r.count} models` : "OK");
    const dur = r.durationMs != null ? ` · ${(r.durationMs / 1000).toFixed(2)}s` : "";
    el.textContent = `✓ ${head}${dur}`;
  } else if (r.status === "warn") {
    el.textContent = r.message ?? "Not tested";
  } else if (r.status === "err") {
    el.textContent = `Error: ${r.message ?? "request failed"}`;
  } else {
    el.textContent = r.message ?? "";
  }
}

function paintStatusPill(el: HTMLElement, r: TestResult | undefined): void {
  const status = r?.status ?? "unknown";
  el.className = `providers-md__pane-status providers-md__pane-status--${status}`;
  const dot = '<span class="providers-md__dot providers-md__dot--' + status + '"></span>';
  el.innerHTML = `${dot}<span>${statusLabel(status)}</span>`;
}

// ─────────────────────────────────────────────────────────────────────
// Per-kind field renderers
// ─────────────────────────────────────────────────────────────────────

/// Returns a testRunner callback the caller wires to the Test button.
function renderAnthropicFields(
  grid: HTMLElement,
  entry: ProviderEntry,
): () => Promise<TestResult> {
  const keyInput = makeInput("password", entry.api_key ?? "");
  keyInput.placeholder = "sk-ant-...";
  keyInput.oninput = () => { entry.api_key = keyInput.value.trim(); };
  grid.appendChild(makeLabel("API key"));
  grid.appendChild(wrapSecret(keyInput));

  return async () => {
    /// One-token live call against the Messages API (Haiku, max_tokens=1).
    /// Cost is ~$0.000002 per probe — negligible for a verification round-trip.
    if (!(entry.api_key && entry.api_key.length > 5)) {
      return { status: "warn", message: "Set an API key first" };
    }
    const t0 = performance.now();
    const r = await testAnthropicKey(entry.api_key);
    return {
      status: "ok",
      count: r.input_tokens + r.output_tokens,
      message: `${r.model} · ${r.input_tokens}/${r.output_tokens} in/out tok`,
      durationMs: performance.now() - t0,
    };
  };
}

function renderOpenAiCompatFields(
  grid: HTMLElement,
  entry: ProviderEntry,
): () => Promise<TestResult> {
  const urlInput = makeInput("text", entry.base_url ?? "http://localhost:11434/v1");
  urlInput.oninput = () => { entry.base_url = urlInput.value; };
  grid.appendChild(makeLabel("Base URL"));
  grid.appendChild(urlInput);

  return async () => {
    const t0 = performance.now();
    const models = await listModelsOpenAiCompat(urlInput.value);
    return {
      status: "ok",
      count: models.length,
      durationMs: performance.now() - t0,
    };
  };
}

function renderFoundryFields(
  grid: HTMLElement,
  _id: string,
  entry: ProviderEntry,
  _settings: Settings,
  _onChange: (next: Settings) => void,
  _root: HTMLElement,
): () => Promise<TestResult> {
  const modeSelect = new CustomSelect({
    className: "providers-md__select",
    ariaLabel: "Azure mode",
    value: entry.azure_mode ?? "ai_inference",
    options: [
      { value: "ai_inference", label: "AI Inference (/models)" },
      { value: "azure_open_ai", label: "Azure OpenAI (deployments)" },
    ],
  });
  grid.appendChild(makeLabel("Mode"));
  grid.appendChild(modeSelect.element);

  const endpoint = makeInput("text", entry.base_url ?? "");
  endpoint.placeholder = "https://my-resource.services.ai.azure.com";
  endpoint.oninput = () => { entry.base_url = endpoint.value.trim(); };
  grid.appendChild(makeLabel("Endpoint"));
  grid.appendChild(endpoint);

  const apiKey = makeInput("password", entry.api_key ?? "");
  apiKey.oninput = () => { entry.api_key = apiKey.value.trim(); };
  grid.appendChild(makeLabel("API key"));
  grid.appendChild(wrapSecret(apiKey));

  const apiVersion = makeInput(
    "text",
    entry.azure_api_version ??
      ((entry.azure_mode ?? "ai_inference") === "azure_open_ai" ? "2024-10-21" : "2024-05-01-preview"),
  );
  apiVersion.oninput = () => { entry.azure_api_version = apiVersion.value.trim(); };
  grid.appendChild(makeLabel("API version"));
  grid.appendChild(apiVersion);

  /// Deployment field is only relevant for AzureOpenAi mode. Build it
  /// once and toggle visibility on mode change so focus and persistence
  /// don't require a parent re-render.
  const deployLabel = makeLabel("Deployment");
  const deployInput = makeInput("text", entry.azure_deployment ?? "");
  deployInput.placeholder = "e.g. gpt-4o-deployment";
  deployInput.oninput = () => { entry.azure_deployment = deployInput.value.trim(); };
  grid.appendChild(deployLabel);
  grid.appendChild(deployInput);

  const toggleDeployVisibility = () => {
    const show = (entry.azure_mode ?? "ai_inference") === "azure_open_ai";
    deployLabel.style.display = show ? "" : "none";
    deployInput.style.display = show ? "" : "none";
  };
  toggleDeployVisibility();

  modeSelect.element.addEventListener("change", () => {
    const mode = modeSelect.value as "ai_inference" | "azure_open_ai";
    entry.azure_mode = mode;
    /// Swap default API version only when leaving the default.
    const defaultVersion = mode === "azure_open_ai" ? "2024-10-21" : "2024-05-01-preview";
    const customized =
      entry.azure_api_version &&
      entry.azure_api_version !== "2024-05-01-preview" &&
      entry.azure_api_version !== "2024-10-21";
    if (!customized) {
      entry.azure_api_version = defaultVersion;
      apiVersion.value = defaultVersion;
    }
    toggleDeployVisibility();
  });

  return async () => {
    const t0 = performance.now();
    const models = await listModelsAzureFoundry({
      endpoint: endpoint.value.trim(),
      apiKey: apiKey.value.trim(),
      mode: (entry.azure_mode ?? "ai_inference") as "ai_inference" | "azure_open_ai",
      apiVersion: apiVersion.value.trim(),
    });
    return {
      status: "ok",
      count: models.length,
      durationMs: performance.now() - t0,
    };
  };
}

// ─────────────────────────────────────────────────────────────────────
// Add-provider dialog (inline below the rail header)
// ─────────────────────────────────────────────────────────────────────

function openAddDialog(
  root: HTMLElement,
  settings: Settings,
  onChange: (next: Settings) => void,
): void {
  /// Avoid duplicate dialogs.
  if (root.querySelector(".providers-md__add-dialog")) return;

  const backdrop = document.createElement("div");
  backdrop.className = "providers-md__add-dialog";
  backdrop.innerHTML = `
    <div class="providers-md__add-card">
      <div class="providers-md__add-title">Add provider</div>
      <div class="providers-md__add-field">
        <label>Preset</label>
        <span class="providers-md__add-preset-host"></span>
      </div>
      <div class="providers-md__add-field">
        <label>Id</label>
        <input class="providers-md__add-id" type="text" placeholder="e.g. ollama" />
      </div>
      <div class="providers-md__add-field providers-md__add-field--url" data-show-when="needs-url">
        <label>Base URL</label>
        <input class="providers-md__add-url" type="text" placeholder="http://localhost:11434/v1" />
      </div>
      <div class="providers-md__add-footer">
        <button type="button" class="providers-md__btn providers-md__add-cancel">Cancel</button>
        <button type="button" class="providers-md__btn providers-md__btn--primary providers-md__add-confirm">Add</button>
      </div>
    </div>
  `;
  root.appendChild(backdrop);

  const presetHost = backdrop.querySelector<HTMLElement>(".providers-md__add-preset-host")!;
  const preset = new CustomSelect({
    className: "providers-md__select",
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

  const idInput = backdrop.querySelector<HTMLInputElement>(".providers-md__add-id")!;
  const urlInput = backdrop.querySelector<HTMLInputElement>(".providers-md__add-url")!;
  const urlField = backdrop.querySelector<HTMLElement>('[data-show-when="needs-url"]')!;
  const cancelBtn = backdrop.querySelector<HTMLButtonElement>(".providers-md__add-cancel")!;
  const confirmBtn = backdrop.querySelector<HTMLButtonElement>(".providers-md__add-confirm")!;

  const applyPreset = () => {
    if (preset.value === "ollama") {
      idInput.value = "ollama";
      urlInput.value = "http://localhost:11434/v1";
      urlField.style.display = "";
    } else if (preset.value === "lmstudio") {
      idInput.value = "lmstudio";
      urlInput.value = "http://localhost:1234/v1";
      urlField.style.display = "";
    } else if (preset.value === "azure_foundry") {
      idInput.value = "azure";
      urlInput.value = "";
      urlField.style.display = "none";
    } else {
      idInput.value = "";
      urlInput.value = "http://localhost:8080/v1";
      urlField.style.display = "";
    }
  };
  applyPreset();
  preset.element.addEventListener("change", applyPreset);

  const close = () => backdrop.remove();
  cancelBtn.onclick = close;
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
  document.addEventListener("keydown", function esc(e) {
    if (e.key === "Escape") { close(); document.removeEventListener("keydown", esc); }
  });

  confirmBtn.onclick = () => {
    const newId = idInput.value.trim();
    if (!newId) { idInput.focus(); return; }
    if (settings.providers?.[newId]) { idInput.focus(); return; }
    const next = JSON.parse(JSON.stringify(settings)) as Settings;
    next.providers = { ...(next.providers ?? {}) };
    if (preset.value === "azure_foundry") {
      next.providers[newId] = {
        kind: "azure_foundry",
        label: newId,
        base_url: "",
        api_key: "",
        azure_mode: "ai_inference",
        azure_api_version: "2024-05-01-preview",
      };
    } else {
      next.providers[newId] = {
        kind: "openai_compat",
        label: newId,
        base_url: urlInput.value.trim() || "http://localhost:11434/v1",
      };
    }
    getState(root).selectedId = newId;
    close();
    onChange(next);
  };

  setTimeout(() => idInput.focus(), 0);
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

function makeInput(type: string, value: string): HTMLInputElement {
  const el = document.createElement("input");
  el.type = type;
  el.className = "providers-md__input";
  el.value = value;
  return el;
}

function makeLabel(text: string): HTMLElement {
  const el = document.createElement("label");
  el.className = "providers-md__field-label";
  el.textContent = text;
  return el;
}

function wrapSecret(input: HTMLInputElement): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "providers-md__secret";
  wrap.appendChild(input);

  const reveal = document.createElement("button");
  reveal.type = "button";
  reveal.className = "providers-md__icon-btn";
  reveal.title = "Reveal";
  reveal.setAttribute("aria-label", "Reveal API key");
  reveal.innerHTML = Icons.eye({ size: 16 });
  reveal.onclick = () => {
    const revealed = input.type === "password";
    input.type = revealed ? "text" : "password";
    reveal.innerHTML = revealed ? Icons.eyeOff({ size: 16 }) : Icons.eye({ size: 16 });
  };
  wrap.appendChild(reveal);

  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "providers-md__icon-btn";
  copy.title = "Copy";
  copy.setAttribute("aria-label", "Copy API key to clipboard");
  copy.innerHTML = Icons.copy({ size: 16 });
  copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(input.value);
      copy.innerHTML = Icons.check({ size: 16 });
      setTimeout(() => (copy.innerHTML = Icons.copy({ size: 16 })), 1200);
    } catch {
      /// Clipboard may be denied in webview — silently no-op.
    }
  };
  wrap.appendChild(copy);

  return wrap;
}

function providerGlyphKind(entry: ProviderEntry): string {
  if (entry.kind === "anthropic") return "anthropic";
  if (entry.kind === "azure_foundry") return "azure";
  const url = (entry.base_url ?? "").toLowerCase();
  if (url.includes("1234")) return "lmstudio";
  if (url.includes("11434") || url.includes("ollama")) return "ollama";
  if (url.includes("openai.com")) return "openai";
  return "generic";
}

function providerGlyphLetter(entry: ProviderEntry): string {
  const kind = providerGlyphKind(entry);
  switch (kind) {
    case "anthropic": return "A";
    case "azure": return "◆";
    case "lmstudio": return "LM";
    case "ollama": return "OL";
    case "openai": return "◎";
    default: return (entry.label ?? entry.kind).slice(0, 2).toUpperCase();
  }
}

function providerPreview(entry: ProviderEntry): string {
  if (entry.kind === "anthropic") {
    const k = entry.api_key ?? "";
    if (!k) return "no key set";
    return `${k.slice(0, 7)}…${k.slice(-4)}`;
  }
  if (entry.kind === "azure_foundry") {
    const host = (entry.base_url ?? "").replace(/^https?:\/\//, "").replace(/\/$/, "");
    return host || "no endpoint";
  }
  const url = entry.base_url ?? "";
  return url.replace(/^https?:\/\//, "") || "no endpoint";
}

function statusLabel(s: TestStatus): string {
  switch (s) {
    case "ok": return "Connected";
    case "warn": return "Not tested";
    case "err": return "Failing";
    default: return "Not tested";
  }
}
