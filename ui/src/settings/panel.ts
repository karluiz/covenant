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
import { listMonospaceFonts } from "../api";

import { Icons } from "../icons";
import { pushInfoToast } from "../notifications/toast";
import { OperatorsPane } from "./operators";
import { renderTelegramSection, type TelegramSettings } from "./telegram";
import { renderCodeIntelligenceSection, type CodeIntelligenceSettings } from "./code_intelligence";
import { renderProvidersTab } from "./providers";
import { renderModelsTab } from "./model_routes";
import { renderSpawnsTab } from "./spawns";
import { activateTab, type SettingsTab } from "./tabs";
import { CustomSelect } from "../ui/select";
import { applyCustomTabStyle, applyFoldedRailStyle, applyPresetTabStyle, applyTabbarPosition } from "../tabs/custom-style";
import type { FoldedRailStyle } from "../tabs/custom-style";
import { renderPublicProfileCard } from "../score/profile";
import { scheduleCloudPush } from "./cloud_push";
import { INDICATORS, applyIndicatorVisibility } from "../indicators";

function renderIndicatorChecklist(): string {
  const groups = [...new Set(INDICATORS.map((i) => i.group))];
  return groups
    .map(
      (g) => `
        <div class="settings-indicator-group">
          <span class="settings-sublabel">${g}</span>
          ${INDICATORS.filter((i) => i.group === g)
            .map(
              (i) => `
            <label class="settings-checkbox-row">
              <input type="checkbox" data-indicator-id="${i.id}" />
              <span>${i.label}</span>
            </label>`,
            )
            .join("")}
        </div>`,
    )
    .join("");
}

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
type ThemeMode = "dark" | "light" | "system" | "true_dark";
type TabStyle = "classic" | "forge" | "glass" | "crt";

interface WindowConfig {
  background: WindowBackground;
  theme?: ThemeMode;
  tab_style?: TabStyle;
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
  kind: "anthropic" | "openai_compat" | "azure_foundry";
  label: string;
  api_key?: string | null;
  base_url?: string | null;
  azure_mode?: "azure_open_ai" | "ai_inference" | null;
  azure_api_version?: string | null;
  azure_deployment?: string | null;
}

interface RouteEntry {
  provider_id: string;
  model: string;
}

interface ExperimentalConfig {
  split_panes?: boolean;
  statusbar_two_row?: boolean;
  internal_browser?: boolean;
  tab_styles?: TabStylesConfig;
}

interface TabStylesConfig {
  enabled: boolean;
  shape: TabShape;
  bg_mode: TabBgMode;
  bg_gradient?: [string, string];
  indicator: TabIndicator;
  height: TabHeight;
  gap: TabGap;
  group_shape?: GroupShape;
  group_bg?: GroupBg;
}

type TabShape = "rectangle" | "rounded" | "lofted" | "pill";
type TabBgMode = "solid" | "translucent" | "off" | "gradient";
type TabIndicator = "stripe" | "underline" | "left-bar" | "dot" | "glow" | "border";
type TabHeight = "normal" | "compact" | "spacious";
type TabGap = "normal" | "tight" | "loose";
type GroupShape = "match" | "rectangle" | "rounded" | "lofted" | "pill";
type GroupBg = "tinted" | "solid" | "off";

interface Settings {
  anthropic_api_key: string | null;
  sendgrid_api_key?: string | null;
  agent: AgentConfig;
  operator: OperatorConfig;
  terminal: TerminalConfig;
  window: WindowConfig;
  aom: AomConfig;
  notifications?: NotificationConfig;
  hidden_indicators: string[];
  /// 3.7 — render the bottom status bar (git + runtime). Default true.
  status_bar_enabled: boolean;
  /// Floating bottom-right notch overlay showing executor phase pills
  /// (Thinking / Reading / Running / Writing / Done). Default true.
  notch_enabled: boolean;
  notch_corner?:
    | "bottom-right"
    | "bottom-left"
    | "top-right"
    | "top-left"
    | "notch"
    | "notch-mini";
  notch_sound_on_done?: boolean;
  tabbar_position: TabbarPosition;
  folded_rail_style?: FoldedRailStyle;
  ui_font_family: string | null;
  familiars_enabled: boolean;
  is_premium: boolean;
  telegram?: TelegramSettings;
  providers?: Record<string, ProviderEntry>;
  model_routes?: Record<string, RouteEntry>;
  experimental?: ExperimentalConfig;
  code_intelligence?: CodeIntelligenceSettings;
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
  private panelBody: HTMLElement | null = null;
  private covenantMounted = false;
  private cloudSyncMounted = false;
  /// Monotonic token that invalidates an async `open()` still waiting on
  /// backend/settings subpanels. Without this, opening Settings and
  /// immediately opening another full-page panel can let the stale
  /// Settings render resume later and paint over that panel.
  private openGeneration = 0;

  private mountCovenantOnce(): void {
    if (this.covenantMounted) return;
    const root = document.getElementById("covenant-page-root");
    if (!root) return;
    this.covenantMounted = true;
    void import("../score/page").then((m) => m.mountCovenantPage(root));
  }

  /// Append the achievements card and the public profile card to the bottom
  /// of the Operators tab. Re-mounts if the section was wiped (DOM presence
  /// is the guard, so this survives any re-render of the operators pane).
  private mountAchievementsOnce(): void {
    const section = document.getElementById("sec-operators");
    if (!section) return;
    if (section.querySelector(".cov-ach-card")) return;
    const root = document.createElement("div");
    root.className = "cov-card cov-ach-card";
    root.style.marginTop = "16px";
    section.appendChild(root);
    void import("../score/achievements").then((m) => m.renderAchievementsCard(root));

    const pubHost = document.createElement("div");
    pubHost.style.marginTop = "14px";
    section.appendChild(pubHost);
    void renderPublicProfileCard(pubHost);
  }

  private mountCloudSyncOnce(): void {
    if (this.cloudSyncMounted) return;
    const root = document.getElementById("cloud-sync-root");
    if (!root) return;
    this.cloudSyncMounted = true;
    void import("./cloud_sync").then((m) => m.mountCloudSyncSection(root));
  }

  /// Optional callback fired whenever settings are saved. Used by main
  /// to push live updates (terminal font, operator state, etc.) into
  /// open tabs without requiring a restart.
  public onSaved: ((next: Settings) => void) | null = null;

  /// Fired as the user toggles Theme / Window-background radios, before
  /// saving, so chrome + xterm reflect the choice live. close() re-fires
  /// it with the persisted values to revert an unsaved preview.
  public onPreview:
    | ((p: { theme: ThemeMode; background: WindowBackground }) => void)
    | null = null;

  /// Optional callback fired when the page closes (any reason). Used
  /// by main to refit the active terminal once the workspace becomes
  /// visible again.
  public onClosed: (() => void) | null = null;

  /// Optional callback fired when the user clicks "Show tour again"
  /// or "Preview" in the Covenant section of Settings. Wired by main
  /// to the onboarding wizard; main owns the reset + reopen flow so
  /// the `SettingsPanel` stays decoupled from `onboarding/panel`.
  /// `opts.preview: true` opens the wizard without clearing the
  /// completion flag — used by the QA / demo button so a tester can
  /// replay the tour without losing their "I've done this" stamp.
  public onShowTour:
    | ((opts?: { preview?: boolean }) => Promise<void> | void)
    | null = null;

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

