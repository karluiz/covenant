// Settings → Code intelligence. Mirrors the telegram.ts / spawns.ts
// section pattern: a self-contained render(container, settings, save)
// mounted into an empty <section id="sec-code-intel"> by panel.ts.
//
// The master toggle and the per-language toggle both write into
// `settings.code_intelligence` — the same store `ui/src/lsp/manager.ts`
// reads for its download-consent check (P2 migration off localStorage).
// Ticking "Rust" here is equivalent to accepting the in-editor download
// banner: both add the language id to `consented_languages`.
import { lspDeleteServer, lspListInstalled, type LspInstalledServer } from "../api";
import { refreshCodeIntelSettings } from "../lsp/manager";

export interface CodeIntelligenceSettings {
  enabled: boolean;
  consented_languages: string[];
}

// P1 ships exactly one language; P3-P5 extend this table alongside
// `lspLanguageId` in manager.ts.
const KNOWN_LANGUAGES: Array<{ id: string; label: string }> = [
  { id: "rust", label: "Rust (rust-analyzer)" },
];

function formatSize(bytes: number): string {
  if (bytes <= 0) return "0 MB";
  const mb = bytes / (1024 * 1024);
  return mb >= 10 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
}

export function renderCodeIntelligenceSection(
  container: HTMLElement,
  settings: { code_intelligence?: CodeIntelligenceSettings },
  save: (patch: { code_intelligence: CodeIntelligenceSettings }) => Promise<void>,
): void {
  const ci: CodeIntelligenceSettings = settings.code_intelligence ?? {
    enabled: true,
    consented_languages: [],
  };
  const consented = new Set(ci.consented_languages);

  container.innerHTML = `
    <h3 class="settings-section-title">Code intelligence</h3>
    <p class="settings-section-desc">
      Language servers power inline diagnostics, hover info, and completions
      in the Structure editor. Each server downloads on first use, after you
      consent — either here or from the in-editor prompt.
    </p>
    <label class="settings-field"><span class="settings-checkbox-row">
      <input type="checkbox" id="ci-enabled" ${ci.enabled ? "checked" : ""}/>
      <span>Enable code intelligence</span>
    </span></label>
    <div class="settings-field">
      <span class="settings-label">Languages</span>
      ${KNOWN_LANGUAGES.map(
        (l) => `
        <label class="settings-checkbox-row">
          <input type="checkbox" class="ci-lang-toggle" data-language="${l.id}" ${consented.has(l.id) ? "checked" : ""}/>
          <span>${l.label}</span>
        </label>`,
      ).join("")}
    </div>
    <div class="settings-field">
      <span class="settings-label">Installed servers</span>
      <div class="ci-server-list" id="ci-server-list">
        <p class="settings-hint">Loading…</p>
      </div>
    </div>
  `;

  const persist = (patch: Partial<CodeIntelligenceSettings>): Promise<void> =>
    save({
      code_intelligence: {
        enabled: ci.enabled,
        consented_languages: [...consented],
        ...patch,
      },
    });

  container.querySelector<HTMLInputElement>("#ci-enabled")!.addEventListener("change", (e) => {
    ci.enabled = (e.currentTarget as HTMLInputElement).checked;
    void persist({ enabled: ci.enabled }).then(() => void refreshCodeIntelSettings());
  });

  container.querySelectorAll<HTMLInputElement>(".ci-lang-toggle").forEach((el) => {
    el.addEventListener("change", () => {
      const language = el.dataset.language ?? "";
      if (el.checked) consented.add(language);
      else consented.delete(language);
      void persist({ consented_languages: [...consented] }).then(() => void refreshCodeIntelSettings());
    });
  });

  const listHost = container.querySelector<HTMLElement>("#ci-server-list")!;
  void loadServerList(listHost);
}

async function loadServerList(host: HTMLElement): Promise<void> {
  let servers: LspInstalledServer[];
  try {
    servers = await lspListInstalled();
  } catch (e) {
    host.innerHTML = `<p class="settings-hint">Failed to load: ${escapeHtml(String(e))}</p>`;
    return;
  }
  renderServerList(host, servers.filter((s) => s.installed));
}

function renderServerList(host: HTMLElement, servers: LspInstalledServer[]): void {
  if (servers.length === 0) {
    host.innerHTML = `<p class="settings-hint">No language servers installed yet.</p>`;
    return;
  }
  host.replaceChildren();
  for (const s of servers) {
    const row = document.createElement("div");
    row.className = "ci-server-row";
    const info = document.createElement("span");
    info.className = "ci-server-info";
    info.textContent = `${s.name} ${s.version} — ${formatSize(s.sizeBytes)}`;
    const del = document.createElement("button");
    del.type = "button";
    del.className = "settings-btn is-danger";
    del.textContent = "Delete";
    del.addEventListener("click", () => {
      void deleteServer(host, s.language, del);
    });
    row.append(info, del);
    host.appendChild(row);
  }
}

async function deleteServer(host: HTMLElement, language: string, trigger: HTMLButtonElement): Promise<void> {
  trigger.disabled = true;
  try {
    await lspDeleteServer(language);
    await loadServerList(host);
  } catch (e) {
    trigger.disabled = false;
    trigger.textContent = "Delete failed";
    console.warn("[settings] lsp_delete_server failed", e);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
}
