// Settings modal. Reads/writes via the get_settings / set_settings
// Tauri commands. Persists to ~/Library/Application Support/<bundle>/
// config.json (chmod 600) on the Rust side. The API key round-trips
// through this DOM in cleartext (it's the user's own machine and own
// key); the input is type=password so it's visually masked, with a
// per-field show/hide toggle.

import { invoke } from "@tauri-apps/api/core";

interface AgentConfig {
  model_summary: string;
  model_chat: string;
  max_calls_per_minute: number;
}

interface OperatorConfig {
  enabled_default: boolean;
  persona: string;
  executor_patterns: string[];
  idle_threshold_secs: number;
  max_decisions_per_minute: number;
  deny_extra_patterns: string[];
}

interface Settings {
  anthropic_api_key: string | null;
  agent: AgentConfig;
  operator: OperatorConfig;
}

async function getSettings(): Promise<Settings> {
  return invoke<Settings>("get_settings");
}

async function setSettings(settings: Settings): Promise<void> {
  return invoke<void>("set_settings", { settings });
}

export class SettingsPanel {
  private modal: HTMLElement | null = null;
  private current: Settings | null = null;

  constructor(private readonly mountHost: HTMLElement) {}

  isOpen(): boolean {
    return this.modal !== null;
  }

  async toggle(): Promise<void> {
    if (this.isOpen()) {
      this.close();
    } else {
      await this.open();
    }
  }

  async open(): Promise<void> {
    if (this.isOpen()) return;
    try {
      this.current = await getSettings();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("get_settings failed", err);
      this.current = {
        anthropic_api_key: null,
        agent: {
          model_summary: "claude-sonnet-4-6",
          model_chat: "claude-opus-4-7",
          max_calls_per_minute: 6,
        },
        operator: {
          enabled_default: false,
          persona: "",
          executor_patterns: [],
          idle_threshold_secs: 4,
          max_decisions_per_minute: 10,
          deny_extra_patterns: [],
        },
      };
    }
    this.render();
  }

  close(): void {
    if (!this.modal) return;
    this.modal.remove();
    this.modal = null;
    this.current = null;
  }

