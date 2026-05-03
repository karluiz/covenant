// Build-time replacements injected by Vite (`define`) — see
// `vite.config.ts`. Both are string literals after substitution.

/// Semver from package.json. Single source of truth for the frontend;
/// shown in the window title and the version chip.
declare const __APP_VERSION__: string;

/// Full text of `CHANGELOG.md` inlined at build time. Rendered by the
/// release-log modal. Read via the constant — never fetch the file
/// at runtime (webview file:// reads are unreliable on macOS Tauri).
declare const __APP_CHANGELOG__: string;