  async open(tab: SettingsTab = "providers"): Promise<void> {
    if (this.isOpen()) return;
    const generation = ++this.openGeneration;
    let current: Settings;
    try {
      current = await getSettings();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("get_settings failed", err);
      current = {
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
        hidden_indicators: [],
        status_bar_enabled: true,
        notch_enabled: true,
        notch_corner: "bottom-right",
        notch_sound_on_done: true,
        tabbar_position: "top",
        ui_font_family: null,
        familiars_enabled: false,
        is_premium: false,
        experimental: { split_panes: false, internal_browser: false },
      };
    }
    if (generation !== this.openGeneration) return;
    this.current = current;
    this.workspace.hidden = true;
    this.pageHost.hidden = false;
    this.isOpenState = true;
    await this.render(tab, generation);
    if (generation !== this.openGeneration) return;
    // Pull focus off the terminal so ESC reaches the bubble-phase
    // handlers. Without this, xterm.js's textarea swallows ESC (it has
    // focus when settings opens over it) and neither the sub-dialog ESC
    // handlers nor main.ts's global Esc-to-close ever fire. Settings has
    // its own layered sub-modals (operators/providers/avatar combobox)
    // that own ESC, so we deliberately do NOT add a capture-phase
    // handler here — that would close the whole page instead of the
    // sub-dialog. Focusing the page host fixes the root cause cleanly.
    this.pageHost.tabIndex = -1;
    this.pageHost.focus({ preventScroll: true });
  }

  close(): void {
    this.openGeneration++;

    // Live-preview revert: tab-style knobs apply as they're toggled, so
    // re-apply the persisted settings in case the user previewed and
    // bailed. After a save this.current already holds the new values,
    // making this a visual no-op.
    if (this.current) {
      applyTabbarPosition(this.current.tabbar_position ?? "top");
      applyFoldedRailStyle(this.current.folded_rail_style ?? "legacy");
      applyPresetTabStyle(this.current.window?.tab_style ?? "classic");
      applyCustomTabStyle(this.current.experimental?.tab_styles ?? null);
      applyIndicatorVisibility(this.current.hidden_indicators ?? []);
      this.onPreview?.({
        theme: this.current.window?.theme ?? "system",
        background: this.current.window?.background ?? "vibrant",
      });
    }

    // Be defensive: Settings.open()/render() does async work, and other
    // full-page panels (notably Set Mission) may ask us to close while
    // that work is still settling. If any stale DOM is present, always
    // remove it even if isOpenState already got out of sync; otherwise a
    // sticky .settings-actions footer can remain over the workspace.
    const hadVisibleState =
      this.isOpenState || !this.pageHost.hidden || this.pageHost.childElementCount > 0;

    this.pageHost.innerHTML = "";
    this.pageHost.hidden = true;
    if (hadVisibleState) this.workspace.hidden = false;
    this.isOpenState = false;
    this.current = null;
    this.panelBody = null;
    this.operatorsPane = null;
    this.covenantMounted = false;
    this.cloudSyncMounted = false;

    if (hadVisibleState && this.onClosed) this.onClosed();
  }

