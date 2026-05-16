// Settings page. Reads/writes via the get_settings / set_settings
// Tauri commands. Persists to ~/Library/Application Support/<bundle>/
// config.json (chmod 600) on the Rust side. The API key round-trips
// through this DOM in cleartext (it's the user's own machine and own
// key); the input is type=password so it's visually masked, with a
// per-field show/hide toggle.
//
// V2: rendered as a full PAGE (not a modal). When open it replaces
// the workspace; the tabbar stays visible. There's no outside-click
// dismiss — closing requires an explicit Cancel/Save/× — so multi-
// paragraph edits to the operator persona are never lost by accident.

import { invoke } from "@tauri-apps/api/core";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";

import { Icons } from "../icons";
import { pushInfoToast } from "../notifications/toast";
import { renderFamiliarsSettings } from "../familiars/settings_panel";
import { OperatorsPane } from "./operators";
import { renderTelegramSection, type TelegramSettings } from "./telegram";
import { renderProvidersTab } from "./providers";

function clampBudget(n: number): number {
  if (!Number.isFinite(n) || isNaN(n)) return 2000;
  return Math.max(500, Math.min(4000, Math.round(n)));
}

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
  mind_v2: boolean;
  mind_thinking_budget: number;
}

interface TerminalConfig {
  font_family: string;
  font_size: number;
  letter_spacing: number;
  line_height: number;
  ligatures: boolean;
}

type WindowBackground = "solid" | "vibrant" | "translucent";

interface WindowConfig {
  background: WindowBackground;
}

interface AomConfig {
  default_budget_usd: number;
}

interface NotificationConfig {
  on_operator_escalate: boolean;
  on_aom_error: boolean;
  on_aom_complete: boolean;
  on_executor_idle: boolean;
  suppress_when_focused: boolean;
  email_enabled: boolean;
  email_from?: string | null;
  email_to?: string | null;
  email_digest_window_minutes: number;
}

interface ProviderEntry {
  kind: "anthropic" | "openai_compat";
  label: string;
  api_key?: string | null;
  base_url?: string | null;
}

interface RouteEntry {
  provider_id: string;
  model: string;
}

interface Settings {
  anthropic_api_key: string | null;
  sendgrid_api_key?: string | null;
  agent: AgentConfig;
  operator: OperatorConfig;
  terminal: TerminalConfig;
  window: WindowConfig;
  aom: AomConfig;
  notifications?: NotificationConfig;
  /// 3.7 — render the bottom status bar (git + runtime). Default true.
  status_bar_enabled: boolean;
  tabbar_position: TabbarPosition;
  ui_font_family: string | null;
  familiars_enabled: boolean;
  is_premium: boolean;
  telegram?: TelegramSettings;
  providers?: Record<string, ProviderEntry>;
  model_routes?: Record<string, RouteEntry>;
}

type TabbarPosition = "top" | "left";

async function getSettings(): Promise<Settings> {
  return invoke<Settings>("get_settings");
}

async function setSettings(settings: Settings): Promise<void> {
  return invoke<void>("set_settings", { settings });
}

export class SettingsPanel {
  private isOpenState = false;
  private current: Settings | null = null;
  private operatorsPane: OperatorsPane | null = null;

  /// Optional callback fired whenever settings are saved. Used by main
  /// to push live updates (terminal font, operator state, etc.) into
  /// open tabs without requiring a restart.
  public onSaved: ((next: Settings) => void) | null = null;

  /// Optional callback fired when the page closes (any reason). Used
  /// by main to refit the active terminal once the workspace becomes
  /// visible again.
  public onClosed: (() => void) | null = null;

  /// Return the serialized tab manifest so the user can export their
  /// workspace from this panel. Wired by main.ts.
  public onExportWorkspace: (() => unknown) | null = null;

  /// Replace the live tab manifest from a parsed JSON object. Wired by
  /// main.ts; the panel passes the parsed payload straight through.
  public onImportWorkspace: ((parsed: unknown) => Promise<void> | void) | null = null;

  constructor(
    private readonly pageHost: HTMLElement,
    private readonly workspace: HTMLElement,
  ) {}

