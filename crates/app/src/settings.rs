//! Settings persistence for Covenant.
//!
//! Stored as JSON at `<config_dir>/config.json` where `<config_dir>` is
//! Tauri's per-app `app_config_dir` (on macOS:
//! `~/Library/Application Support/com.karluiz.covenant/`).
//!
//! Writes are atomic (tmp file + rename) and the on-disk file is
//! chmod'd to 0600 so only the current user can read it.
//!
//! M3.5 will optionally migrate `anthropic_api_key` to the macOS
//! Keychain via the `keyring` crate; this file stays as a fallback for
//! portability and debugging.

use std::collections::HashMap;
use std::fs;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use karl_agent::provider::ProviderKind;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Hash, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    Summary,
    Chat,
    Operator,
    Triage,
    SpecCreator,
    ContextMiner,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderEntry {
    pub kind: ProviderKind,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    // Azure Foundry only — ignored for other kinds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub azure_mode: Option<karl_agent::provider::azure_foundry::AzureMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub azure_api_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub azure_deployment: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RouteEntry {
    pub provider_id: String,
    pub model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExperimentalConfig {
    /// Enable the split-panes UI (M-SP milestone). Off by default; flip
    /// to `true` in config.json to try the feature while it is being
    /// developed.
    #[serde(default)]
    pub split_panes: bool,

    /// Show identity + telemetry on the top row of the status bar and
    /// the operator / mission / AOM cluster on a shorter bottom row.
    /// Default `true` (the layout that shipped in 8aee4f5). Flip off
    /// to use the original single-row layout.
    #[serde(default = "default_true")]
    pub statusbar_two_row: bool,

    /// Enable the internal browser panel. Off by default; flip to `true`
    /// in config.json to try the feature while it is being developed.
    #[serde(default)]
    pub internal_browser: bool,

    /// Atomic tab-style customization (shape, background, indicator, etc).
    /// When enabled, the monolithic preset radio buttons in Appearance are
    /// hidden and the user gets granular controls instead. When disabled,
    /// the Classic / Forge / Glass / CRT presets work as before.
    #[serde(default)]
    pub tab_styles: TabStylesConfig,
}

impl Default for ExperimentalConfig {
    fn default() -> Self {
        Self {
            split_panes: false,
            statusbar_two_row: true,
            internal_browser: false,
            tab_styles: TabStylesConfig::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TabStylesConfig {
    /// Master toggle — must be `true` for custom styles to apply.
    #[serde(default)]
    pub enabled: bool,
    /// Pill corner shape.
    #[serde(default)]
    pub shape: TabShape,
    /// Tab background mode.
    #[serde(default)]
    pub bg_mode: TabBgMode,
    /// Two-color gradient (start, end hex). Only used when `bg_mode` is
    /// `Gradient`. Ignored otherwise.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bg_gradient: Option<[String; 2]>,
    /// Active-tab indicator style.
    #[serde(default)]
    pub indicator: TabIndicator,
    /// Tab pill height.
    #[serde(default)]
    pub height: TabHeight,
    /// Gap between tab pills.
    #[serde(default)]
    pub gap: TabGap,
    /// Group-header chip shape. `Match` follows the tab `shape` knob.
    #[serde(default)]
    pub group_shape: GroupShape,
    /// Group-header chip background mode. `Tinted` is the shipped
    /// group-color card fill.
    #[serde(default)]
    pub group_bg: GroupBg,
}

impl Default for TabStylesConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            shape: TabShape::default(),
            bg_mode: TabBgMode::default(),
            bg_gradient: None,
            indicator: TabIndicator::default(),
            height: TabHeight::default(),
            gap: TabGap::default(),
            group_shape: GroupShape::default(),
            group_bg: GroupBg::default(),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TabShape {
    #[default]
    Rectangle,
    Rounded,
    Lofted,
    Pill,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TabBgMode {
    #[default]
    Solid,
    Translucent,
    Off,
    Gradient,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TabIndicator {
    #[default]
    Stripe,
    Underline,
    #[serde(rename = "left-bar")]
    LeftBar,
    Dot,
    Glow,
    Border,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TabHeight {
    #[default]
    Normal,
    Compact,
    Spacious,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TabGap {
    #[default]
    Normal,
    Tight,
    Loose,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum GroupShape {
    #[default]
    Match,
    Rectangle,
    Rounded,
    Lofted,
    Pill,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum GroupBg {
    #[default]
    Tinted,
    Solid,
    Off,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    /// Empty / whitespace-only values are normalized to `None` on save.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anthropic_api_key: Option<String>,

    /// SendGrid API key for outbound email notifications. Empty /
    /// whitespace-only values are normalized to `None` on save.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sendgrid_api_key: Option<String>,

    #[serde(default)]
    pub providers: HashMap<String, ProviderEntry>,

    #[serde(default = "default_model_routes")]
    pub model_routes: HashMap<Role, RouteEntry>,

    #[serde(default)]
    pub agent: AgentConfig,

    #[serde(default)]
    pub operator: OperatorConfig,

    #[serde(default)]
    pub terminal: TerminalConfig,

    #[serde(default)]
    pub window: WindowConfig,

    #[serde(default)]
    pub aom: AomConfig,

    #[serde(default)]
    pub experimental: ExperimentalConfig,

    #[serde(default)]
    pub notifications: NotificationConfig,

    /// 3.7 status bar — when false, the bar isn't rendered and no
    /// detection runs. Default true; controlled by a single toggle in
    /// the Settings → Appearance section.
    #[serde(default = "default_status_bar_enabled")]
    pub status_bar_enabled: bool,

    /// Executor notch overlay — floating bottom-right pills that show
    /// what Claude/Codex/Pi is currently doing (Thinking, Reading file,
    /// Running command, Done). When false, the detector skips ingest
    /// entirely so there's zero overhead. Default true.
    #[serde(default = "default_notch_enabled")]
    pub notch_enabled: bool,

    /// Which screen corner the floating notch overlay anchors to.
    /// Default bottom-right.
    #[serde(default)]
    pub notch_corner: NotchCorner,

    /// Play a short chime when an executor finishes a turn (Done).
    /// Deduplicated server-side so a single turn never plays twice.
    /// Default true.
    #[serde(default = "default_notch_sound_on_done")]
    pub notch_sound_on_done: bool,

    /// Ids of indicators (titlebar buttons, status-bar chips, left
    /// widgets) the user has hidden via Settings → Appearance →
    /// Indicators. Empty = everything visible. Ids are defined in the
    /// frontend registry `ui/src/indicators.ts`; unknown ids are ignored.
    #[serde(default)]
    pub hidden_indicators: Vec<String>,

    /// Layout of the tabbar — horizontal across the top (default) or a
    /// fixed vertical column on the left, à la Wave Terminal. Frontend
    /// toggles `body.tabbar-left` from this value.
    #[serde(default)]
    pub tabbar_position: TabbarPosition,

    /// Visual style of the folded left sidebar (the collapsed rail).
    /// Purely cosmetic — the frontend toggles `body.tabbar-rail-<style>`
    /// and the rail component branches its DOM on it. `Legacy` is the
    /// shipped anonymous-pills look.
    #[serde(default)]
    pub folded_rail_style: FoldedRailStyle,

    /// Optional CSS font stack for the UI chrome (panels, settings,
    /// modals, group chip labels). `None` = use the built-in
    /// system-sans default. The terminal/editor have their own font
    /// settings; this only controls the rest of the app's typography.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ui_font_family: Option<String>,

    /// Unix-ms when we last imported `~/.zsh_history` into the blocks
    /// table for Recall. `None` means we've never imported and the
    /// next launch will run the one-shot import.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub zsh_history_imported_at_unix_ms: Option<u64>,

    /// Familiars: per-session AI companion with its own memory.
    /// BYOK — the user pays Anthropic directly via their own API key,
    /// so there is no premium gate; the feature is purely opt-in.
    #[serde(default)]
    pub familiars_enabled: bool,

    #[serde(default)]
    pub telegram: TelegramSettings,

    #[serde(default)]
    pub cloud_sync: CloudSyncConfig,

    /// First-run onboarding wizard. `false` on a clean install so the
    /// wizard pops on the next launch. Set to `true` from the wizard's
    /// "Done" / "Skip" actions (or from Settings → "Show tour again",
    /// which flips it back to `false`). Bumping `onboarding_version`
    /// re-shows the wizard for users who already completed an older
    /// version of it.
    #[serde(default)]
    pub onboarding_completed: bool,

    /// Bumped whenever the onboarding wizard's content changes
    /// meaningfully. The frontend compares it to `ONBOARDING_VERSION`
    /// and re-shows the wizard on a fresh launch if the user has an
    /// older version stamped.
    #[serde(default)]
    pub onboarding_version: u32,

    /// LSP ("Code intelligence") master toggle + per-language consent.
    /// Replaces the P1 localStorage-only consent store — see
    /// `ui/src/lsp/manager.ts`.
    #[serde(default)]
    pub code_intelligence: CodeIntelligenceConfig,
}

/// Settings → "Code intelligence" section. `enabled` gates whether the
/// LSP subsystem activates at all; `consented_languages` is the set of
/// language ids the user has agreed to download a server for (populated
/// either by the in-editor download-consent banner or by the per-language
/// toggle in Settings — both write the same list).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodeIntelligenceConfig {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub consented_languages: Vec<String>,
}

impl Default for CodeIntelligenceConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            consented_languages: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TelegramSettings {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub bot_token: String,
    #[serde(default)]
    pub chat_id: String,
    #[serde(default)]
    pub events: TelegramEvents,
    #[serde(default)]
    pub per_tab_overrides: HashMap<String, TelegramTabOverride>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TelegramEvents {
    pub escalations: bool,
    pub mission_completed: bool,
    pub mission_failed: bool,
}

impl Default for TelegramEvents {
    fn default() -> Self {
        Self {
            escalations: true,
            mission_completed: true,
            mission_failed: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TelegramTabOverride {
    pub enabled: Option<bool>,
}

/// Cloud-sync configuration. Default is opt-in: disabled until the user
/// explicitly enables it, but all four categories are pre-checked so
/// enabling is a single click.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloudSyncConfig {
    pub enabled: bool,
    pub workspaces: bool,
    pub operators: bool,
    pub specs: bool,
    pub preferences: bool,
}

impl Default for CloudSyncConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            workspaces: true,
            operators: true,
            specs: true,
            preferences: true,
        }
    }
}

impl Settings {
    pub fn familiars_active(&self) -> bool {
        self.familiars_enabled
    }
}

fn default_status_bar_enabled() -> bool {
    true
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum NotchCorner {
    #[default]
    BottomRight,
    BottomLeft,
    TopRight,
    TopLeft,
}

fn default_notch_sound_on_done() -> bool {
    true
}

fn default_notch_enabled() -> bool {
    true
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TabbarPosition {
    #[default]
    Top,
    Left,
}

/// Style of the folded left-sidebar rail. Cosmetic only — see the
/// `folded_rail_style` field on [`Settings`].
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum FoldedRailStyle {
    #[default]
    Legacy,
    Glyph,
    Labels,
    Spine,
}

/// Visual style of the tab pills + group chips. Purely cosmetic — the
/// frontend toggles a `body.tab-style-<variant>` class and the rest is
/// CSS. `Classic` is the shipped flat-pill look; `Forge` is the angled,
/// mechanical IDE-style variant (rising trapezoids horizontally, sliding
/// chamfered rows in the vertical sidebar); `Glass` is a sleek translucent
/// variant; `Crt` is a retro CRT-screen inspired theme.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TabStyle {
    #[default]
    Classic,
    Forge,
    Glass,
    Crt,
}

/// AOM configuration. Today only the budget default; Phase C will add
/// per-mission profiles (e.g. "long overnight" vs "lunch break").
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AomConfig {
    /// USD ceiling per AOM session. AOM auto-stops when accumulated
    /// cost reaches this. Default $10 — enough for a few hours of
    /// Sonnet decisions, low enough that a runaway loop can't drain
    /// the user's API balance overnight.
    #[serde(default = "default_aom_budget_usd")]
    pub default_budget_usd: f64,
}

impl Default for AomConfig {
    fn default() -> Self {
        Self {
            default_budget_usd: default_aom_budget_usd(),
        }
    }
}

fn default_aom_budget_usd() -> f64 {
    10.0
}

/// 3.6 OS notifications. Three per-trigger toggles + a global focus
/// suppressor. All default `true` — notifications are on out of the
/// box; the user opts out per trigger from Settings.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotificationConfig {
    #[serde(default = "default_true")]
    pub on_operator_escalate: bool,
    #[serde(default = "default_true")]
    pub on_aom_error: bool,
    #[serde(default = "default_true")]
    pub on_aom_complete: bool,
    #[serde(default = "default_true")]
    pub on_executor_idle: bool,
    /// When the Covenant window is currently focused, suppress popups.
    /// The event is still logged via `tracing` regardless.
    #[serde(default = "default_true")]
    pub suppress_when_focused: bool,

    /// Enable outbound email notifications via SendGrid.
    #[serde(default)]
    pub email_enabled: bool,
    /// Sender address for email notifications (e.g. `covenant@example.com`).
    #[serde(default)]
    pub email_from: Option<String>,
    /// Recipient address for email notifications.
    #[serde(default)]
    pub email_to: Option<String>,
    /// Rolling window (minutes) for digest deduplication. Default 15.
    #[serde(default = "default_digest_window")]
    pub email_digest_window_minutes: u32,
}

impl Default for NotificationConfig {
    fn default() -> Self {
        Self {
            on_operator_escalate: true,
            on_aom_error: true,
            on_aom_complete: true,
            on_executor_idle: true,
            suppress_when_focused: true,
            email_enabled: false,
            email_from: None,
            email_to: None,
            email_digest_window_minutes: default_digest_window(),
        }
    }
}

fn default_true() -> bool {
    true
}

fn default_digest_window() -> u32 {
    15
}

fn default_model_routes() -> HashMap<Role, RouteEntry> {
    let mut m = HashMap::new();
    m.insert(
        Role::Summary,
        RouteEntry {
            provider_id: "anthropic".into(),
            model: "claude-sonnet-4-6".into(),
        },
    );
    m.insert(
        Role::Chat,
        RouteEntry {
            provider_id: "anthropic".into(),
            model: "claude-opus-4-7".into(),
        },
    );
    m.insert(
        Role::Operator,
        RouteEntry {
            provider_id: "anthropic".into(),
            model: "claude-sonnet-4-6".into(),
        },
    );
    m.insert(
        Role::Triage,
        RouteEntry {
            provider_id: "anthropic".into(),
            model: karl_agent::DEFAULT_TRIAGE_MODEL.into(),
        },
    );
    m.insert(
        Role::SpecCreator,
        RouteEntry {
            provider_id: "anthropic".into(),
            model: "claude-opus-4-8".into(),
        },
    );
    m.insert(
        Role::ContextMiner,
        RouteEntry {
            provider_id: "anthropic".into(),
            model: "claude-opus-4-8".into(),
        },
    );
    m
}

fn default_anthropic_entry(api_key: Option<String>) -> ProviderEntry {
    ProviderEntry {
        kind: ProviderKind::Anthropic,
        label: "Anthropic".into(),
        api_key,
        base_url: None,
        azure_mode: None,
        azure_api_version: None,
        azure_deployment: None,
    }
}

/// Provider id for the hosted first-run trial.
pub const TRIAL_PROVIDER_ID: &str = "covenant-trial";
/// Model the trial sends. The trial backend forces its own model, so
/// this is mostly cosmetic — kept honest about what actually runs.
pub const TRIAL_MODEL: &str = "claude-haiku-4-5-20251001";

/// Adopt the hosted Covenant trial as the provider for every role. The
/// JWT is stored as the provider api_key — the desktop Anthropic client
/// sends it as `x-api-key` and the trial backend validates it.
///
/// ponytail: the JWT has a 30-day TTL. When it lapses, trial calls 401
/// and the user re-runs adoption to refresh it. Inject the live keychain
/// JWT at call time instead if that round-trip ever chafes.
pub fn build_trial_settings(mut s: Settings, backend_url: &str, jwt: &str) -> Settings {
    let base = format!("{}/trial", backend_url.trim_end_matches('/'));
    s.providers.insert(
        TRIAL_PROVIDER_ID.to_string(),
        ProviderEntry {
            kind: ProviderKind::Anthropic,
            label: "Covenant Trial".into(),
            api_key: Some(jwt.to_string()),
            base_url: Some(base),
            azure_mode: None,
            azure_api_version: None,
            azure_deployment: None,
        },
    );
    for role in [
        Role::Summary,
        Role::Chat,
        Role::Operator,
        Role::Triage,
        Role::SpecCreator,
        Role::ContextMiner,
    ] {
        s.model_routes.insert(
            role,
            RouteEntry {
                provider_id: TRIAL_PROVIDER_ID.to_string(),
                model: TRIAL_MODEL.to_string(),
            },
        );
    }
    s
}

fn migrate_legacy(mut s: Settings) -> Settings {
    if !s.providers.contains_key("anthropic") {
        s.providers.insert(
            "anthropic".into(),
            default_anthropic_entry(s.anthropic_api_key.clone()),
        );
    } else if let Some(entry) = s.providers.get_mut("anthropic") {
        if entry.api_key.is_none() {
            entry.api_key = s.anthropic_api_key.clone();
        }
    }
    if s.model_routes.is_empty() {
        s.model_routes = default_model_routes();
    } else {
        // Backfill any role added after this config was first written (e.g.
        // SpecCreator) so existing users get a working default route.
        for (role, entry) in default_model_routes() {
            s.model_routes.entry(role).or_insert(entry);
        }
    }
    s
}

impl Default for Settings {
    fn default() -> Self {
        let mut providers = HashMap::new();
        providers.insert("anthropic".into(), default_anthropic_entry(None));
        Self {
            anthropic_api_key: None,
            sendgrid_api_key: None,
            providers,
            model_routes: default_model_routes(),
            agent: AgentConfig::default(),
            operator: OperatorConfig::default(),
            terminal: TerminalConfig::default(),
            window: WindowConfig::default(),
            aom: AomConfig::default(),
            experimental: ExperimentalConfig::default(),
            notifications: NotificationConfig::default(),
            status_bar_enabled: default_status_bar_enabled(),
            notch_enabled: default_notch_enabled(),
            notch_corner: NotchCorner::default(),
            notch_sound_on_done: default_notch_sound_on_done(),
            hidden_indicators: Vec::new(),
            tabbar_position: TabbarPosition::default(),
            folded_rail_style: FoldedRailStyle::default(),
            ui_font_family: None,
            zsh_history_imported_at_unix_ms: None,
            familiars_enabled: false,
            telegram: TelegramSettings::default(),
            cloud_sync: CloudSyncConfig::default(),
            onboarding_completed: false,
            onboarding_version: 0,
            code_intelligence: CodeIntelligenceConfig::default(),
        }
    }
}

#[cfg(test)]
mod familiars_tests {
    use super::*;

    #[test]
    fn familiars_inactive_by_default() {
        let s = Settings::default();
        assert!(!s.familiars_active());
    }

    #[test]
    fn familiars_active_when_enabled() {
        let mut s = Settings::default();
        s.familiars_enabled = true;
        assert!(s.familiars_active());
    }
}

/// Window appearance — controls how transparent the foreground surfaces
/// are over the macOS NSVisualEffectView (vibrancy) that's always-on at
/// the OS level. The frontend translates `background` into a body class
/// (`body.bg-solid` / `bg-vibrant` / `bg-translucent`) which sets the
/// `--surface-alpha` custom property cascading through every `--bg-*`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ThemeMode {
    /// Follow the macOS appearance via `prefers-color-scheme`.
    System,
    /// Force dark chrome + dark xterm palette.
    Dark,
    /// Force light chrome + GitHub Light xterm palette.
    Light,
    /// Force a neutral pure-black (OLED) chrome — opaque, no blue tint,
    /// vibrancy hidden. Resolves to the dark xterm palette.
    #[serde(rename = "true_dark")]
    TrueDark,
}

impl Default for ThemeMode {
    fn default() -> Self {
        Self::System
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WindowConfig {
    #[serde(default)]
    pub background: WindowBackground,
    #[serde(default)]
    pub theme: ThemeMode,
    #[serde(default)]
    pub tab_style: TabStyle,
}

impl Default for WindowConfig {
    fn default() -> Self {
        Self {
            background: WindowBackground::default(),
            theme: ThemeMode::default(),
            tab_style: TabStyle::default(),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum WindowBackground {
    /// Fully opaque dark surface — vibrancy hidden. Best for sunlit
    /// rooms, low-contrast wallpapers, or users who find translucency
    /// distracting.
    Solid,
    /// Default. Moderate translucency — wallpaper visible but text
    /// contrast stays comfortable on most desktops.
    Vibrant,
    /// Heavy translucency. Maximum "wow" but text legibility depends
    /// on the wallpaper behind.
    Translucent,
}

impl Default for WindowBackground {
    fn default() -> Self {
        Self::Vibrant
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalConfig {
    #[serde(default = "default_font_family")]
    pub font_family: String,
    #[serde(default = "default_font_size")]
    pub font_size: u32,
    /// Pixels added between cells. Negative pulls cells closer — useful
    /// for ligature fonts (Comic Code, JetBrains, Fira, …) whose glyph
    /// advance is wider than the visual width.
    #[serde(default)]
    pub letter_spacing: i32,
    /// Multiplier on cell height. 1.0 is xterm's default. 1.2 gives
    /// some breathing room without sacrificing density.
    #[serde(default = "default_line_height")]
    pub line_height: f32,
    /// Opt-in font ligatures. The WebGL renderer cannot render
    /// ligatures (texture-atlas is glyph-per-cell), so enabling this
    /// makes the tab fall back to the canvas renderer + the
    /// xterm-addon-ligatures shaping pass. Off by default to preserve
    /// the fast path; users with Fira Code / JetBrains Mono / Comic
    /// Code etc. flip it on.
    #[serde(default)]
    pub ligatures: bool,
}

impl Default for TerminalConfig {
    fn default() -> Self {
        Self {
            font_family: default_font_family(),
            font_size: default_font_size(),
            letter_spacing: 0,
            line_height: default_line_height(),
            ligatures: false,
        }
    }
}

fn default_font_family() -> String {
    "ui-monospace, SFMono-Regular, \"SF Mono\", Menlo, Consolas, monospace".to_string()
}

fn default_font_size() -> u32 {
    13
}

fn default_line_height() -> f32 {
    1.2
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentConfig {
    #[serde(default = "default_model_summary")]
    pub model_summary: String,
    #[serde(default = "default_model_chat")]
    pub model_chat: String,
    #[serde(default = "default_max_calls_per_minute")]
    pub max_calls_per_minute: u32,
}

impl Default for AgentConfig {
    fn default() -> Self {
        Self {
            model_summary: default_model_summary(),
            model_chat: default_model_chat(),
            max_calls_per_minute: default_max_calls_per_minute(),
        }
    }
}

fn default_model_summary() -> String {
    "claude-sonnet-4-6".to_string()
}

fn default_model_chat() -> String {
    "claude-opus-4-7".to_string()
}

fn default_max_calls_per_minute() -> u32 {
    6
}

/// The Operator is Covenant's coordinator: when an executor agent
/// (Claude Code, Copilot CLI, opencode, aider, etc.) running inside the
/// PTY pauses to ask the user a routine question, the Operator can
/// answer on the user's behalf — within the explicit constraints below.
///
/// SuggestOnly first: M-OP2 only LOGS proposed decisions; M-OP3 will
/// flip the switch to actually inject responses.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OperatorConfig {
    /// Default per-session enabled state. The per-tab toggle (M-OP2)
    /// always wins. False by default — opt-in.
    #[serde(default)]
    pub enabled_default: bool,
    /// User's freeform persona / authorization charter. Concatenated
    /// with hard constraints to form the Operator's system prompt.
    #[serde(default = "default_persona")]
    pub persona: String,
    /// Regex strings (each compiled at use). Match against the in-flight
    /// block's command. Operator only kicks in when the running command
    /// matches one of these.
    #[serde(default = "default_executor_patterns")]
    pub executor_patterns: Vec<String>,
    /// Byte silence (in seconds) during a matching command before the
    /// Operator considers the executor "stuck waiting for input".
    #[serde(default = "default_idle_secs")]
    pub idle_threshold_secs: u64,
    /// Cap on Operator decisions per session per minute.
    #[serde(default = "default_max_decisions_per_minute")]
    pub max_decisions_per_minute: u32,
    /// Extra regex patterns layered on top of the hard blocklist. The
    /// Operator will refuse to type any reply that matches.
    #[serde(default)]
    pub deny_extra_patterns: Vec<String>,
    /// AOM liveness Task 2: route every candidate tick through a cheap
    /// Haiku triage classifier before paying for the configured
    /// Opus/Sonnet decision call. Defaults to true; disable to fall
    /// back to the legacy single-model path.
    #[serde(default = "default_triage_enabled")]
    pub triage_enabled: bool,
    /// Model id for the triage classifier. Override only for A/B
    /// experiments — the default is the cheapest current Haiku.
    #[serde(default = "default_triage_model")]
    pub triage_model: String,
    /// Enable the v2 OperatorMind protocol (per-tab persistent state,
    /// extended thinking, decision tape). Default off — old code path
    /// runs when false. Spec 3.20.
    #[serde(default)]
    pub mind_v2: bool,
    /// Anthropic extended-thinking budget in tokens for the v2 path.
    /// Cap 4000 server-side. Ignored when mind_v2 is false.
    #[serde(default = "default_mind_thinking_budget")]
    pub mind_thinking_budget: u32,

    /// Auto-disable the per-session Operator when its attached mission's
    /// plan reaches 100% complete. Prevents runaway operators on long
    /// "review the code" / "fix bugs" missions. Default true; set false
    /// to keep the operator running past completion (e.g. for follow-up
    /// tasks the user will queue).
    #[serde(default = "default_auto_stop_on_mission_completed")]
    pub auto_stop_on_mission_completed: bool,
}

impl Default for OperatorConfig {
    fn default() -> Self {
        Self {
            enabled_default: false,
            persona: default_persona(),
            executor_patterns: default_executor_patterns(),
            idle_threshold_secs: default_idle_secs(),
            max_decisions_per_minute: default_max_decisions_per_minute(),
            deny_extra_patterns: vec![],
            triage_enabled: default_triage_enabled(),
            triage_model: default_triage_model(),
            mind_v2: false,
            mind_thinking_budget: default_mind_thinking_budget(),
            auto_stop_on_mission_completed: default_auto_stop_on_mission_completed(),
        }
    }
}

fn default_auto_stop_on_mission_completed() -> bool {
    true
}

fn default_mind_thinking_budget() -> u32 {
    2000
}

fn default_triage_enabled() -> bool {
    true
}

fn default_triage_model() -> String {
    karl_agent::DEFAULT_TRIAGE_MODEL.to_string()
}

fn default_persona() -> String {
    r#"I'm a senior engineer who delegates trivial decisions and wants to sleep through routine agent prompts.

ALWAYS-YES (when no destructive flags appear):
- "run tests" / "cargo test" / "yarn test" / "pytest" / "npm test"
- "should I commit?" — yes, if the branch is not main or master
- "subagent: Sonnet or Opus?" — Sonnet (cheaper)
- "fix N lint errors?" / "format the file?" — yes
- "shall we continue?" / "proceed?" / "ready to move on?" — yes
- "should I add a test for this?" — yes
- "use approach A or B?" — pick the simpler one and document briefly
- inline edits vs subagent dispatch — inline for < 50 lines, subagent otherwise

ALWAYS-ASK-ME:
- anything touching main / master branch directly
- deleting files or directories
- production deploys, k8s apply, terraform apply
- API key, secret, .env changes
- estimated cost over $5 in API calls
- architectural decisions (which framework, db, language)
- refactors larger than ~100 lines
- migrations, schema changes

STYLE:
- terse, no apologies
- when escalating, give me one sentence on what's blocking and why you're not confident
- when answering, output exactly the keystrokes the executor expects (e.g. "y\n", "1\n", "yes\n")
"#
    .to_string()
}

fn default_executor_patterns() -> Vec<String> {
    vec![
        r"^claude(\s|$)".to_string(),
        r"^claude-code(\s|$)".to_string(),
        r"^gh\s+copilot".to_string(),
        r"^opencode(\s|$)".to_string(),
        r"^aider(\s|$)".to_string(),
        r"^crush(\s|$)".to_string(),
        r"^cursor(\s|$)".to_string(),
        r"^cline(\s|$)".to_string(),
    ]
}

fn default_idle_secs() -> u64 {
    4
}

fn default_max_decisions_per_minute() -> u32 {
    10
}

/// Read settings from disk. Missing file → defaults. Malformed file →
/// defaults + a `tracing::warn!` (we never overwrite a user's broken
/// file silently).
pub fn load(path: &Path) -> Settings {
    match fs::read_to_string(path) {
        Ok(text) => migrate_legacy(serde_json::from_str(&text).unwrap_or_else(|e| {
            tracing::warn!(
                error = ?e,
                path = %path.display(),
                "settings file unparseable, using defaults — not overwriting"
            );
            Settings::default()
        })),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Settings::default(),
        Err(e) => {
            tracing::warn!(
                error = ?e,
                path = %path.display(),
                "failed to read settings, using defaults"
            );
            Settings::default()
        }
    }
}

/// Atomic write + chmod 0600. Empty string values for `anthropic_api_key`
/// are normalized to `None` so the on-disk file doesn't carry a
/// confusing empty key.
pub fn save(path: &Path, settings: &Settings) -> std::io::Result<()> {
    let mut to_persist = settings.clone();
    if let Some(ref key) = to_persist.anthropic_api_key {
        if key.trim().is_empty() {
            to_persist.anthropic_api_key = None;
        }
    }
    if let Some(ref key) = to_persist.sendgrid_api_key {
        if key.trim().is_empty() {
            to_persist.sendgrid_api_key = None;
        }
    }

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let body = serde_json::to_string_pretty(&to_persist)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;

    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, body)?;
    #[cfg(unix)]
    fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600))?;
    fs::rename(&tmp, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trial_adoption_wires_provider_and_all_routes() {
        let s = build_trial_settings(Settings::default(), "https://forge.covenant.uno/", "jwt.abc");
        let p = s.providers.get(TRIAL_PROVIDER_ID).expect("trial provider");
        assert!(matches!(p.kind, ProviderKind::Anthropic));
        assert_eq!(p.api_key.as_deref(), Some("jwt.abc"));
        // Trailing slash trimmed; /trial appended (no double slash).
        assert_eq!(p.base_url.as_deref(), Some("https://forge.covenant.uno/trial"));
        for role in [
            Role::Summary,
            Role::Chat,
            Role::Operator,
            Role::Triage,
            Role::SpecCreator,
            Role::ContextMiner,
        ] {
            let r = s.model_routes.get(&role).expect("route");
            assert_eq!(r.provider_id, TRIAL_PROVIDER_ID);
            assert_eq!(r.model, TRIAL_MODEL);
        }
    }

    #[test]
    fn experimental_split_panes_defaults_false() {
        let s: Settings = serde_json::from_str("{}").unwrap();
        assert!(!s.experimental.split_panes);
    }

    #[test]
    fn experimental_split_panes_roundtrip() {
        let mut s = Settings::default();
        s.experimental.split_panes = true;
        let json = serde_json::to_string(&s).unwrap();
        let s2: Settings = serde_json::from_str(&json).unwrap();
        assert!(s2.experimental.split_panes);
    }

    #[test]
    fn experimental_statusbar_two_row_defaults_true() {
        let s: Settings = serde_json::from_str("{}").unwrap();
        assert!(s.experimental.statusbar_two_row);
    }

    #[test]
    fn experimental_statusbar_two_row_roundtrip() {
        let mut s = Settings::default();
        s.experimental.statusbar_two_row = false;
        let json = serde_json::to_string(&s).unwrap();
        let s2: Settings = serde_json::from_str(&json).unwrap();
        assert!(!s2.experimental.statusbar_two_row);
    }

    #[test]
    fn experimental_statusbar_two_row_missing_in_json_defaults_true() {
        let json = r#"{
            "experimental": { "split_panes": false }
        }"#;
        let s: Settings = serde_json::from_str(json).unwrap();
        assert!(s.experimental.statusbar_two_row);
    }

    #[test]
    fn experimental_internal_browser_defaults_false() {
        let s: Settings = serde_json::from_str("{}").unwrap();
        assert!(!s.experimental.internal_browser);
    }

    #[test]
    fn experimental_internal_browser_roundtrip() {
        let mut s = Settings::default();
        s.experimental.internal_browser = true;
        let json = serde_json::to_string(&s).unwrap();
        let s2: Settings = serde_json::from_str(&json).unwrap();
        assert!(s2.experimental.internal_browser);
    }

    #[test]
    fn notification_config_default_enables_executor_idle() {
        let cfg = NotificationConfig::default();
        assert!(
            cfg.on_executor_idle,
            "executor idle notifications default on"
        );
    }

    #[test]
    fn notification_config_deserializes_without_executor_idle_field() {
        let json = r#"{"on_operator_escalate":true,"on_aom_error":true,"on_aom_complete":true}"#;
        let cfg: NotificationConfig = serde_json::from_str(json).expect("parse");
        assert!(
            cfg.on_executor_idle,
            "missing field falls back to default true"
        );
    }

    #[test]
    fn missing_file_returns_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let s = load(&dir.path().join("nope.json"));
        assert!(s.anthropic_api_key.is_none());
        assert_eq!(s.agent.max_calls_per_minute, 6);
    }

    #[test]
    fn round_trip_preserves_key() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        let mut s = Settings::default();
        s.anthropic_api_key = Some("sk-ant-test".to_string());
        save(&path, &s).unwrap();

        let loaded = load(&path);
        assert_eq!(loaded.anthropic_api_key.as_deref(), Some("sk-ant-test"));
    }

    #[test]
    fn empty_key_normalizes_to_none() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        let mut s = Settings::default();
        s.anthropic_api_key = Some("   ".to_string());
        save(&path, &s).unwrap();

        let loaded = load(&path);
        assert!(loaded.anthropic_api_key.is_none());
    }

    #[cfg(unix)]
    #[test]
    fn saved_file_has_owner_only_perms() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        save(&path, &Settings::default()).unwrap();
        let mode = fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn settings_round_trip_email_fields() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let mut s = Settings::default();
        s.sendgrid_api_key = Some("SG.test".to_string());
        s.notifications.email_enabled = true;
        s.notifications.email_from = Some("from@example.com".to_string());
        s.notifications.email_to = Some("to@example.com".to_string());
        s.notifications.email_digest_window_minutes = 30;
        save(&path, &s).unwrap();
        let loaded = load(&path);
        assert_eq!(loaded.sendgrid_api_key.as_deref(), Some("SG.test"));
        assert!(loaded.notifications.email_enabled);
        assert_eq!(
            loaded.notifications.email_from.as_deref(),
            Some("from@example.com")
        );
        assert_eq!(
            loaded.notifications.email_to.as_deref(),
            Some("to@example.com")
        );
        assert_eq!(loaded.notifications.email_digest_window_minutes, 30);
    }

    #[test]
    fn settings_back_compat_missing_email_fields() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, r#"{"anthropic_api_key":null}"#).unwrap();
        let loaded = load(&path);
        assert!(loaded.sendgrid_api_key.is_none());
        assert!(!loaded.notifications.email_enabled);
        assert!(loaded.notifications.email_from.is_none());
        assert!(loaded.notifications.email_to.is_none());
        assert_eq!(loaded.notifications.email_digest_window_minutes, 15);
    }

    #[test]
    fn malformed_file_falls_back_without_overwriting() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        fs::write(&path, "{ this is not json").unwrap();
        let s = load(&path);
        assert!(s.anthropic_api_key.is_none());
        // Original content untouched.
        let raw = fs::read_to_string(&path).unwrap();
        assert!(raw.contains("not json"));
    }

    #[test]
    fn operator_config_default_has_mind_v2_off_and_budget_2000() {
        let c = OperatorConfig::default();
        assert!(!c.mind_v2);
        assert_eq!(c.mind_thinking_budget, 2000);
    }

    #[test]
    fn operator_config_round_trips_with_mind_fields() {
        let mut c = OperatorConfig::default();
        c.mind_v2 = true;
        c.mind_thinking_budget = 1500;
        let s = serde_json::to_string(&c).unwrap();
        let d: OperatorConfig = serde_json::from_str(&s).unwrap();
        assert!(d.mind_v2);
        assert_eq!(d.mind_thinking_budget, 1500);
    }

    #[test]
    fn migrates_legacy_anthropic_key_into_providers() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        std::fs::write(&path, r#"{"anthropic_api_key":"sk-ant-legacy"}"#).unwrap();
        let s = load(&path);
        let anthropic = s
            .providers
            .get("anthropic")
            .expect("default anthropic entry");
        assert_eq!(anthropic.api_key.as_deref(), Some("sk-ant-legacy"));
    }

    #[test]
    fn model_routes_default_to_anthropic_provider() {
        let s = Settings::default();
        let summary = s.model_routes.get(&Role::Summary).expect("summary route");
        assert_eq!(summary.provider_id, "anthropic");
        assert_eq!(summary.model, "claude-sonnet-4-6");
    }

    #[test]
    fn legacy_provider_entry_without_azure_fields_still_deserializes() {
        let json = r#"{"kind":"anthropic","label":"Anthropic","api_key":"sk-x"}"#;
        let e: ProviderEntry = serde_json::from_str(json).unwrap();
        assert!(e.azure_mode.is_none());
        assert!(e.azure_api_version.is_none());
        assert!(e.azure_deployment.is_none());
    }

    #[test]
    fn round_trip_preserves_ollama_provider() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        let mut s = Settings::default();
        s.providers.insert(
            "ollama".into(),
            ProviderEntry {
                kind: karl_agent::provider::ProviderKind::OpenAiCompat,
                api_key: None,
                base_url: Some("http://localhost:11434/v1".into()),
                label: "Ollama (local)".into(),
                azure_mode: None,
                azure_api_version: None,
                azure_deployment: None,
            },
        );
        save(&path, &s).unwrap();
        let loaded = load(&path);
        assert!(loaded.providers.contains_key("ollama"));
    }

    #[test]
    fn operator_config_back_compat_loads_legacy_settings_without_mind_fields() {
        let legacy = r#"{
            "enabled_default": true,
            "persona": "p",
            "executor_patterns": [],
            "idle_threshold_secs": 5,
            "max_decisions_per_minute": 6,
            "deny_extra_patterns": [],
            "triage_enabled": true,
            "triage_model": "claude-haiku-4-5"
        }"#;
        let c: OperatorConfig = serde_json::from_str(legacy).unwrap();
        assert!(!c.mind_v2);
        assert_eq!(c.mind_thinking_budget, 2000);
    }

    #[test]
    fn onboarding_defaults_incomplete_for_fresh_install() {
        let s: Settings = serde_json::from_str("{}").unwrap();
        assert!(
            !s.onboarding_completed,
            "fresh install has not completed the wizard"
        );
        assert_eq!(
            s.onboarding_version, 0,
            "fresh install has no stamped version"
        );
    }

    #[test]
    fn onboarding_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        let mut s = Settings::default();
        s.onboarding_completed = true;
        s.onboarding_version = 2;
        save(&path, &s).unwrap();
        let loaded = load(&path);
        assert!(loaded.onboarding_completed);
        assert_eq!(loaded.onboarding_version, 2);
    }

    #[test]
    fn onboarding_back_compat_legacy_settings_default_incomplete() {
        let legacy = r#"{ "anthropic_api_key": null }"#;
        let s: Settings = serde_json::from_str(legacy).unwrap();
        assert!(!s.onboarding_completed);
        assert_eq!(s.onboarding_version, 0);
    }

    #[test]
    fn code_intelligence_defaults_enabled_with_no_consented_languages() {
        let s: Settings = serde_json::from_str("{}").unwrap();
        assert!(s.code_intelligence.enabled);
        assert!(s.code_intelligence.consented_languages.is_empty());
    }

    #[test]
    fn code_intelligence_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        let mut s = Settings::default();
        s.code_intelligence.enabled = false;
        s.code_intelligence.consented_languages = vec!["rust".to_string()];
        save(&path, &s).unwrap();
        let loaded = load(&path);
        assert!(!loaded.code_intelligence.enabled);
        assert_eq!(loaded.code_intelligence.consented_languages, vec!["rust"]);
    }

    #[test]
    fn hidden_indicators_defaults_empty_and_roundtrips() {
        // Missing field deserializes to an empty vec.
        let s: Settings = serde_json::from_str("{}").unwrap();
        assert!(s.hidden_indicators.is_empty());

        // Round-trips through JSON.
        let mut s2 = Settings::default();
        s2.hidden_indicators = vec!["beacon".to_string(), "sb-git".to_string()];
        let json = serde_json::to_string(&s2).unwrap();
        let back: Settings = serde_json::from_str(&json).unwrap();
        assert_eq!(back.hidden_indicators, vec!["beacon", "sb-git"]);
    }
}

#[cfg(test)]
mod theme_mode_tests {
    use super::*;

    #[test]
    fn theme_mode_defaults_to_system() {
        assert_eq!(ThemeMode::default(), ThemeMode::System);
    }

    #[test]
    fn window_config_parses_legacy_without_theme() {
        let json = r#"{ "background": "vibrant" }"#;
        let cfg: WindowConfig = serde_json::from_str(json).unwrap();
        assert_eq!(cfg.theme, ThemeMode::System);
    }

    #[test]
    fn window_config_roundtrips_with_theme() {
        let json = r#"{ "background": "solid", "theme": "light" }"#;
        let cfg: WindowConfig = serde_json::from_str(json).unwrap();
        assert_eq!(cfg.theme, ThemeMode::Light);
        let back = serde_json::to_string(&cfg).unwrap();
        assert!(back.contains("\"theme\":\"light\""));
    }
}

#[cfg(test)]
mod tab_style_tests {
    use super::TabStyle;

    #[test]
    fn deserializes_all_lowercase_variants() {
        assert_eq!(
            serde_json::from_str::<TabStyle>("\"classic\"").unwrap(),
            TabStyle::Classic
        );
        assert_eq!(
            serde_json::from_str::<TabStyle>("\"forge\"").unwrap(),
            TabStyle::Forge
        );
        assert_eq!(
            serde_json::from_str::<TabStyle>("\"glass\"").unwrap(),
            TabStyle::Glass
        );
        assert_eq!(
            serde_json::from_str::<TabStyle>("\"crt\"").unwrap(),
            TabStyle::Crt
        );
    }

    #[test]
    fn serializes_lowercase() {
        assert_eq!(
            serde_json::to_string(&TabStyle::Glass).unwrap(),
            "\"glass\""
        );
        assert_eq!(serde_json::to_string(&TabStyle::Crt).unwrap(), "\"crt\"");
    }
}

#[cfg(test)]
mod tab_styles_config_tests {
    use super::*;

    #[test]
    fn deserializes_all_tab_shapes() {
        assert_eq!(
            serde_json::from_str::<TabShape>("\"rectangle\"").unwrap(),
            TabShape::Rectangle
        );
        assert_eq!(
            serde_json::from_str::<TabShape>("\"rounded\"").unwrap(),
            TabShape::Rounded
        );
        assert_eq!(
            serde_json::from_str::<TabShape>("\"lofted\"").unwrap(),
            TabShape::Lofted
        );
        assert_eq!(
            serde_json::from_str::<TabShape>("\"pill\"").unwrap(),
            TabShape::Pill
        );
    }

    #[test]
    fn deserializes_all_bg_modes() {
        assert_eq!(
            serde_json::from_str::<TabBgMode>("\"solid\"").unwrap(),
            TabBgMode::Solid
        );
        assert_eq!(
            serde_json::from_str::<TabBgMode>("\"translucent\"").unwrap(),
            TabBgMode::Translucent
        );
        assert_eq!(
            serde_json::from_str::<TabBgMode>("\"off\"").unwrap(),
            TabBgMode::Off
        );
        assert_eq!(
            serde_json::from_str::<TabBgMode>("\"gradient\"").unwrap(),
            TabBgMode::Gradient
        );
    }

    #[test]
    fn deserializes_all_indicators() {
        assert_eq!(
            serde_json::from_str::<TabIndicator>("\"stripe\"").unwrap(),
            TabIndicator::Stripe
        );
        assert_eq!(
            serde_json::from_str::<TabIndicator>("\"underline\"").unwrap(),
            TabIndicator::Underline
        );
        assert_eq!(
            serde_json::from_str::<TabIndicator>("\"left-bar\"").unwrap(),
            TabIndicator::LeftBar
        );
        assert_eq!(
            serde_json::from_str::<TabIndicator>("\"dot\"").unwrap(),
            TabIndicator::Dot
        );
        assert_eq!(
            serde_json::from_str::<TabIndicator>("\"glow\"").unwrap(),
            TabIndicator::Glow
        );
        assert_eq!(
            serde_json::from_str::<TabIndicator>("\"border\"").unwrap(),
            TabIndicator::Border
        );
    }

    #[test]
    fn deserializes_all_heights() {
        assert_eq!(
            serde_json::from_str::<TabHeight>("\"normal\"").unwrap(),
            TabHeight::Normal
        );
        assert_eq!(
            serde_json::from_str::<TabHeight>("\"compact\"").unwrap(),
            TabHeight::Compact
        );
        assert_eq!(
            serde_json::from_str::<TabHeight>("\"spacious\"").unwrap(),
            TabHeight::Spacious
        );
    }

    #[test]
    fn deserializes_all_gaps() {
        assert_eq!(
            serde_json::from_str::<TabGap>("\"normal\"").unwrap(),
            TabGap::Normal
        );
        assert_eq!(
            serde_json::from_str::<TabGap>("\"tight\"").unwrap(),
            TabGap::Tight
        );
        assert_eq!(
            serde_json::from_str::<TabGap>("\"loose\"").unwrap(),
            TabGap::Loose
        );
    }

    #[test]
    fn tab_styles_config_defaults_disabled() {
        let cfg = TabStylesConfig::default();
        assert!(!cfg.enabled);
        assert_eq!(cfg.shape, TabShape::Rectangle);
        assert_eq!(cfg.bg_mode, TabBgMode::Solid);
        assert_eq!(cfg.indicator, TabIndicator::Stripe);
        assert_eq!(cfg.height, TabHeight::Normal);
        assert_eq!(cfg.gap, TabGap::Normal);
        assert!(cfg.bg_gradient.is_none());
        assert_eq!(cfg.group_shape, GroupShape::Match);
        assert_eq!(cfg.group_bg, GroupBg::Tinted);
    }

    #[test]
    fn deserializes_all_group_shapes_and_bgs() {
        assert_eq!(
            serde_json::from_str::<GroupShape>("\"match\"").unwrap(),
            GroupShape::Match
        );
        assert_eq!(
            serde_json::from_str::<GroupShape>("\"rectangle\"").unwrap(),
            GroupShape::Rectangle
        );
        assert_eq!(
            serde_json::from_str::<GroupShape>("\"rounded\"").unwrap(),
            GroupShape::Rounded
        );
        assert_eq!(
            serde_json::from_str::<GroupShape>("\"lofted\"").unwrap(),
            GroupShape::Lofted
        );
        assert_eq!(
            serde_json::from_str::<GroupShape>("\"pill\"").unwrap(),
            GroupShape::Pill
        );
        assert_eq!(
            serde_json::from_str::<GroupBg>("\"tinted\"").unwrap(),
            GroupBg::Tinted
        );
        assert_eq!(
            serde_json::from_str::<GroupBg>("\"solid\"").unwrap(),
            GroupBg::Solid
        );
        assert_eq!(
            serde_json::from_str::<GroupBg>("\"off\"").unwrap(),
            GroupBg::Off
        );
    }

    #[test]
    fn tab_styles_config_without_group_fields_defaults() {
        // Configs saved before group customization existed must load.
        let json = serde_json::json!({ "enabled": true, "shape": "pill" });
        let cfg: TabStylesConfig = serde_json::from_value(json).unwrap();
        assert_eq!(cfg.group_shape, GroupShape::Match);
        assert_eq!(cfg.group_bg, GroupBg::Tinted);
    }

    #[test]
    fn experimental_config_defaults_tab_styles_disabled() {
        let cfg = ExperimentalConfig::default();
        assert!(!cfg.tab_styles.enabled);
    }

    #[test]
    fn round_trips_tab_styles_config() {
        let json = serde_json::json!({
            "enabled": true,
            "shape": "rounded",
            "bg_mode": "gradient",
            "bg_gradient": ["#ff0000", "#0000ff"],
            "indicator": "underline",
            "height": "spacious",
            "gap": "loose"
        });
        let cfg: TabStylesConfig = serde_json::from_value(json.clone()).unwrap();
        assert!(cfg.enabled);
        assert_eq!(cfg.shape, TabShape::Rounded);
        assert_eq!(cfg.bg_mode, TabBgMode::Gradient);
        assert_eq!(cfg.bg_gradient, Some(["#ff0000".into(), "#0000ff".into()]));
        assert_eq!(cfg.indicator, TabIndicator::Underline);
        assert_eq!(cfg.height, TabHeight::Spacious);
        assert_eq!(cfg.gap, TabGap::Loose);
        let back = serde_json::to_value(&cfg).unwrap();
        assert_eq!(back["shape"], "rounded");
        assert_eq!(back["bg_mode"], "gradient");
        assert_eq!(back["indicator"], "underline");
    }
}