  private async render(
    tab: SettingsTab = "providers",
    generation: number = this.openGeneration,
  ): Promise<void> {
    if (!this.current || generation !== this.openGeneration) return;

    this.pageHost.innerHTML = "";

    const header = document.createElement("header");
    header.className = "settings-page-header";
    header.innerHTML = `
      <h2>Settings</h2>
      <button type="button" class="settings-close" aria-label="Close (Esc)"><kbd class="settings-esc">esc</kbd></button>
    `;
    this.pageHost.appendChild(header);

    const body = document.createElement("div");
    body.className = "settings-body";
    this.pageHost.appendChild(body);
    this.panelBody = body;

    const nav = document.createElement("nav");
    nav.className = "settings-nav";
    nav.innerHTML = `
      <div class="settings-nav-search">
        <input type="search" placeholder="Search settings…" aria-label="Search settings"
               autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" />
      </div>
      <div class="settings-nav-links">
      <a href="#sec-providers" data-target="sec-providers">Providers</a>
      <a href="#sec-models" data-target="sec-models">Inference</a>
      <a href="#sec-appearance" data-target="sec-appearance">Appearance</a>
      <a href="#sec-terminal" data-target="sec-terminal">Terminal</a>
      <a href="#sec-operators" data-target="sec-operators">Operators</a>
      <a href="#sec-spawns" data-target="sec-spawns">Spawns</a>
      <a href="#sec-updates" data-target="sec-updates">Updates</a>
      <a href="#sec-notifications" data-target="sec-notifications">Notifications</a>
      <a href="#sec-telegram" data-target="sec-telegram">Telegram</a>
      <a href="#sec-covenant" data-target="sec-covenant">Metrics</a>
      <a href="#sec-onboarding" data-target="sec-onboarding">Onboarding</a>
      <a href="#sec-workspace" data-target="sec-workspace">Workspace</a>
      <a href="#sec-cloud" data-target="sec-cloud">Covenant Cloud</a>
      <a href="#sec-experimental" data-target="sec-experimental">Experimental</a>
      </div>
      <div class="settings-nav-empty" hidden>No matching settings</div>
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
            Configure where LLM calls go. Anthropic is built-in — paste your API
            key in its card below. Add OpenAI-compatible endpoints (Ollama, LM
            Studio, llama.cpp) to route models locally.
          </p>
          <div id="providers-tab-root"></div>
        </section>
        <section class="settings-section" id="sec-models">
          <h3 class="settings-section-title">Inference</h3>
          <div id="models-routes-root"></div>
          <label class="settings-field">
            <span class="settings-label">Max calls / minute / session</span>
            <input type="number" name="max_calls" min="1" max="60" />
          </label>
        </section>
        <section class="settings-section" id="sec-appearance">
          <h3 class="settings-section-title">Appearance</h3>
          <fieldset class="settings-field settings-radio-group">
            <legend class="settings-label">Theme</legend>
            <label class="settings-radio">
              <input type="radio" name="theme" value="system" />
              <span class="settings-radio-body">
                <span class="settings-radio-title">System <span class="settings-badge">default</span></span>
                <span class="settings-radio-hint">Follows macOS appearance.</span>
              </span>
            </label>
            <label class="settings-radio">
              <input type="radio" name="theme" value="dark" />
              <span class="settings-radio-body">
                <span class="settings-radio-title">Dark</span>
                <span class="settings-radio-hint">Force the dark chrome and dark xterm palette.</span>
              </span>
            </label>
            <label class="settings-radio">
              <input type="radio" name="theme" value="true_dark" />
              <span class="settings-radio-body">
                <span class="settings-radio-title">True Dark <span class="settings-badge">OLED</span></span>
                <span class="settings-radio-hint">Neutral pure-black chrome — opaque, no blue tint, no wallpaper bleed-through.</span>
              </span>
            </label>
            <label class="settings-radio">
              <input type="radio" name="theme" value="light" />
              <span class="settings-radio-body">
                <span class="settings-radio-title">Light</span>
                <span class="settings-radio-hint">Force the light chrome and GitHub Light xterm palette.</span>
              </span>
            </label>
          </fieldset>
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
          <label class="settings-field">
            <span class="settings-label">Executor notch</span>
            <span class="settings-checkbox-row">
              <input type="checkbox" name="notch_enabled" />
              <span>Show floating pills for Claude/Codex/Pi activity</span>
            </span>
            <small class="settings-hint">
              Overlay surfacing the agent's current phase
              (Thinking, Reading, Running, Writing, Done). When off, the
              detector is skipped entirely — no overhead.
            </small>
          </label>
          <label class="settings-field">
            <span class="settings-label">Notch position</span>
            <span style="display:flex;gap:8px;align-items:stretch">
              <span data-role="notch-corner-select" style="flex:1"></span>
              <button type="button" data-role="notch-preview-btn"
                style="display:inline-flex;align-items:center;gap:6px;padding:0 14px;white-space:nowrap;background:var(--surface-2,#1c1c1e);color:var(--fg,#e5e7eb);border:1px solid var(--border,#2e2e30);cursor:pointer;font-size:12px;font-weight:600">
                <svg width="11" height="11" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><path d="M2 1.5v9l8-4.5z"/></svg>
                Test
              </button>
            </span>
            <small class="settings-hint">
              Where the status HUD anchors. “Notch” modes hang from the
              MacBook notch. Hit Test to preview.
            </small>
          </label>
          <label class="settings-field">
            <span class="settings-label">Done chime</span>
            <span class="settings-checkbox-row">
              <input type="checkbox" name="notch_sound_on_done" />
              <span>Play a short bell when an executor finishes</span>
            </span>
            <small class="settings-hint">
              Server-side deduped so a single agent turn never chimes
              twice, even if the agent emits multiple end-of-output
              markers.
            </small>
          </label>
          <label class="settings-field">
            <span class="settings-label">Indicators</span>
            <div class="settings-indicator-list">
              ${renderIndicatorChecklist()}
            </div>
            <small class="settings-hint">
              Uncheck an indicator to hide it from the titlebar, status
              bar, or left toolbar. Hidden indicators stop rendering; the
              features themselves keep working.
            </small>
          </label>
          <fieldset class="settings-field settings-radio-group">
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
          <fieldset class="settings-field settings-radio-group">
            <span class="settings-label">Folded sidebar</span>
            <label class="settings-radio">
              <input type="radio" name="folded_rail_style" value="legacy" />
              <span class="settings-radio-body">
                <span class="settings-radio-title">Legacy pills <span class="settings-badge">default</span></span>
                <span class="settings-radio-hint">Anonymous color pills with a group stripe — names on hover only.</span>
              </span>
            </label>
            <label class="settings-radio">
              <input type="radio" name="folded_rail_style" value="glyph" />
              <span class="settings-radio-body">
                <span class="settings-radio-title">Glyph tiles</span>
                <span class="settings-radio-hint">Monogram tiles with a color group badge — identifiable without hovering.</span>
              </span>
            </label>
            <label class="settings-radio">
              <input type="radio" name="folded_rail_style" value="labels" />
              <span class="settings-radio-body">
                <span class="settings-radio-title">Mini labels</span>
                <span class="settings-radio-hint">Truncated tab names under tiny group headers. Widest fold, most information.</span>
              </span>
            </label>
            <label class="settings-radio">
              <input type="radio" name="folded_rail_style" value="spine" />
              <span class="settings-radio-body">
                <span class="settings-radio-title">Segmented spine</span>
                <span class="settings-radio-hint">One segmented bar per group with its monogram on top. Densest.</span>
              </span>
            </label>
            <small class="settings-hint">Only applies when the tabbar is a left sidebar and you fold it with the chevron.</small>
          </fieldset>
          <fieldset class="settings-field settings-radio-group">
            <span class="settings-label">Tab style</span>
            <label class="settings-radio">
              <input type="radio" name="tab_style" value="classic" />
              <span class="settings-radio-body">
                <span class="settings-radio-title">Classic <span class="settings-badge">default</span></span>
                <span class="settings-radio-hint">Flat pills with a top accent stripe. The shipped look.</span>
              </span>
            </label>
            <label class="settings-radio">
              <input type="radio" name="tab_style" value="forge" />
              <span class="settings-radio-body">
                <span class="settings-radio-title">Forge</span>
                <span class="settings-radio-hint">Angled, mechanical tabs — the active one rises and lights a hot seam. Works in both top and left layouts.</span>
              </span>
            </label>
            <label class="settings-radio">
              <input type="radio" name="tab_style" value="glass" />
              <span class="settings-radio-body">
                <span class="settings-radio-title">Glass</span>
                <span class="settings-radio-hint">Frosted capsules with a single indicator that springs between tabs. Calm, premium. Both layouts.</span>
              </span>
            </label>
            <label class="settings-radio">
              <input type="radio" name="tab_style" value="crt" />
              <span class="settings-radio-body">
                <span class="settings-radio-title">CRT</span>
                <span class="settings-radio-hint">Terminal-brutalist — blinking caret, scanline glow, ASCII group headers. The screenshot magnet. Both layouts.</span>
              </span>
            </label>
            <label class="settings-radio">
              <input type="radio" name="tab_style" value="custom" />
              <span class="settings-radio-body">
                <span class="settings-radio-title">Custom <span class="settings-badge">experimental</span></span>
                <span class="settings-radio-hint">Compose your own from atomic knobs — shape, background, indicator, height, gap. Selecting this reveals the controls below.</span>
              </span>
            </label>
          </fieldset>
          <fieldset class="settings-field settings-radio-group" id="tab-style-custom-card" hidden>
            <span class="settings-label">Custom tab style <span class="settings-badge">experimental</span></span>
            <span class="settings-label" style="font-size:11px;font-weight:400;margin:-8px 0 8px;color:var(--muted)">Shape</span>
            <label class="settings-radio">
              <input type="radio" name="tab_custom_shape" value="rectangle" checked />
              <span class="settings-radio-body">
                <span class="settings-radio-title">Rectangle</span>
                <span class="settings-radio-hint">Sharp 90° corners — flat, utilitarian.</span>
              </span>
            </label>
            <label class="settings-radio">
              <input type="radio" name="tab_custom_shape" value="rounded" />
              <span class="settings-radio-body">
                <span class="settings-radio-title">Rounded</span>
                <span class="settings-radio-hint">6px border radius — gentle and approachable.</span>
              </span>
            </label>
            <label class="settings-radio">
              <input type="radio" name="tab_custom_shape" value="lofted" />
              <span class="settings-radio-body">
                <span class="settings-radio-title">Lofted</span>
                <span class="settings-radio-hint">12px radius — soft, elevated look.</span>
              </span>
            </label>
            <label class="settings-radio">
              <input type="radio" name="tab_custom_shape" value="pill" />
              <span class="settings-radio-body">
                <span class="settings-radio-title">Pill</span>
                <span class="settings-radio-hint">Fully rounded — macOS-style capsule.</span>
              </span>
            </label>
            <span class="settings-label" style="font-size:11px;font-weight:400;margin:8px 0 8px;color:var(--muted)">Background</span>
            <label class="settings-radio">
              <input type="radio" name="tab_custom_bg" value="solid" checked />
              <span class="settings-radio-body">
                <span class="settings-radio-title">Solid</span>
                <span class="settings-radio-hint">Opaque tab background — max contrast.</span>
              </span>
            </label>
            <label class="settings-radio">
              <input type="radio" name="tab_custom_bg" value="translucent" />
              <span class="settings-radio-body">
                <span class="settings-radio-title">Translucent</span>
                <span class="settings-radio-hint">Semi-transparent — lets wallpaper bleed through.</span>
              </span>
            </label>
            <label class="settings-radio">
              <input type="radio" name="tab_custom_bg" value="off" />
              <span class="settings-radio-body">
                <span class="settings-radio-title">Off</span>
                <span class="settings-radio-hint">Fully transparent — just text and indicator.</span>
              </span>
            </label>
            <label class="settings-radio">
              <input type="radio" name="tab_custom_bg" value="gradient" />
              <span class="settings-radio-body">
                <span class="settings-radio-title">Gradient</span>
                <span class="settings-radio-hint">Two-color gradient background.</span>
              </span>
            </label>
            <div id="tab-custom-gradient-pickers" style="display:flex;gap:8px;margin:6px 0 0 28px" hidden>
              <label style="display:flex;align-items:center;gap:4px;font-size:11px;color:var(--muted)">
                Start
                <input type="color" name="tab_custom_gradient_start" value="#7aa2f7" style="width:32px;height:28px;padding:0;border:none;border-radius:4px;cursor:pointer" />
              </label>
              <label style="display:flex;align-items:center;gap:4px;font-size:11px;color:var(--muted)">
                End
                <input type="color" name="tab_custom_gradient_end" value="#bb9af7" style="width:32px;height:28px;padding:0;border:none;border-radius:4px;cursor:pointer" />
              </label>
            </div>
            <span class="settings-label" style="font-size:11px;font-weight:400;margin:8px 0 8px;color:var(--muted)">Active indicator</span>
            <label class="settings-radio">
              <input type="radio" name="tab_custom_indicator" value="stripe" checked />
              <span class="settings-radio-body">
                <span class="settings-radio-title">Stripe</span>
                <span class="settings-radio-hint">Top-edge accent bar — the classic look.</span>
              </span>
            </label>
            <label class="settings-radio">
              <input type="radio" name="tab_custom_indicator" value="underline" />
              <span class="settings-radio-body">
                <span class="settings-radio-title">Underline</span>
                <span class="settings-radio-hint">Bottom-edge accent line — VS Code style.</span>
              </span>
            </label>
            <label class="settings-radio">
              <input type="radio" name="tab_custom_indicator" value="left-bar" />
              <span class="settings-radio-body">
                <span class="settings-radio-title">Left bar</span>
                <span class="settings-radio-hint">Vertical accent stripe on leading edge.</span>
              </span>
            </label>
            <label class="settings-radio">
              <input type="radio" name="tab_custom_indicator" value="dot" />
              <span class="settings-radio-body">
                <span class="settings-radio-title">Dot</span>
                <span class="settings-radio-hint">Small colored circle next to the label.</span>
              </span>
            </label>
            <label class="settings-radio">
              <input type="radio" name="tab_custom_indicator" value="glow" />
              <span class="settings-radio-body">
                <span class="settings-radio-title">Glow</span>
                <span class="settings-radio-hint">Box-shadow aura behind the active pill.</span>
              </span>
            </label>
            <label class="settings-radio">
              <input type="radio" name="tab_custom_indicator" value="border" />
              <span class="settings-radio-body">
                <span class="settings-radio-title">Border</span>
                <span class="settings-radio-hint">Colored outline around the active pill.</span>
              </span>
            </label>
            <span class="settings-label" style="font-size:11px;font-weight:400;margin:8px 0 8px;color:var(--muted)">Height</span>
            <label class="settings-radio">
              <input type="radio" name="tab_custom_height" value="compact" />
              <span class="settings-radio-body">
                <span class="settings-radio-title">Compact</span>
                <span class="settings-radio-hint">26px — denser tab bar, more tabs visible.</span>
              </span>
            </label>
            <label class="settings-radio">
              <input type="radio" name="tab_custom_height" value="normal" checked />
              <span class="settings-radio-body">
                <span class="settings-radio-title">Normal</span>
                <span class="settings-radio-hint">30px — the default height.</span>
              </span>
            </label>
            <label class="settings-radio">
              <input type="radio" name="tab_custom_height" value="spacious" />
              <span class="settings-radio-body">
                <span class="settings-radio-title">Spacious</span>
                <span class="settings-radio-hint">36px — roomier, easier to read.</span>
              </span>
            </label>
            <span class="settings-label" style="font-size:11px;font-weight:400;margin:8px 0 8px;color:var(--muted)">Gap</span>
            <label class="settings-radio">
              <input type="radio" name="tab_custom_gap" value="tight" />
              <span class="settings-radio-body">
                <span class="settings-radio-title">Tight</span>
                <span class="settings-radio-hint">2px between tabs — minimal spacing.</span>
              </span>
            </label>
            <label class="settings-radio">
              <input type="radio" name="tab_custom_gap" value="normal" checked />
              <span class="settings-radio-body">
                <span class="settings-radio-title">Normal</span>
                <span class="settings-radio-hint">4px — the default gap.</span>
              </span>
            </label>
            <label class="settings-radio">
              <input type="radio" name="tab_custom_gap" value="loose" />
              <span class="settings-radio-body">
                <span class="settings-radio-title">Loose</span>
                <span class="settings-radio-hint">8px — each tab breathes more.</span>
              </span>
            </label>
            <span class="settings-label" style="font-size:11px;font-weight:400;margin:8px 0 8px;color:var(--muted)">Group header shape</span>
            <label class="settings-radio">
              <input type="radio" name="tab_custom_group_shape" value="match" checked />
              <span class="settings-radio-body">
                <span class="settings-radio-title">Match tabs</span>
                <span class="settings-radio-hint">Group headers follow the tab Shape knob.</span>
              </span>
            </label>
            <label class="settings-radio">
              <input type="radio" name="tab_custom_group_shape" value="rectangle" />
              <span class="settings-radio-body">
                <span class="settings-radio-title">Rectangle</span>
                <span class="settings-radio-hint">Sharp 90° corners.</span>
              </span>
            </label>
            <label class="settings-radio">
              <input type="radio" name="tab_custom_group_shape" value="rounded" />
              <span class="settings-radio-body">
                <span class="settings-radio-title">Rounded</span>
                <span class="settings-radio-hint">6px border radius.</span>
              </span>
            </label>
            <label class="settings-radio">
              <input type="radio" name="tab_custom_group_shape" value="lofted" />
              <span class="settings-radio-body">
                <span class="settings-radio-title">Lofted</span>
                <span class="settings-radio-hint">12px radius — soft card look.</span>
              </span>
            </label>
            <label class="settings-radio">
              <input type="radio" name="tab_custom_group_shape" value="pill" />
              <span class="settings-radio-body">
                <span class="settings-radio-title">Pill</span>
                <span class="settings-radio-hint">Full capsule, whatever the height.</span>
              </span>
            </label>
            <span class="settings-label" style="font-size:11px;font-weight:400;margin:8px 0 8px;color:var(--muted)">Group header background</span>
            <label class="settings-radio">
              <input type="radio" name="tab_custom_group_bg" value="tinted" checked />
              <span class="settings-radio-body">
                <span class="settings-radio-title">Tinted</span>
                <span class="settings-radio-hint">Group-color card fill — the shipped look.</span>
              </span>
            </label>
            <label class="settings-radio">
              <input type="radio" name="tab_custom_group_bg" value="solid" />
              <span class="settings-radio-body">
                <span class="settings-radio-title">Solid</span>
                <span class="settings-radio-hint">Neutral tab background — no color tint.</span>
              </span>
            </label>
            <label class="settings-radio">
              <input type="radio" name="tab_custom_group_bg" value="off" />
              <span class="settings-radio-body">
                <span class="settings-radio-title">Off</span>
                <span class="settings-radio-hint">Transparent — just the color stripe and label.</span>
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
              list="settings-monospace-fonts"
              autocomplete="off"
              spellcheck="false"
              placeholder='ui-monospace, "JetBrains Mono", monospace'
            />
            <datalist id="settings-monospace-fonts"></datalist>
            <small class="settings-hint">
              CSS font stack. Start typing to pick from monospace fonts
              installed on this Mac, or paste a full stack. Always end with
              <code>monospace</code> as a fallback.
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
        <section class="settings-section" id="sec-code-intel"></section>
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
        <section class="settings-section" id="sec-spawns"></section>
        <section class="settings-section" id="sec-updates">
          <h3 class="settings-section-title">Updates</h3>
          <div class="updates-card" id="updates-card" data-state="idle">
            <div class="updates-card__header">
              <span class="updates-card__dot" id="updates-card-dot" aria-hidden="true"></span>
              <div class="updates-card__status">
                <span class="updates-card__title" id="updates-card-title">Check for updates</span>
                <span class="updates-card__sub" id="updates-card-sub">Checks GitHub Releases for a newer Covenant build. The app also checks silently on launch.</span>
              </div>
              <button type="button" class="updates-card__action" id="settings-check-updates">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>
                <span>Check now</span>
              </button>
            </div>
            <div class="updates-card__body">
              <div class="updates-card__ver">
                <div class="label">Installed</div>
                <div class="ver" id="updates-card-installed">—</div>
              </div>
              <div class="updates-card__ver">
                <div class="label">Latest on GitHub</div>
                <div class="ver" id="updates-card-latest">—</div>
                <div class="meta" id="updates-card-latest-meta">Not checked yet</div>
              </div>
            </div>
          </div>
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
        <section class="settings-section" id="sec-onboarding">
          <h3 class="settings-section-title">Onboarding</h3>
          <p class="settings-section-desc">Re-run the first-run tour at any time. Useful if you skipped it on install or want a refresher on the keyboard shortcuts and the super-agent.</p>
          <div class="settings-field">
            <span class="settings-label">First-run tour</span>
            <div class="settings-input-row">
              <button type="button" class="settings-save onboarding-replay" data-action="show-tour">${Icons.refresh({ size: 14 })}<span>Show tour again</span></button>
              <button type="button" class="settings-toggle" data-action="preview-tour">${Icons.play({ size: 14 })}<span>Preview (no reset)</span></button>
            </div>
            <small class="settings-hint">
              <strong>Show tour again</strong> clears your completion flag and pops the 10-step welcome wizard — finishing it stamps a fresh version so future updates can re-show it.
              <br />
              <strong>Preview</strong> opens the wizard without touching persisted state, for QA and demos.
            </small>
          </div>
        </section>
        <section class="settings-section" id="sec-covenant">
          <h3 class="settings-section-title">Metrics</h3>
          <p class="settings-section-desc">Track prompts and commits across your repos.</p>
          <div id="covenant-page-root"></div>
        </section>
        <section class="settings-section" id="sec-workspace">
          <h3 class="settings-section-title">Workspace</h3>
          <div class="settings-field">
            <span class="settings-label">Export / Import</span>
            <div class="settings-input-row">
              <button type="button" class="settings-toggle" data-ws-action="export">${Icons.download({ size: 14 })}<span>Export workspace…</span></button>
              <button type="button" class="settings-toggle" data-ws-action="import">${Icons.upload({ size: 14 })}<span>Import workspace…</span></button>
              <input type="file" accept="application/json,.json" data-ws-file hidden />
            </div>
            <small class="settings-hint">
              Saves all tabs, groups, and per-tab settings as a JSON file. Import replaces the current workspace.
            </small>
          </div>
        </section>
        <section class="settings-section" id="sec-cloud">
          <h3 class="settings-section-title">Covenant Cloud</h3>
          <div id="cloud-sync-root"></div>
        </section>
        <section class="settings-section" id="sec-experimental">
          <h3 class="settings-section-title">Experimental</h3>
          <p class="settings-section-desc">
            Features still in active development. They work, but may change,
            have rough edges, or carry a small performance cost. Toggle them
            on to try them — each can be turned off independently.
          </p>
          <label class="settings-field settings-field-row">
            <input type="checkbox" name="experimental_split_panes" />
            <span class="settings-label">Split panes</span>
            <small class="settings-hint">
              Split a tab into two panes, side-by-side or stacked. Each pane
              runs its own independent session, mission, and operator — useful
              for watching a long build in one pane while you work in the other.
              Shortcuts: <kbd>⌘D</kbd> split right,
              <kbd>⌘\</kbd> split down,
              <kbd>⌘[</kbd>/<kbd>⌘]</kbd> focus prev/next,
              <kbd>⌘⇧]</kbd> swap panes.
            </small>
          </label>
          <label class="settings-field settings-field-row">
            <input type="checkbox" name="experimental_statusbar_two_row" />
            <span class="settings-label">Two-row status bar</span>
            <small class="settings-hint">
              Lay the bottom status bar out over two rows — identity (mission
              name, branch) on top, telemetry (runtime, token cluster) below —
              so a long mission filename no longer pushes the runtime cluster
              off-screen. Uncheck for the original compact single-row layout.
            </small>
          </label>
          <label class="settings-field settings-field-row">
            <input type="checkbox" name="experimental_internal_browser" />
            <span class="settings-label">Internal browser</span>
            <small class="settings-hint">
              Open links and run quick web searches in a native webview pane
              inside Covenant, instead of bouncing out to your default browser.
              Early build — page occlusion and layout sync are still being
              tuned, so expect occasional redraw glitches when resizing panes.
            </small>
          </label>
        </section>
        <div class="settings-actions">
          <span class="settings-status" aria-live="polite"></span>
          <button type="button" class="settings-cancel">Cancel</button>
          <button type="submit" class="settings-save">Save</button>
        </div>
    `;

    const maxCalls = form.querySelector<HTMLInputElement>('input[name="max_calls"]')!;
    const aomBudget = form.querySelector<HTMLInputElement>('input[name="aom_budget"]')!;
    const mindV2Input = form.querySelector<HTMLInputElement>('input[name="mind_v2"]')!;
    const mindBudgetInput = form.querySelector<HTMLInputElement>('input[name="mind_thinking_budget"]')!;
    const termFont = form.querySelector<HTMLInputElement>('input[name="term_font"]')!;
    const fontDatalist = form.querySelector<HTMLDataListElement>(
      "#settings-monospace-fonts",
    );
    if (fontDatalist) {
      void listMonospaceFonts()
        .then((families) => {
          fontDatalist.replaceChildren(
            ...families.map((name) => {
              const opt = document.createElement("option");
              opt.value = name.includes(" ") ? `"${name}"` : name;
              opt.label = name;
              return opt;
            }),
          );
        })
        .catch(() => {/* best-effort; fall back to free-text */});
    }
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
    const splitPanesInput = form.querySelector<HTMLInputElement>(
      'input[name="experimental_split_panes"]',
    )!;
    const statusbarTwoRowInput = form.querySelector<HTMLInputElement>(
      'input[name="experimental_statusbar_two_row"]',
    )!;
    const internalBrowserInput = form.querySelector<HTMLInputElement>(
      'input[name="experimental_internal_browser"]',
    );
    const customTabStyleCard = form.querySelector<HTMLElement>("#tab-style-custom-card");
    const shapeRadios = form.querySelectorAll<HTMLInputElement>('input[name="tab_custom_shape"]');
    const bgRadios = form.querySelectorAll<HTMLInputElement>('input[name="tab_custom_bg"]');
    const gradientStart = form.querySelector<HTMLInputElement>('input[name="tab_custom_gradient_start"]');
    const gradientEnd = form.querySelector<HTMLInputElement>('input[name="tab_custom_gradient_end"]');
    const gradientPickers = form.querySelector<HTMLElement>("#tab-custom-gradient-pickers");
    const indicatorRadios = form.querySelectorAll<HTMLInputElement>('input[name="tab_custom_indicator"]');
    const heightRadios = form.querySelectorAll<HTMLInputElement>('input[name="tab_custom_height"]');
    const gapRadios = form.querySelectorAll<HTMLInputElement>('input[name="tab_custom_gap"]');
    const groupShapeRadios = form.querySelectorAll<HTMLInputElement>('input[name="tab_custom_group_shape"]');
    const groupBgRadios = form.querySelectorAll<HTMLInputElement>('input[name="tab_custom_group_bg"]');
    const windowBgRadios = form.querySelectorAll<HTMLInputElement>(
      'input[name="window_background"]',
    );
    const themeRadios = form.querySelectorAll<HTMLInputElement>(
      'input[name="theme"]',
    );
    const statusBarEnabled = form.querySelector<HTMLInputElement>(
      'input[name="status_bar_enabled"]',
    )!;
    const indicatorChecks = form.querySelectorAll<HTMLInputElement>(
      "input[data-indicator-id]",
    );
    const notchEnabled = form.querySelector<HTMLInputElement>(
      'input[name="notch_enabled"]',
    )!;
    const notchCornerHost = form.querySelector<HTMLElement>(
      '[data-role="notch-corner-select"]',
    )!;
    const notchCorner = new CustomSelect({
      className: "settings-select",
      ariaLabel: "Notch position",
      value: this.current.notch_corner ?? "bottom-right",
      options: [
        { value: "bottom-right", label: "Bottom right" },
        { value: "bottom-left", label: "Bottom left" },
        { value: "top-right", label: "Top right" },
        { value: "top-left", label: "Top left" },
        { value: "notch", label: "Notch (Dynamic Island)" },
        { value: "notch-mini", label: "Notch (minimal)" },
      ],
    });
    notchCornerHost.replaceWith(notchCorner.element);
    form
      .querySelector<HTMLButtonElement>('[data-role="notch-preview-btn"]')
      ?.addEventListener("click", () => {
        void invoke("notch_preview", { corner: notchCorner.value }).catch(() => {});
      });
    const notchSoundOnDone = form.querySelector<HTMLInputElement>(
      'input[name="notch_sound_on_done"]',
    )!;
    const tabbarPosRadios = form.querySelectorAll<HTMLInputElement>(
      'input[name="tabbar_position"]',
    );
    const foldedRailRadios = form.querySelectorAll<HTMLInputElement>(
      'input[name="folded_rail_style"]',
    );
    const tabStyleRadios = form.querySelectorAll<HTMLInputElement>(
      'input[name="tab_style"]',
    );
    // Selected Tab style radio value. "custom" is UI-only: it maps to
    // experimental.tab_styles.enabled, never to window.tab_style.
    const selectedTabStyle = (): string | undefined =>
      Array.from(tabStyleRadios).find((r) => r.checked)?.value;
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
    splitPanesInput.checked = !!this.current.experimental?.split_panes;
    statusbarTwoRowInput.checked =
      this.current.experimental?.statusbar_two_row ?? true;
    if (internalBrowserInput) internalBrowserInput.checked = !!this.current.experimental?.internal_browser;
    const ts = this.current.experimental?.tab_styles;
    if (customTabStyleCard) customTabStyleCard.hidden = !ts?.enabled;
    if (ts) {
      shapeRadios.forEach((r) => { r.checked = r.value === (ts.shape ?? "rectangle"); });
      bgRadios.forEach((r) => { r.checked = r.value === (ts.bg_mode ?? "solid"); });
      if (gradientPickers) gradientPickers.hidden = ts.bg_mode !== "gradient";
      if (gradientStart && ts.bg_gradient) gradientStart.value = ts.bg_gradient[0];
      if (gradientEnd && ts.bg_gradient) gradientEnd.value = ts.bg_gradient[1];
      indicatorRadios.forEach((r) => { r.checked = r.value === (ts.indicator ?? "stripe"); });
      heightRadios.forEach((r) => { r.checked = r.value === (ts.height ?? "normal"); });
      gapRadios.forEach((r) => { r.checked = r.value === (ts.gap ?? "normal"); });
      groupShapeRadios.forEach((r) => { r.checked = r.value === (ts.group_shape ?? "match"); });
      groupBgRadios.forEach((r) => { r.checked = r.value === (ts.group_bg ?? "tinted"); });
    }
    const currentBg = this.current.window?.background ?? "vibrant";
    windowBgRadios.forEach((r) => {
      r.checked = r.value === currentBg;
    });
    const currentTheme = this.current.window?.theme ?? "system";
    themeRadios.forEach((r) => {
      r.checked = r.value === currentTheme;
    });
    // Live preview: apply theme + window background the instant a radio is
    // clicked so the user sees what they're changing. close() reverts to the
    // persisted values if they bail without saving.
    const previewAppearance = (): void => {
      this.onPreview?.({
        theme: (Array.from(themeRadios).find((r) => r.checked)?.value ??
          "system") as ThemeMode,
        background: (Array.from(windowBgRadios).find((r) => r.checked)?.value ??
          "vibrant") as WindowBackground,
      });
    };
    [...themeRadios, ...windowBgRadios].forEach((r) =>
      r.addEventListener("change", previewAppearance),
    );
    statusBarEnabled.checked = this.current.status_bar_enabled ?? true;
    const hidden = new Set(this.current.hidden_indicators ?? []);
    indicatorChecks.forEach((cb) => {
      // dataset.indicatorId is safe: we rendered data-indicator-id ourselves above
      cb.checked = !hidden.has(cb.dataset.indicatorId!);
    });
    // Live preview: hide/show indicators as the user toggles, so they see
    // what they're leaving behind. close() reverts to the persisted set if
    // they bail without saving; submit() persists.
    const previewIndicators = (): void => {
      applyIndicatorVisibility(
        Array.from(indicatorChecks)
          .filter((cb) => !cb.checked)
          .map((cb) => cb.dataset.indicatorId!),
      );
    };
    indicatorChecks.forEach((cb) =>
      cb.addEventListener("change", previewIndicators),
    );
    notchEnabled.checked = this.current.notch_enabled ?? true;
    notchCorner.value = this.current.notch_corner ?? "bottom-right";
    notchSoundOnDone.checked = this.current.notch_sound_on_done ?? true;
    const currentTabbarPos = this.current.tabbar_position ?? "top";
    tabbarPosRadios.forEach((r) => {
      r.checked = r.value === currentTabbarPos;
    });
    const currentFoldedRail = this.current.folded_rail_style ?? "legacy";
    foldedRailRadios.forEach((r) => {
      r.checked = r.value === currentFoldedRail;
    });
    const currentTabStyle = ts?.enabled
      ? "custom"
      : (this.current.window?.tab_style ?? "classic");
    tabStyleRadios.forEach((r) => {
      r.checked = r.value === currentTabStyle;
    });
    uiFont.value = this.current.ui_font_family ?? "";
    const n: NotificationConfig = this.current.notifications ?? {
      on_operator_escalate: true,
      on_aom_error: true,
      on_aom_complete: true,
      on_executor_idle: true,
      suppress_when_focused: true,
      email_enabled: false,
      email_from: null,
      email_to: null,
      email_digest_window_minutes: 15,
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

    // Tab style "Custom" selected → reveal the knobs card
    tabStyleRadios.forEach((r) => {
      r.addEventListener("change", () => {
        if (customTabStyleCard) {
          customTabStyleCard.hidden = selectedTabStyle() !== "custom";
        }
      });
    });

    // Background mode "gradient" → show color pickers
    bgRadios.forEach((r) => {
      r.addEventListener("change", () => {
        if (gradientPickers) gradientPickers.hidden = r.value !== "gradient" || !r.checked;
      });
    });

    // Live preview — every tab-style knob applies to the real tabbar
    // the moment it changes, so the user sees the result without
    // saving. close() reverts to the persisted settings if they bail.
    const readTabStylesDraft = (): TabStylesConfig => ({
      enabled: selectedTabStyle() === "custom",
      shape:
        (Array.from(shapeRadios).find((r) => r.checked)?.value as TabShape) ??
        "rectangle",
      bg_mode:
        (Array.from(bgRadios).find((r) => r.checked)?.value as TabBgMode) ??
        "solid",
      bg_gradient:
        gradientStart && gradientEnd
          ? [gradientStart.value, gradientEnd.value]
          : undefined,
      indicator:
        (Array.from(indicatorRadios).find((r) => r.checked)
          ?.value as TabIndicator) ?? "stripe",
      height:
        (Array.from(heightRadios).find((r) => r.checked)
          ?.value as TabHeight) ?? "normal",
      gap:
        (Array.from(gapRadios).find((r) => r.checked)?.value as TabGap) ??
        "normal",
      group_shape:
        (Array.from(groupShapeRadios).find((r) => r.checked)
          ?.value as GroupShape) ?? "match",
      group_bg:
        (Array.from(groupBgRadios).find((r) => r.checked)
          ?.value as GroupBg) ?? "tinted",
    });
    const previewTabStyles = (): void => {
      // Same order as the saved-settings path in main.ts: preset class
      // first, then the custom layer (which strips presets when enabled).
      // "custom" matches no preset class, so it clears them all.
      applyPresetTabStyle(selectedTabStyle() ?? "classic");
      applyCustomTabStyle(readTabStylesDraft());
    };
    for (const group of [
      tabStyleRadios,
      shapeRadios,
      bgRadios,
      indicatorRadios,
      heightRadios,
      gapRadios,
      groupShapeRadios,
      groupBgRadios,
    ]) {
      group.forEach((r) => r.addEventListener("change", previewTabStyles));
    }
    gradientStart?.addEventListener("input", previewTabStyles);
    gradientEnd?.addEventListener("input", previewTabStyles);

    // Tabbar position previews instantly too — it only swaps a body
    // class; the terminal refit happens in onClosed either way.
    tabbarPosRadios.forEach((r) => {
      r.addEventListener("change", () => {
        applyTabbarPosition(
          (Array.from(tabbarPosRadios).find((x) => x.checked)
            ?.value as TabbarPosition) ?? "top",
        );
      });
    });

    // Folded-rail style previews instantly too — body class + rail
    // rebuild, no layout work beyond the collapsed column width.
    foldedRailRadios.forEach((r) => {
      r.addEventListener("change", () => {
        applyFoldedRailStyle(
          (Array.from(foldedRailRadios).find((x) => x.checked)
            ?.value as FoldedRailStyle) ?? "legacy",
        );
      });
    });

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

    const modelsRoutesRoot = form.querySelector<HTMLElement>("#models-routes-root");
    if (modelsRoutesRoot && this.current) {
      const renderModels = (): void => {
        if (!this.current || !modelsRoutesRoot) return;
        renderModelsTab(modelsRoutesRoot, this.current, (next) => {
          this.current = next;
          renderModels();
        });
      };
      renderModels();
    }

    const opMount = form.querySelector<HTMLElement>("#operators-pane");
    if (opMount) {
      this.operatorsPane = new OperatorsPane(opMount);
      await this.operatorsPane.open();
      if (generation !== this.openGeneration || !this.isOpenState) return;
    }

    const spawnsHost = form.querySelector<HTMLElement>("#sec-spawns");
    if (spawnsHost) {
      await renderSpawnsTab(spawnsHost);
      if (generation !== this.openGeneration || !this.isOpenState) return;
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
          scheduleCloudPush();
          if (this.onSaved) this.onSaved(this.current);
        },
      );
    }