  private render(): void {
    if (!this.current) return;

    const overlay = document.createElement("div");
    overlay.className = "settings-overlay";
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) this.close();
    });

    const card = document.createElement("div");
    card.className = "settings-card";
    overlay.appendChild(card);

    card.innerHTML = `
      <header class="settings-header">
        <h2>Settings</h2>
        <button type="button" class="settings-close" aria-label="Close">×</button>
      </header>

      <form class="settings-form" novalidate>
        <fieldset>
          <legend>Anthropic</legend>
          <label class="settings-field">
            <span class="settings-label">API key</span>
            <div class="settings-input-row">
              <input
                type="password"
                name="api_key"
                placeholder="sk-ant-..."
                autocomplete="off"
                spellcheck="false"
              />
              <button type="button" class="settings-toggle" data-target="api_key">show</button>
            </div>
            <small class="settings-hint">
              Stored locally at <code>~/Library/Application Support/com.karluiz.karl-terminal/config.json</code> (chmod 600).
            </small>
          </label>
        </fieldset>

        <fieldset>
          <legend>Models</legend>
          <label class="settings-field">
            <span class="settings-label">Summary model</span>
            <input type="text" name="model_summary" autocomplete="off" spellcheck="false" />
            <small class="settings-hint">Used for per-session rolling summaries (frequent, cheap).</small>
          </label>
          <label class="settings-field">
            <span class="settings-label">Chat model (⌘K)</span>
            <input type="text" name="model_chat" autocomplete="off" spellcheck="false" />
            <small class="settings-hint">Used when you ask the agent a question.</small>
          </label>
          <label class="settings-field">
            <span class="settings-label">Max calls / minute / session</span>
            <input type="number" name="max_calls" min="1" max="60" />
          </label>
        </fieldset>

        <fieldset>
          <legend>Operator</legend>
          <p class="settings-hint" style="margin: 0 0 6px;">
            When an executor agent (claude code, copilot, opencode, aider…)
            pauses to ask you a routine question, the Operator can answer
            on your behalf — within the constraints below. Enable per-tab
            from the tab right-click menu. Currently in
            <strong>dry-run</strong>: proposed answers are logged, never
            typed.
          </p>
          <label class="settings-field">
            <span class="settings-label">Persona / authorization charter</span>
            <textarea
              name="operator_persona"
              rows="14"
              spellcheck="false"
              autocomplete="off"
            ></textarea>
            <small class="settings-hint">
              Plain English. Concatenated with the hard blocklist
              (rm&nbsp;-rf, sudo, force-push, secrets, …) which you cannot
              override. The Operator escalates when it isn't confident.
            </small>
          </label>
          <label class="settings-field">
            <span class="settings-label">Idle threshold (seconds)</span>
            <input type="number" name="op_idle" min="1" max="60" />
            <small class="settings-hint">Byte silence during a matching command before checking.</small>
          </label>
          <label class="settings-field">
            <span class="settings-label">Max decisions / minute / session</span>
            <input type="number" name="op_rate" min="1" max="60" />
          </label>
        </fieldset>

        <div class="settings-actions">
          <span class="settings-status" aria-live="polite"></span>
          <button type="button" class="settings-cancel">Cancel</button>
          <button type="submit" class="settings-save">Save</button>
        </div>
      </form>
    `;

    const apiKey = card.querySelector<HTMLInputElement>('input[name="api_key"]')!;
    const modelSummary = card.querySelector<HTMLInputElement>('input[name="model_summary"]')!;
    const modelChat = card.querySelector<HTMLInputElement>('input[name="model_chat"]')!;
    const maxCalls = card.querySelector<HTMLInputElement>('input[name="max_calls"]')!;
    const opPersona = card.querySelector<HTMLTextAreaElement>(
      'textarea[name="operator_persona"]',
    )!;
    const opIdle = card.querySelector<HTMLInputElement>('input[name="op_idle"]')!;
    const opRate = card.querySelector<HTMLInputElement>('input[name="op_rate"]')!;
    const status = card.querySelector<HTMLElement>(".settings-status")!;

    apiKey.value = this.current.anthropic_api_key ?? "";
    modelSummary.value = this.current.agent.model_summary;
    modelChat.value = this.current.agent.model_chat;
    maxCalls.value = String(this.current.agent.max_calls_per_minute);
    opPersona.value = this.current.operator.persona;
    opIdle.value = String(this.current.operator.idle_threshold_secs);
    opRate.value = String(this.current.operator.max_decisions_per_minute);

    apiKey.focus();

    card
      .querySelector<HTMLButtonElement>(".settings-toggle")!
      .addEventListener("click", (e) => {
        const btn = e.currentTarget as HTMLButtonElement;
        const target = btn.dataset.target;
        if (!target) return;
        const input = card.querySelector<HTMLInputElement>(`input[name="${target}"]`);
        if (!input) return;
        const showing = input.type === "text";
        input.type = showing ? "password" : "text";
        btn.textContent = showing ? "show" : "hide";
      });

    card
      .querySelector<HTMLButtonElement>(".settings-close")!
      .addEventListener("click", () => this.close());
    card
      .querySelector<HTMLButtonElement>(".settings-cancel")!
      .addEventListener("click", () => this.close());

    const form = card.querySelector<HTMLFormElement>(".settings-form")!;
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const prevOp = this.current!.operator;
      const next: Settings = {
        anthropic_api_key: apiKey.value.trim() === "" ? null : apiKey.value,
        agent: {
          model_summary: modelSummary.value.trim() || "claude-sonnet-4-6",
          model_chat: modelChat.value.trim() || "claude-opus-4-7",
          max_calls_per_minute: Math.max(
            1,
            Math.min(60, Number(maxCalls.value) || 6),
          ),
        },
        operator: {
          // M-OP1 only edits persona / idle / rate from the UI; keep
          // the rest as round-tripped (defaults seeded by Rust on load).
          enabled_default: prevOp.enabled_default,
          persona: opPersona.value,
          executor_patterns: prevOp.executor_patterns,
          idle_threshold_secs: Math.max(
            1,
            Math.min(60, Number(opIdle.value) || 4),
          ),
          max_decisions_per_minute: Math.max(
            1,
            Math.min(60, Number(opRate.value) || 10),
          ),
          deny_extra_patterns: prevOp.deny_extra_patterns,
        },
      };
      try {
        await setSettings(next);
        this.current = next;
        status.textContent = "saved ✓";
        status.classList.add("ok");
        setTimeout(() => this.close(), 600);
      } catch (err) {
        status.textContent = `save failed: ${String(err)}`;
        status.classList.add("err");
      }
    });

    this.mountHost.appendChild(overlay);
    this.modal = overlay;
  }
}
