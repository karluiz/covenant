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

import { Icons } from "../icons";
import { pushInfoToast } from "../notifications/toast";
import { OperatorsPane } from "./operators";

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

interface TerminalConfig {
  font_family: string;
  font_size: number;
  letter_spacing: number;
  line_height: number;
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
  suppress_when_focused: boolean;
}

interface Settings {
  anthropic_api_key: string | null;
  agent: AgentConfig;
  operator: OperatorConfig;
  terminal: TerminalConfig;
  window: WindowConfig;
  aom: AomConfig;
  notifications: NotificationConfig;
  /// 3.7 — render the bottom status bar (git + runtime). Default true.
  status_bar_enabled: boolean;
  tabbar_position: TabbarPosition;
  ui_font_family: string | null;
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
        },
        terminal: {
          font_family:
            'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
          font_size: 13,
          letter_spacing: 0,
          line_height: 1.2,
        },
        window: { background: "vibrant" },
        aom: { default_budget_usd: 10 },
        notifications: {
          on_operator_escalate: true,
          on_aom_error: true,
          on_aom_complete: true,
          suppress_when_focused: true,
        },
        status_bar_enabled: true,
        tabbar_position: "top",
        ui_font_family: null,
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
      <a href="#sec-anthropic" data-target="sec-anthropic">Anthropic</a>
      <a href="#sec-models" data-target="sec-models">Models</a>
      <a href="#sec-appearance" data-target="sec-appearance">Appearance</a>
      <a href="#sec-terminal" data-target="sec-terminal">Terminal</a>
      <a href="#sec-operators" data-target="sec-operators">Operators</a>
      <a href="#sec-notifications" data-target="sec-notifications">Notifications</a>
    `;
    body.appendChild(nav);

    const form = document.createElement("form");
    form.className = "settings-form";
    form.setAttribute("novalidate", "");
    body.appendChild(form);

    form.innerHTML = `
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
              <input type="checkbox" name="notif_suppress_focused" />
              <span>Don't pop notifications when Covenant is focused</span>
            </span>
            <small class="settings-hint">
              Recommended on. Looking at the window already counts as
              "user is here" — the in-app banner / decision card has
              you covered.
            </small>
          </label>
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
    const termFont = form.querySelector<HTMLInputElement>('input[name="term_font"]')!;
    const termSize = form.querySelector<HTMLInputElement>('input[name="term_size"]')!;
    const termLetterSpacing = form.querySelector<HTMLInputElement>(
      'input[name="term_letter_spacing"]',
    )!;
    const termLineHeight = form.querySelector<HTMLInputElement>(
      'input[name="term_line_height"]',
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
    const notifSuppressFocused = form.querySelector<HTMLInputElement>(
      'input[name="notif_suppress_focused"]',
    )!;
    apiKey.value = this.current.anthropic_api_key ?? "";
    modelSummary.value = this.current.agent.model_summary;
    modelChat.value = this.current.agent.model_chat;
    maxCalls.value = String(this.current.agent.max_calls_per_minute);
    aomBudget.value = String(this.current.aom?.default_budget_usd ?? 10);
    termFont.value = this.current.terminal.font_family;
    termSize.value = String(this.current.terminal.font_size);
    termLetterSpacing.value = String(this.current.terminal.letter_spacing);
    termLineHeight.value = String(this.current.terminal.line_height);
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
      suppress_when_focused: true,
    };
    notifOpEscalate.checked = n.on_operator_escalate;
    notifAomError.checked = n.on_aom_error;
    notifAomComplete.checked = n.on_aom_complete;
    notifSuppressFocused.checked = n.suppress_when_focused;

    apiKey.focus();

    const opMount = form.querySelector<HTMLElement>("#operators-pane");
    if (opMount) {
      this.operatorsPane = new OperatorsPane(opMount);
      await this.operatorsPane.open();
    }

    form
      .querySelector<HTMLButtonElement>(".settings-toggle")!
      .addEventListener("click", (e) => {
        const btn = e.currentTarget as HTMLButtonElement;
        const target = btn.dataset.target;
        if (!target) return;
        const input = form.querySelector<HTMLInputElement>(`input[name="${target}"]`);
        if (!input) return;
        const showing = input.type === "text";
        input.type = showing ? "password" : "text";
        btn.textContent = showing ? "show" : "hide";
      });

    header
      .querySelector<HTMLButtonElement>(".settings-close")!
      .addEventListener("click", () => this.close());
    form
      .querySelector<HTMLButtonElement>(".settings-cancel")!
      .addEventListener("click", () => this.close());

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
        agent: {
          model_summary: modelSummary.value.trim() || "claude-sonnet-4-6",
          model_chat: modelChat.value.trim() || "claude-opus-4-7",
          max_calls_per_minute: Math.max(
            1,
            Math.min(60, Number(maxCalls.value) || 6),
          ),
        },
        operator: prevOp,
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
          suppress_when_focused: notifSuppressFocused.checked,
        },
        status_bar_enabled: statusBarEnabled.checked,
        tabbar_position:
          (Array.from(tabbarPosRadios).find((r) => r.checked)
            ?.value as TabbarPosition) || "top",
        ui_font_family: uiFont.value.trim() === "" ? null : uiFont.value.trim(),
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