  isOpen(): boolean {
    return this.isOpenState;
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
          mind_v2: false,
          mind_thinking_budget: 2000,
        },
        terminal: {
          font_family:
            'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
          font_size: 13,
          letter_spacing: 0,
          line_height: 1.2,
          ligatures: false,
        },
        window: { background: "vibrant" },
        aom: { default_budget_usd: 10 },
        notifications: {
          on_operator_escalate: true,
          on_aom_error: true,
          on_aom_complete: true,
          on_executor_idle: true,
          suppress_when_focused: true,
          email_enabled: false,
          email_from: null,
          email_to: null,
          email_digest_window_minutes: 15,
        },
        status_bar_enabled: true,
        tabbar_position: "top",
        ui_font_family: null,
        familiars_enabled: false,
        is_premium: false,
      };
    }
    this.workspace.hidden = true;
    this.pageHost.hidden = false;
    this.isOpenState = true;
    await this.render();
  }

  close(): void {
    if (!this.isOpen()) return;
    this.pageHost.innerHTML = "";
    this.pageHost.hidden = true;
    this.workspace.hidden = false;
    this.isOpenState = false;
    this.current = null;
    if (this.onClosed) this.onClosed();
  }

  private async render(): Promise<void> {
    if (!this.current) return;

    this.pageHost.innerHTML = "";

    const header = document.createElement("header");
    header.className = "settings-page-header";
    header.innerHTML = `
      <h2>Settings</h2>
      <button type="button" class="settings-close" aria-label="Close" title="Close (Esc)">${Icons.x({ size: 14 })}</button>
    `;
    this.pageHost.appendChild(header);

    const body = document.createElement("div");
    body.className = "settings-body";
    this.pageHost.appendChild(body);

    const nav = document.createElement("nav");
    nav.className = "settings-nav";
    nav.innerHTML = `
      <a href="#sec-providers" data-target="sec-providers">Providers</a>
      <a href="#sec-anthropic" data-target="sec-anthropic">Anthropic</a>
      <a href="#sec-models" data-target="sec-models">Models</a>
      <a href="#sec-appearance" data-target="sec-appearance">Appearance</a>
      <a href="#sec-terminal" data-target="sec-terminal">Terminal</a>
      <a href="#sec-operators" data-target="sec-operators">Operators</a>
      <a href="#sec-updates" data-target="sec-updates">Updates</a>
      <a href="#sec-notifications" data-target="sec-notifications">Notifications</a>
      <a href="#sec-telegram" data-target="sec-telegram">Telegram</a>
      <a href="#sec-familiars" data-target="sec-familiars">Familiars</a>
      <a href="#sec-workspace" data-target="sec-workspace">Workspace</a>
    `;
    body.appendChild(nav);

    const form = document.createElement("form");
    form.className = "settings-form";
    form.setAttribute("novalidate", "");
    body.appendChild(form);

    form.innerHTML = `
        <section class="settings-section" id="sec-providers">
          <h3 class="settings-section-title">Providers</h3>
          <p class="settings-section-desc">
            Configure LLM providers. The built-in Anthropic provider uses your
            API key below. Add OpenAI-compatible endpoints (Ollama, LM Studio,
            etc.) to route models locally.
          </p>
          <div id="providers-tab-root"></div>
        </section>
        <section class="settings-section" id="sec-anthropic">
          <h3 class="settings-section-title">Anthropic</h3>
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
              Stored locally at <code>~/Library/Application Support/com.karluiz.covenant/config.json</code> (chmod 600).
            </small>
          </label>
        </section>
        <section class="settings-section" id="sec-models">
          <h3 class="settings-section-title">Models</h3>
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
        </section>
        <section class="settings-section" id="sec-appearance">
          <h3 class="settings-section-title">Appearance</h3>
          <fieldset class="settings-field settings-radio-group">
            <legend class="settings-label">Window background</legend>
            <label class="settings-radio">
              <input type="radio" name="window_background" value="solid" />
              <span class="settings-radio-body">
                <span class="settings-radio-title">Solid</span>
                <span class="settings-radio-hint">Fully opaque. Maximum text contrast — best for sunlit rooms or busy wallpapers.</span>
              </span>
            </label>
            <label class="settings-radio">
              <input type="radio" name="window_background" value="vibrant" />
              <span class="settings-radio-body">
                <span class="settings-radio-title">Vibrant <span class="settings-badge">default</span></span>
                <span class="settings-radio-hint">Moderate translucency. Wallpaper visible behind a dark tint, contrast stays comfortable.</span>
              </span>
            </label>
            <label class="settings-radio">
              <input type="radio" name="window_background" value="translucent" />
              <span class="settings-radio-body">
                <span class="settings-radio-title">Translucent</span>
                <span class="settings-radio-hint">Heavy translucency — most "wow", relies on the wallpaper behind for legibility.</span>
              </span>
            </label>
          </fieldset>
          <label class="settings-field">
            <span class="settings-label">Status bar</span>
            <span class="settings-checkbox-row">
              <input type="checkbox" name="status_bar_enabled" />
              <span>Show repo + runtime at the bottom of the window</span>
            </span>
            <small class="settings-hint">
              Detection is cwd-driven and runs only when the bar is visible.
            </small>
          </label>
          <fieldset class="settings-field">
            <span class="settings-label">Tabbar position</span>
            <label class="settings-radio">
              <input type="radio" name="tabbar_position" value="top" />
              <span class="settings-radio-body">
                <span class="settings-radio-title">Top <span class="settings-badge">default</span></span>
                <span class="settings-radio-hint">Horizontal tabbar across the top of the window.</span>
              </span>
            </label>
            <label class="settings-radio">
              <input type="radio" name="tabbar_position" value="left" />
              <span class="settings-radio-body">
                <span class="settings-radio-title">Left sidebar</span>
                <span class="settings-radio-hint">Vertical column on the left — better for long tab names and many tabs (Wave-style).</span>
              </span>
            </label>
          </fieldset>
          <label class="settings-field">
            <span class="settings-label">UI font</span>
            <input
              type="text"
              name="ui_font"
              autocomplete="off"
              spellcheck="false"
              placeholder='-apple-system, "SF Pro Text", system-ui, sans-serif'
            />
            <small class="settings-hint">
              CSS font stack for the chrome (settings, modals, panels,
              labels). Empty = system default. The terminal and editor
              keep their own font settings (above/below). Try
              <code>"Inter"</code>, <code>"IBM Plex Sans"</code>, or any
              installed sans family — always end with
              <code>sans-serif</code> as a fallback.
            </small>
          </label>
        </section>
        <section class="settings-section" id="sec-terminal">
          <h3 class="settings-section-title">Terminal</h3>
          <label class="settings-field">
            <span class="settings-label">Font family</span>
            <input
              type="text"
              name="term_font"
              autocomplete="off"
              spellcheck="false"
              placeholder='ui-monospace, "JetBrains Mono", monospace'
            />
            <small class="settings-hint">
              CSS font stack. Use the exact name macOS reports in Font Book
              (e.g. <code>"JetBrains Mono"</code>, <code>"Fira Code"</code>,
              <code>"Cascadia Code"</code>, <code>"Iosevka"</code>). Always
              end with <code>monospace</code> as a fallback.
            </small>
          </label>
          <label class="settings-field">
            <span class="settings-label">Font size</span>
            <input type="number" name="term_size" min="8" max="32" />
          </label>
          <label class="settings-field">
            <span class="settings-label">Letter spacing</span>
            <input type="number" name="term_letter_spacing" min="-10" max="10" step="1" />
            <small class="settings-hint">
              Pixels added between cells. <strong>Negative pulls cells closer</strong> —
              useful for ligature fonts (Comic Code, Fira, JetBrains) whose
              glyphs render narrower than the cell width xterm measures.
              Try <code>-2</code> for most ligature fonts; Comic Code often
              needs <code>-5</code> or lower.
            </small>
          </label>
          <label class="settings-field">
            <span class="settings-label">Line height</span>
            <input type="number" name="term_line_height" min="0.8" max="2" step="0.1" />
            <small class="settings-hint">Multiplier on cell height. 1.2 is the default.</small>
          </label>
          <label class="settings-field settings-field-row">
            <input type="checkbox" name="term_ligatures" />
            <span class="settings-label">Font ligatures</span>
            <small class="settings-hint">
              Enable shaping for fonts like Fira Code, JetBrains Mono,
              Comic Code. Slightly slower than the default renderer; off
              by default.
            </small>
          </label>
        </section>
        <section class="settings-section" id="sec-operators">
          <h3 class="settings-section-title">Operators</h3>
          <p class="settings-section-desc">
            Roster of personas the autonomous orchestrator can use. One operator
            is marked default and is used for any tab without an explicit pin.
          </p>
          <div id="operators-pane" class="operators-pane"></div>
          <h4 class="settings-subsection-title">Autonomous Operator Mode (AOM)</h4>
          <p class="settings-hint" style="margin: 0 0 6px;">
            Press <kbd>⌘⇧A</kbd> to enter AOM. Every tab is auto-enabled
            for the Operator while AOM is on; ⌘⇧A again reverts. The
            cost cap below auto-stops AOM when reached.
          </p>
          <label class="settings-field">
            <span class="settings-label">Default budget (USD)</span>
            <input
              type="number"
              name="aom_budget"
              min="0.1"
              max="500"
              step="0.5"
            />
            <small class="settings-hint">
              Hard ceiling per AOM session. AOM auto-stops the moment
              the running total reaches this. Set this generously for
              overnight runs ($10–50) and low ($1–2) when you're
              testing the wiring.
            </small>
          </label>
          <h4 class="settings-subsection-title">Operator Mind v2 (experimental)</h4>
          <p class="settings-hint" style="margin: 0 0 6px;">
            Per-tab persistent memory + extended thinking. The operator
            keeps a goal/belief/recent-turns tape across reboots. Spec 3.20.
          </p>
          <label class="settings-field">
            <span class="settings-checkbox-row">
              <input type="checkbox" name="mind_v2" />
              <span>Enable Mind v2 for new sessions</span>
            </span>
          </label>
          <label class="settings-field">
            <span class="settings-label">
              Intelligence
              <span class="settings-slider-value" data-for="mind_thinking_budget">2000 tok</span>
            </span>
            <input
              type="range"
              name="mind_thinking_budget"
              min="500"
              max="4000"
              step="100"
              class="settings-slider"
            />
            <span class="settings-slider-scale">
              <small>less</small>
              <small>more</small>
            </span>
            <small class="settings-hint">
              How much the model thinks before each decision. Less =
              cheaper and faster. More = better on ambiguous prompts.
            </small>
          </label>
        </section>
        <section class="settings-section" id="sec-updates">
          <h3 class="settings-section-title">Updates</h3>
          <p class="settings-hint" style="margin: 0 0 6px;">
            Checks GitHub Releases for a newer Covenant build. The app
            also checks silently on launch.
          </p>
          <label class="settings-field">
            <span class="settings-checkbox-row" style="cursor: default;">
              <span>Check for updates</span>
              <button type="button" class="settings-toggle" id="settings-check-updates">Check now</button>
            </span>
            <small class="settings-hint" id="settings-update-status">Checks GitHub for the latest version.</small>
          </label>
        </section>
        <section class="settings-section" id="sec-notifications">
          <h3 class="settings-section-title">Notifications</h3>
          <p class="settings-hint" style="margin: 0 0 6px;">
            Native macOS popups when Covenant needs attention. Each
            trigger throttles to one popup per 30s. Events are always
            logged via tracing — these toggles only affect the popup.
          </p>
          <label class="settings-field">
            <span class="settings-checkbox-row">
              <input type="checkbox" name="notif_op_escalate" />
              <span>Operator paused (ESCALATE)</span>
            </span>
          </label>
          <label class="settings-field">
            <span class="settings-checkbox-row">
              <input type="checkbox" name="notif_aom_error" />
              <span>AOM stopped on error (e.g., budget hit)</span>
            </span>
          </label>
          <label class="settings-field">
            <span class="settings-checkbox-row">
              <input type="checkbox" name="notif_aom_complete" />
              <span>AOM finished</span>
            </span>
          </label>
          <label class="settings-field">
            <span class="settings-checkbox-row">
              <input type="checkbox" name="notif_executor_idle" />
              <span>CLI agent is waiting</span>
            </span>
            <small class="settings-hint">
              Notify when an embedded agent (claude, copilot, opencode, …)
              goes idle waiting for input.
            </small>
          </label>
          <label class="settings-field">
            <span class="settings-checkbox-row">
              <input type="checkbox" name="notif_suppress_focused" />
              <span>Don't pop notifications when Covenant is focused</span>
            </span>
            <small class="settings-hint">
              Recommended on. Looking at the window already counts as
              "user is here" — the in-app banner / decision card has
              you covered.
            </small>
          </label>
          <h4 class="settings-subsection-title">Email (SendGrid)</h4>
          <label class="settings-field">
            <span class="settings-checkbox-row">
              <input type="checkbox" name="notif_email_enabled" />
              <span>Enable email notifications</span>
            </span>
          </label>
          <div id="email-incomplete-warn" class="settings-inline-warn" hidden>
            Email notifications need API key, from, and to.
          </div>
          <label class="settings-field">
            <span class="settings-label">SendGrid API key</span>
            <div class="settings-input-row">
              <input
                type="password"
                name="sendgrid_api_key"
                placeholder="SG...."
                autocomplete="off"
                spellcheck="false"
              />
              <button type="button" class="settings-toggle" data-target="sendgrid_api_key">show</button>
            </div>
            <div id="sendgrid-key-warn" class="settings-inline-warn" hidden>
              SendGrid rejected this API key — verify it on app.sendgrid.com.
            </div>
          </label>
          <label class="settings-field">
            <span class="settings-label">From email</span>
            <input type="email" name="notif_email_from" autocomplete="off" spellcheck="false" placeholder="you@example.com" />
          </label>
          <label class="settings-field">
            <span class="settings-label">To email</span>
            <input type="email" name="notif_email_to" autocomplete="off" spellcheck="false" placeholder="you@example.com" />
          </label>
          <label class="settings-field">
            <span class="settings-label">Digest window: <span id="digest-window-label">15</span> min</span>
            <input type="range" name="notif_email_digest" min="5" max="60" step="5" />
            <small class="settings-hint">Batch notifications within this window to avoid email spam.</small>
          </label>
        </section>
        <section class="settings-section" id="sec-telegram"></section>
        <section class="settings-section" id="familiars-host"></section>
        <section class="settings-section" id="sec-workspace">
          <h3 class="settings-section-title">Workspace</h3>
          <div class="settings-field">
            <span class="settings-label">Export / Import</span>
            <div class="settings-input-row">
              <button type="button" class="settings-toggle" data-ws-action="export">Export workspace…</button>
              <button type="button" class="settings-toggle" data-ws-action="import">Import workspace…</button>
              <input type="file" accept="application/json,.json" data-ws-file hidden />
            </div>
            <small class="settings-hint">
              Saves all tabs, groups, and per-tab settings as a JSON file. Import replaces the current workspace.
            </small>
          </div>
        </section>
        <div class="settings-actions">
          <span class="settings-status" aria-live="polite"></span>
          <button type="button" class="settings-cancel">Cancel</button>
          <button type="submit" class="settings-save">Save</button>
        </div>
    `;

    const apiKey = form.querySelector<HTMLInputElement>('input[name="api_key"]')!;
    const modelSummary = form.querySelector<HTMLInputElement>('input[name="model_summary"]')!;
    const modelChat = form.querySelector<HTMLInputElement>('input[name="model_chat"]')!;
    const maxCalls = form.querySelector<HTMLInputElement>('input[name="max_calls"]')!;
    const aomBudget = form.querySelector<HTMLInputElement>('input[name="aom_budget"]')!;
    const mindV2Input = form.querySelector<HTMLInputElement>('input[name="mind_v2"]')!;
    const mindBudgetInput = form.querySelector<HTMLInputElement>('input[name="mind_thinking_budget"]')!;
    const termFont = form.querySelector<HTMLInputElement>('input[name="term_font"]')!;
    const termSize = form.querySelector<HTMLInputElement>('input[name="term_size"]')!;
    const termLetterSpacing = form.querySelector<HTMLInputElement>(
      'input[name="term_letter_spacing"]',
    )!;
    const termLineHeight = form.querySelector<HTMLInputElement>(
      'input[name="term_line_height"]',
    )!;
    const termLigatures = form.querySelector<HTMLInputElement>(
      'input[name="term_ligatures"]',
    )!;
    const windowBgRadios = form.querySelectorAll<HTMLInputElement>(
      'input[name="window_background"]',
    );
    const statusBarEnabled = form.querySelector<HTMLInputElement>(
      'input[name="status_bar_enabled"]',
    )!;
    const tabbarPosRadios = form.querySelectorAll<HTMLInputElement>(
      'input[name="tabbar_position"]',
    );
    const uiFont = form.querySelector<HTMLInputElement>(
      'input[name="ui_font"]',
    )!;
    const notifOpEscalate = form.querySelector<HTMLInputElement>(
      'input[name="notif_op_escalate"]',
    )!;
    const notifAomError = form.querySelector<HTMLInputElement>(
      'input[name="notif_aom_error"]',
    )!;
    const notifAomComplete = form.querySelector<HTMLInputElement>(
      'input[name="notif_aom_complete"]',
    )!;
    const notifExecutorIdle = form.querySelector<HTMLInputElement>(
      'input[name="notif_executor_idle"]',
    )!;
    const notifSuppressFocused = form.querySelector<HTMLInputElement>(
      'input[name="notif_suppress_focused"]',
    )!;
    const notifEmailEnabled = form.querySelector<HTMLInputElement>(
      'input[name="notif_email_enabled"]',
    )!;
    const sendgridKeyInput = form.querySelector<HTMLInputElement>(
      'input[name="sendgrid_api_key"]',
    )!;
    const notifEmailFrom = form.querySelector<HTMLInputElement>(
      'input[name="notif_email_from"]',
    )!;
    const notifEmailTo = form.querySelector<HTMLInputElement>(
      'input[name="notif_email_to"]',
    )!;
    const notifEmailDigest = form.querySelector<HTMLInputElement>(
      'input[name="notif_email_digest"]',
    )!;
    const digestWindowLabel = form.querySelector<HTMLElement>('#digest-window-label')!;
    const emailIncompleteWarn = form.querySelector<HTMLElement>('#email-incomplete-warn')!;
    const sendgridKeyWarn = form.querySelector<HTMLElement>('#sendgrid-key-warn')!;

    apiKey.value = this.current.anthropic_api_key ?? "";
    modelSummary.value = this.current.agent.model_summary;
    modelChat.value = this.current.agent.model_chat;
    maxCalls.value = String(this.current.agent.max_calls_per_minute);
    aomBudget.value = String(this.current.aom?.default_budget_usd ?? 10);
    mindV2Input.checked = this.current.operator.mind_v2;
    mindBudgetInput.value = String(this.current.operator.mind_thinking_budget);
    const mindBudgetValue = form.querySelector<HTMLElement>(
      '.settings-slider-value[data-for="mind_thinking_budget"]',
    )!;
    const updateMindBudgetLabel = () => {
      mindBudgetValue.textContent = `${mindBudgetInput.value} tok`;
    };
    updateMindBudgetLabel();
    mindBudgetInput.addEventListener("input", updateMindBudgetLabel);
    termFont.value = this.current.terminal.font_family;
    termSize.value = String(this.current.terminal.font_size);
    termLetterSpacing.value = String(this.current.terminal.letter_spacing);
    termLineHeight.value = String(this.current.terminal.line_height);
    termLigatures.checked = !!this.current.terminal.ligatures;
    const currentBg = this.current.window?.background ?? "vibrant";
    windowBgRadios.forEach((r) => {
      r.checked = r.value === currentBg;
    });
    statusBarEnabled.checked = this.current.status_bar_enabled ?? true;
    const currentTabbarPos = this.current.tabbar_position ?? "top";
    tabbarPosRadios.forEach((r) => {
      r.checked = r.value === currentTabbarPos;
    });
    uiFont.value = this.current.ui_font_family ?? "";
    const n = this.current.notifications ?? {
      on_operator_escalate: true,
      on_aom_error: true,
      on_aom_complete: true,
      on_executor_idle: true,
      suppress_when_focused: true,
    };
    notifOpEscalate.checked = n.on_operator_escalate;
    notifAomError.checked = n.on_aom_error;
    notifAomComplete.checked = n.on_aom_complete;
    notifExecutorIdle.checked = n.on_executor_idle ?? true;
    notifSuppressFocused.checked = n.suppress_when_focused;
    notifEmailEnabled.checked = n.email_enabled ?? false;
    sendgridKeyInput.value = this.current.sendgrid_api_key ?? "";
    notifEmailFrom.value = n.email_from ?? "";
    notifEmailTo.value = n.email_to ?? "";
    const digestVal = n.email_digest_window_minutes ?? 15;
    notifEmailDigest.value = String(digestVal);
    digestWindowLabel.textContent = String(digestVal);

    const updateEmailIncompleteWarn = (): void => {
      const incomplete =
        notifEmailEnabled.checked &&
        (sendgridKeyInput.value.trim() === "" ||
          notifEmailFrom.value.trim() === "" ||
          notifEmailTo.value.trim() === "");
      emailIncompleteWarn.hidden = !incomplete;
    };

    notifEmailEnabled.addEventListener("change", updateEmailIncompleteWarn);
    sendgridKeyInput.addEventListener("input", () => {
      sendgridKeyWarn.hidden = true;
      updateEmailIncompleteWarn();
    });
    notifEmailFrom.addEventListener("input", updateEmailIncompleteWarn);
    notifEmailTo.addEventListener("input", updateEmailIncompleteWarn);

    notifEmailDigest.addEventListener("input", () => {
      digestWindowLabel.textContent = notifEmailDigest.value;
    });

    sendgridKeyInput.addEventListener("blur", () => {
      const val = sendgridKeyInput.value.trim();
      if (!val) return;
      void invoke<boolean>('validate_sendgrid_key', { apiKey: val }).then((ok) => {
        if (!ok) {
          sendgridKeyWarn.hidden = false;
        }
      }).catch(() => {
        // validation failure doesn't block save
      });
    });

    // Subscribe to backend-emitted key-invalid event (e.g. first-use rejection).
    void (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const unlisten = await listen<void>('sendgrid-key-invalid', () => {
        sendgridKeyWarn.hidden = false;
      });
      // Unlisten when form submits or panel closes (one-shot cleanup).
      const cleanup = (): void => { unlisten(); };
      form.addEventListener('submit', cleanup, { once: true });
      form.querySelector<HTMLButtonElement>('.settings-cancel')?.addEventListener('click', cleanup, { once: true });
      form.querySelector<HTMLButtonElement>('.settings-close')?.addEventListener('click', cleanup, { once: true });
    })();

    updateEmailIncompleteWarn();

    apiKey.focus();

    const providersRoot = form.querySelector<HTMLElement>("#providers-tab-root");
    if (providersRoot && this.current) {
      const renderProviders = (): void => {
        if (!this.current || !providersRoot) return;
        renderProvidersTab(providersRoot, this.current, (next) => {
          this.current = next;
          renderProviders();
        });
      };
      renderProviders();
    }

    const opMount = form.querySelector<HTMLElement>("#operators-pane");
    if (opMount) {
      this.operatorsPane = new OperatorsPane(opMount);
      await this.operatorsPane.open();
    }

    const tgHost = form.querySelector<HTMLElement>("#sec-telegram");
    if (tgHost && this.current) {
      renderTelegramSection(
        tgHost,
        { telegram: this.current.telegram },
        async (patch) => {
          if (!this.current) return;
          this.current.telegram = patch.telegram;
          await setSettings(this.current);
          if (this.onSaved) this.onSaved(this.current);
        },
      );
    }

    const familiarsHost = form.querySelector<HTMLElement>("#familiars-host");
    if (familiarsHost) {
      const persistFamiliars = async (): Promise<void> => {
        if (!this.current) return;
        await setSettings(this.current);
        if (this.onSaved) this.onSaved(this.current);
      };
      const renderFam = (): void => {
        if (!this.current) return;
        renderFamiliarsSettings(familiarsHost, {
          enabled: this.current.familiars_enabled,
          setEnabled: (v) => {
            if (!this.current) return;
            this.current.familiars_enabled = v;
            void persistFamiliars().then(() => renderFam());
          },
        });
      };
      renderFam();
    }

    form
      .querySelectorAll<HTMLButtonElement>(".settings-toggle")
      .forEach((toggleBtn) => {
        toggleBtn.addEventListener("click", (e) => {
          const btn = e.currentTarget as HTMLButtonElement;
          const target = btn.dataset.target;
          if (!target) return;
          const input = form.querySelector<HTMLInputElement>(`input[name="${target}"]`);
          if (!input) return;
          const showing = input.type === "text";
          input.type = showing ? "password" : "text";
          btn.textContent = showing ? "show" : "hide";
        });
      });

    header
      .querySelector<HTMLButtonElement>(".settings-close")!
      .addEventListener("click", () => this.close());
    form
      .querySelector<HTMLButtonElement>(".settings-cancel")!
      .addEventListener("click", () => this.close());

    // Updates section — manual "Check now" trigger. Mirrors the silent
    // boot-time check in main.ts but surfaces all three result kinds
    // (available / uptodate / error) inline so the user gets feedback.
    const checkBtn = form.querySelector<HTMLButtonElement>("#settings-check-updates");
    const statusEl = form.querySelector<HTMLElement>("#settings-update-status");
    if (checkBtn && statusEl) {
      checkBtn.addEventListener("click", async () => {
        checkBtn.disabled = true;
        statusEl.textContent = "Checking…";
        const { getVersion } = await import("@tauri-apps/api/app");
        const { runUpdateCheck } = await import("../updater/check");
        const { showUpdateBanner } = await import("../updater/banner");
        const currentVersion = await getVersion();
        const result = await runUpdateCheck({ currentVersion, silent: false });
        switch (result.kind) {
          case "available":
            statusEl.textContent = `Update available: v${result.version}`;
            showUpdateBanner(result.update);
            break;
          case "uptodate":
            statusEl.textContent = `You're on the latest version (v${result.currentVersion}).`;
            break;
          case "error":
            statusEl.textContent = `Check failed: ${result.message}`;
            break;
        }
        checkBtn.disabled = false;
      });
    }

    // Workspace export/import buttons. Hooks are wired by main.ts.
    const wsExportBtn = form.querySelector<HTMLButtonElement>('button[data-ws-action="export"]');
    const wsImportBtn = form.querySelector<HTMLButtonElement>('button[data-ws-action="import"]');
    const wsFile = form.querySelector<HTMLInputElement>('input[data-ws-file]');
    wsExportBtn?.addEventListener("click", async () => {
      if (!this.onExportWorkspace) {
        pushInfoToast({ message: "Export not available." });
        return;
      }
      try {
        const manifest = this.onExportWorkspace();
        const json = JSON.stringify(manifest, null, 2);
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        const path = await saveDialog({
          title: "Export workspace",
          defaultPath: `covenant-workspace-${ts}.json`,
          filters: [{ name: "JSON", extensions: ["json"] }],
        });
        if (!path) return;
        await invoke<void>("write_text_file", { path, contents: json });
        pushInfoToast({ message: "Workspace exported." });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("workspace export failed", err);
        pushInfoToast({ message: `Export failed: ${String(err)}` });
      }
    });
    wsImportBtn?.addEventListener("click", () => wsFile?.click());
    wsFile?.addEventListener("change", async () => {
      const file = wsFile.files?.[0];
      if (!file) return;
      if (!this.onImportWorkspace) {
        pushInfoToast({ message: "Import not available." });
        return;
      }
      try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        await this.onImportWorkspace(parsed);
        pushInfoToast({ message: "Workspace imported." });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("workspace import failed", err);
        pushInfoToast({ message: `Import failed: ${String(err)}` });
      } finally {
        wsFile.value = "";
      }
    });

    // Sidebar nav: smooth-scroll to anchored fieldset on click, and
    // highlight whichever section is in view via IntersectionObserver.
    const navLinks = nav.querySelectorAll<HTMLAnchorElement>("a[data-target]");
    navLinks.forEach((a) => {
      a.addEventListener("click", (e) => {
        e.preventDefault();
        const target = a.dataset.target;
        if (!target) return;
        const fs = form.querySelector<HTMLElement>(`#${target}`);
        fs?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });

    const sectionEls = Array.from(
      form.querySelectorAll<HTMLElement>("section.settings-section[id^='sec-']"),
    );
    const observer = new IntersectionObserver(
      (entries) => {
        // Pick the entry closest to the top of the viewport.
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort(
            (a, b) =>
              a.boundingClientRect.top - b.boundingClientRect.top,
          );
        if (visible.length === 0) return;
        const id = visible[0].target.id;
        navLinks.forEach((a) => {
          a.classList.toggle("active", a.dataset.target === id);
        });
      },
      { root: form, rootMargin: "0px 0px -60% 0px", threshold: 0 },
    );
    sectionEls.forEach((el) => observer.observe(el));

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const prevOp = this.current!.operator;
      const next: Settings = {
        anthropic_api_key: apiKey.value.trim() === "" ? null : apiKey.value,
        sendgrid_api_key: sendgridKeyInput.value.trim() === "" ? null : sendgridKeyInput.value,
        agent: {
          model_summary: modelSummary.value.trim() || "claude-sonnet-4-6",
          model_chat: modelChat.value.trim() || "claude-opus-4-7",
          max_calls_per_minute: Math.max(
            1,
            Math.min(60, Number(maxCalls.value) || 6),
          ),
        },
        operator: {
          ...prevOp,
          mind_v2: mindV2Input.checked,
          mind_thinking_budget: clampBudget(parseInt(mindBudgetInput.value, 10)),
        },
        terminal: {
          font_family:
            termFont.value.trim() ||
            'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
          font_size: Math.max(8, Math.min(32, Number(termSize.value) || 13)),
          letter_spacing: Math.max(
            -10,
            Math.min(10, Math.round(Number(termLetterSpacing.value) || 0)),
          ),
          line_height: Math.max(
            0.8,
            Math.min(2, Number(termLineHeight.value) || 1.2),
          ),
          ligatures: termLigatures.checked,
        },
        window: {
          background:
            (Array.from(windowBgRadios).find((r) => r.checked)
              ?.value as WindowBackground) || "vibrant",
        },
        aom: {
          default_budget_usd: Math.max(
            0.1,
            Math.min(500, Number(aomBudget.value) || 10),
          ),
        },
        notifications: {
          on_operator_escalate: notifOpEscalate.checked,
          on_aom_error: notifAomError.checked,
          on_aom_complete: notifAomComplete.checked,
          on_executor_idle: notifExecutorIdle.checked,
          suppress_when_focused: notifSuppressFocused.checked,
          email_enabled: notifEmailEnabled.checked,
          email_from: notifEmailFrom.value.trim() || null,
          email_to: notifEmailTo.value.trim() || null,
          email_digest_window_minutes: Math.max(5, Math.min(60, Number(notifEmailDigest.value) || 15)),
        },
        status_bar_enabled: statusBarEnabled.checked,
        tabbar_position:
          (Array.from(tabbarPosRadios).find((r) => r.checked)
            ?.value as TabbarPosition) || "top",
        ui_font_family: uiFont.value.trim() === "" ? null : uiFont.value.trim(),
        familiars_enabled: this.current!.familiars_enabled,
        is_premium: this.current!.is_premium,
        telegram: this.current!.telegram,
        providers: this.current!.providers,
        model_routes: this.current!.model_routes,
      };
      try {
        await setSettings(next);
        this.current = next;
        if (this.onSaved) this.onSaved(next);
        pushInfoToast({ message: "Settings saved" });
        setTimeout(() => this.close(), 400);
      } catch (err) {
        pushInfoToast({ message: `Save failed: ${String(err)}` });
      }
    });

  }
}