    const ciHost = form.querySelector<HTMLElement>("#sec-code-intel");
    if (ciHost && this.current) {
      renderCodeIntelligenceSection(
        ciHost,
        { code_intelligence: this.current.code_intelligence },
        async (patch) => {
          if (!this.current) return;
          this.current.code_intelligence = patch.code_intelligence;
          await setSettings(this.current);
          scheduleCloudPush();
          if (this.onSaved) this.onSaved(this.current);
        },
      );
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

    // Updates section — manual "Check now" trigger. Populates the
    // status card with all three result kinds (available / uptodate /
    // error). Last-checked timestamp persists in localStorage so it
    // survives panel re-mounts and tells the user when the last
    // successful probe actually happened.
    const card = form.querySelector<HTMLElement>("#updates-card");
    const dot = form.querySelector<HTMLElement>("#updates-card-dot");
    const titleEl = form.querySelector<HTMLElement>("#updates-card-title");
    const subEl = form.querySelector<HTMLElement>("#updates-card-sub");
    const installedEl = form.querySelector<HTMLElement>("#updates-card-installed");
    const latestEl = form.querySelector<HTMLElement>("#updates-card-latest");
    const latestMeta = form.querySelector<HTMLElement>("#updates-card-latest-meta");
    const checkBtn = form.querySelector<HTMLButtonElement>("#settings-check-updates");
    const btnLabel = checkBtn?.querySelector<HTMLElement>("span");

    if (card && dot && titleEl && subEl && installedEl && latestEl && latestMeta && checkBtn && btnLabel) {
      const LS_KEY = "covenant:updates:last-check";
      type Persisted = { at: number; latest: string | null; ok: boolean };
      const readPersisted = (): Persisted | null => {
        try {
          const raw = localStorage.getItem(LS_KEY);
          return raw ? (JSON.parse(raw) as Persisted) : null;
        } catch {
          return null;
        }
      };
      const writePersisted = (p: Persisted): void => {
        try {
          localStorage.setItem(LS_KEY, JSON.stringify(p));
        } catch {
          /* quota / private mode — fine, this is best-effort */
        }
      };
      const formatAgo = (ts: number): string => {
        const secs = Math.max(1, Math.floor((Date.now() - ts) / 1000));
        if (secs < 60) return `${secs}s ago`;
        const mins = Math.floor(secs / 60);
        if (mins < 60) return `${mins} min ago`;
        const hrs = Math.floor(mins / 60);
        if (hrs < 24) return `${hrs} h ago`;
        const days = Math.floor(hrs / 24);
        return `${days} d ago`;
      };

      const hydrate = async (): Promise<void> => {
        const { getVersion } = await import("@tauri-apps/api/app");
        installedEl.textContent = `v${await getVersion()}`;
        const p = readPersisted();
        if (!p) return;
        if (p.latest) {
          latestEl.textContent = `v${p.latest}`;
          latestMeta.textContent = `Checked ${formatAgo(p.at)}`;
        }
        if (p.ok) {
          subEl.textContent = `Last checked ${formatAgo(p.at)} · also checks silently on launch`;
        }
      };
      void hydrate();

      const setState = (
        state: "idle" | "checking" | "uptodate" | "available" | "error",
        opts: { title?: string; sub?: string; latest?: string | null; latestMeta?: string } = {},
      ): void => {
        card.dataset.state = state;
        if (opts.title !== undefined) titleEl.textContent = opts.title;
        if (opts.sub !== undefined) subEl.textContent = opts.sub;
        if (opts.latest !== undefined) latestEl.textContent = opts.latest ?? "—";
        if (opts.latestMeta !== undefined) latestMeta.textContent = opts.latestMeta;
      };

      checkBtn.addEventListener("click", async () => {
        checkBtn.disabled = true;
        btnLabel.textContent = "Checking…";
        setState("checking", { title: "Checking GitHub Releases…", sub: "Fetching latest release metadata" });

        const { getVersion } = await import("@tauri-apps/api/app");
        const { runUpdateCheck } = await import("../updater/check");
        const { showUpdateBanner } = await import("../updater/banner");
        const currentVersion = await getVersion();
        const result = await runUpdateCheck({ currentVersion, silent: false });
        const now = Date.now();

        switch (result.kind) {
          case "available":
            setState("available", {
              title: `Update available — v${result.version}`,
              sub: "Download and install from the update banner",
              latest: `v${result.version}`,
              latestMeta: `New build available · checked just now`,
            });
            writePersisted({ at: now, latest: result.version, ok: true });
            showUpdateBanner(result.update);
            break;
          case "uptodate":
            setState("uptodate", {
              title: "Covenant is up to date",
              sub: `Last checked just now · also checks silently on launch`,
              latest: `v${result.currentVersion}`,
              latestMeta: `No newer release available`,
            });
            writePersisted({ at: now, latest: result.currentVersion, ok: true });
            break;
          case "error": {
            const prev = readPersisted();
            const since = prev?.ok ? ` You're on v${prev.latest ?? currentVersion} — last confirmed ${formatAgo(prev.at)}.` : "";
            setState("error", {
              title: "Couldn't check for updates right now",
              sub: `This is usually temporary — a new release may still be publishing, or you're offline. Try again in a few minutes.${since}`,
              latest: prev?.latest ? `v${prev.latest}` : "—",
              latestMeta: "Couldn't check just now",
            });
            writePersisted({ at: now, latest: prev?.latest ?? null, ok: false });
            break;
          }
        }
        btnLabel.textContent = result.kind === "error" ? "Retry" : "Check now";
        checkBtn.disabled = false;
      });
    }

    // Workspace export/import buttons. Hooks are wired by main.ts.
    const wsExportBtn = form.querySelector<HTMLButtonElement>('button[data-ws-action="export"]');
    const wsImportBtn = form.querySelector<HTMLButtonElement>('button[data-ws-action="import"]');
    const wsFile = form.querySelector<HTMLInputElement>('input[data-ws-file]');
    // "Show tour again" — fires the optional `onShowTour` hook wired
    // by main.ts to the onboarding wizard. No-op if main hasn't wired
    // it (defensive — the button is always present in the markup).
    const showTourBtn = form.querySelector<HTMLButtonElement>('button[data-action="show-tour"]');
    showTourBtn?.addEventListener("click", () => {
      if (!this.onShowTour) {
        pushInfoToast({ message: "Tour not available." });
        return;
      }
      this.close();
      void this.onShowTour();
    });
    // "Preview (no reset)" — same hook but without the persisted
    // reset. Lets QA / demos replay the wizard without losing the
    // user's "I've done this" stamp.
    const previewTourBtn = form.querySelector<HTMLButtonElement>('button[data-action="preview-tour"]');
    previewTourBtn?.addEventListener("click", () => {
      if (!this.onShowTour) {
        pushInfoToast({ message: "Tour not available." });
        return;
      }
      this.close();
      void this.onShowTour({ preview: true });
    });
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

    const goTo = (tab: SettingsTab) => {
      if (this.panelBody) activateTab(this.panelBody, tab);
      if (tab === "covenant") this.mountCovenantOnce();
      if (tab === "operators") this.mountAchievementsOnce();
      if (tab === "cloud") this.mountCloudSyncOnce();
    };

    // Sidebar nav: clicking a link shows only that section (tab mode).
    nav.addEventListener("click", (e) => {
      const a = (e.target as HTMLElement).closest<HTMLAnchorElement>("[data-target]");
      if (!a) return;
      e.preventDefault();
      goTo((a.dataset.target ?? "").replace(/^sec-/, "") as SettingsTab);
    });

    // Search: filter nav by section content (not just titles), jump only when
    // the active tab stops matching so content stays put while you refine.
    // Keywords cover sections that render empty until mounted (spawns/telegram/
    // metrics) and common synonyms not present in the visible copy.
    const SEARCH_KEYWORDS: Record<string, string> = {
      "sec-providers": "api key anthropic openai azure ollama lm studio endpoint llm credentials",
      "sec-models": "model routing default fallback",
      "sec-appearance": "theme dark light color font opacity accent sidebar folded rail collapsed",
      "sec-terminal": "shell font cursor scrollback keybindings shortcut hotkey",
      "sec-code-intel": "lsp language server rust-analyzer code intelligence diagnostics autocomplete hover",
      "sec-operators": "operator agent soul persona achievements skills",
      "sec-spawns": "spawn preset launch quick action",
      "sec-updates": "update version release auto-update channel",
      "sec-notifications": "email sendgrid notify alert sound",
      "sec-telegram": "telegram bot token chat message",
      "sec-covenant": "metrics score commits prompts tokens repo",
      "sec-onboarding": "onboarding tour wizard first-run welcome tutorial",
      "sec-workspace": "workspace directory folder repo path",
      "sec-cloud": "cloud sync backup restore operators specs preferences",
      "sec-experimental": "experimental beta flags browser",
    };
    const search = nav.querySelector<HTMLInputElement>(".settings-nav-search input");
    const empty = nav.querySelector<HTMLElement>(".settings-nav-empty");
    const links = Array.from(nav.querySelectorAll<HTMLAnchorElement>("a[data-target]"));
    search?.addEventListener("input", () => {
      const terms = search.value.toLowerCase().split(/\s+/).filter(Boolean);
      let firstMatch: SettingsTab | null = null;
      let activeStillShown = false;
      for (const a of links) {
        const secId = a.dataset.target ?? "";
        const sec = body.querySelector<HTMLElement>(`#${secId}`);
        const hay = `${a.textContent ?? ""} ${sec?.textContent ?? ""} ${SEARCH_KEYWORDS[secId] ?? ""}`.toLowerCase();
        const ok = terms.every((t) => hay.includes(t));
        a.style.display = ok ? "" : "none";
        const tab = secId.replace(/^sec-/, "") as SettingsTab;
        if (ok) {
          if (!firstMatch) firstMatch = tab;
          if (a.classList.contains("active")) activeStillShown = true;
        }
      }
      if (empty) empty.hidden = firstMatch !== null;
      if (firstMatch && !activeStillShown) goTo(firstMatch);
    });
    // Esc clears the filter (before the panel-close handler swallows it).
    search?.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && search.value) {
        e.stopPropagation();
        search.value = "";
        search.dispatchEvent(new Event("input"));
      }
    });

    // Activate the initial tab.
    activateTab(body, tab);
    if (tab === "covenant") this.mountCovenantOnce();
    if (tab === "operators") this.mountAchievementsOnce();
    if (tab === "cloud") this.mountCloudSyncOnce();

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const prevOp = this.current!.operator;
      const next: Settings = {
        anthropic_api_key: this.current!.providers?.anthropic?.api_key?.trim()
          ? this.current!.providers.anthropic.api_key
          : null,
        sendgrid_api_key: sendgridKeyInput.value.trim() === "" ? null : sendgridKeyInput.value,
        agent: {
          model_summary: this.current!.agent.model_summary,
          model_chat: this.current!.agent.model_chat,
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
          theme:
            (Array.from(themeRadios).find((r) => r.checked)
              ?.value as ThemeMode) || "system",
          tab_style:
            // "custom" is UI-only (maps to experimental.tab_styles.enabled);
            // keep the last real preset so disabling custom restores it.
            selectedTabStyle() === "custom"
              ? (this.current!.window?.tab_style ?? "classic")
              : ((selectedTabStyle() as TabStyle) || "classic"),
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
        hidden_indicators: Array.from(indicatorChecks)
          .filter((cb) => !cb.checked)
          .map((cb) => cb.dataset.indicatorId!),
        status_bar_enabled: statusBarEnabled.checked,
        notch_enabled: notchEnabled.checked,
        notch_corner: notchCorner.value as Settings["notch_corner"],
        notch_sound_on_done: notchSoundOnDone.checked,
        tabbar_position:
          (Array.from(tabbarPosRadios).find((r) => r.checked)
            ?.value as TabbarPosition) || "top",
        folded_rail_style:
          (Array.from(foldedRailRadios).find((r) => r.checked)
            ?.value as FoldedRailStyle) || "legacy",
        ui_font_family: uiFont.value.trim() === "" ? null : uiFont.value.trim(),
        familiars_enabled: this.current!.familiars_enabled,
        is_premium: this.current!.is_premium,
        telegram: this.current!.telegram,
        providers: this.current!.providers,
        model_routes: this.current!.model_routes,
        experimental: {
          split_panes: splitPanesInput.checked,
          statusbar_two_row: statusbarTwoRowInput.checked,
          internal_browser: internalBrowserInput?.checked ?? false,
          tab_styles: readTabStylesDraft(),
        },
      };
      try {
        await setSettings(next);
        scheduleCloudPush();
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
