# LSP Integration — Design

**Date:** 2026-07-07
**Status:** Approved pending user review
**Scope decision:** Full IDE features. User toolchain for runtimes. Baked-in registry manifest. Approach B (frontend-owned protocol, Rust as process owner + byte pipe).

## Goal

The Structure editor (CodeMirror 6, `ui/src/structure/editor.ts`) gains real code intelligence, comparable to what VSCode users expect:

- **Navigation:** ⌘click go-to-definition, hover (types/docs), find references
- **Diagnostics:** live errors/warnings (squiggles + gutter)
- **Completion:** semantic autocomplete
- **Refactoring:** rename symbol, code actions (quick fixes)

Languages, in delivery order: **Rust → TypeScript → C# → Java**.

Language servers are **never bundled**. They download on demand to the app-support dir, with explicit user consent, the first time a file of that language is opened. Bundle size impact: zero.

## Non-goals (v1)

- No VSCode-style extension system (no extension host, no third-party extension API). This is a fixed registry of language servers curated by us.
- No managed runtime downloads. TS needs Node ≥18, Java needs JDK 17+, C# needs the .NET SDK — we detect them on the user's PATH and show a clear banner if missing. A dev working in these languages has the toolchain by definition.
- No LSP for files edited outside the Structure editor (terminal vim, external editors).
- No multi-server-per-file (e.g. ESLint LSP alongside tsserver). One server per language.

## Architecture

```
┌──────────────────────────────────────────────────────┐
│ Frontend (owns the LSP protocol)                     │
│  lsp/client.ts     — LSP state machine + transport   │
│  lsp/cm6.ts        — CM6 extensions per feature      │
│  structure/editor.ts — wires extensions in           │
└──────────────┬───────────────────────────────────────┘
               │ Tauri IPC: lsp_start / lsp_send / lsp_stop
               │ Event: lsp://{server_id}/message
┌──────────────▼───────────────────────────────────────┐
│ crates/lsp (Rust: owns processes, moves bytes)       │
│  registry.rs  — baked-in servers.json manifest       │
│  download.rs  — fetch + sha256 verify + unpack       │
│  runtime.rs   — node/dotnet/java PATH detection      │
│  server.rs    — spawn, stdio pumps, framing, lifecycle│
└──────────────────────────────────────────────────────┘
```

**Division of labor.** Rust does exactly what it already does for PTYs: own child processes and move bytes. It does NOT understand LSP semantics beyond `Content-Length` framing (it de-frames server→client bytes and emits one JSON message per Tauri event, and frames client→server messages). The protocol state machine (initialize handshake, capabilities, document sync, request/response correlation) lives in TypeScript next to the editor, built on `codemirror-languageserver` with a custom Transport over Tauri IPC. If (when) that package falls short for rename/code actions, we fork it into `ui/src/lsp/` — it is small.

### Tauri surface

```
lsp_ensure_server(language) -> ServerStatus   // NotDownloaded{size} | NeedsRuntime{name} | Ready | ...
lsp_download_server(language) -> ()           // progress via lsp://download/{language} events
lsp_start(language, root: PathBuf) -> ServerId
lsp_send(server_id, message: String) -> ()
lsp_stop(server_id) -> ()
```

Event `lsp://{server_id}/message` carries each de-framed server→client JSON message. Download progress: `lsp://download/{language}` with `{received, total}`.

### Registry manifest (`crates/lsp/servers.json`, baked into the binary)

Per language: server name, version, per-`(os, arch)` download URL + sha256 + archive kind, unpacked entry point, args, required runtime (name + min version + version probe command), and marker files for root detection. Exact URLs/hashes pinned at implementation time per phase:

| Language | Server | Distribution | Runtime |
|---|---|---|---|
| Rust | rust-analyzer | GitHub releases, single gzipped binary per target | none |
| TypeScript | typescript-language-server + typescript | npm registry tarballs (`.tgz`), run via user's node | Node ≥18 |
| C# | Roslyn LSP (`Microsoft.CodeAnalysis.LanguageServer`), platform self-contained build | NuGet feed | .NET SDK (for design-time builds) |
| Java | Eclipse JDT.LS | download.eclipse.org tarball | JDK 17+ |

Updating a server version = editing servers.json in a normal Covenant release. Old versions are deleted after a new one downloads successfully.

### Download & storage

- Target: `~/Library/Application Support/Covenant/lsp/<server>/<version>/` (via Tauri's app-data resolver; Windows/Linux paths come free).
- HTTPS only, sha256 verified before unpack, partial downloads to a temp file + atomic rename.
- Unpack: gzip / tar.gz / zip / .tgz. `chmod +x` entry points on unix.
- **Consent:** first time a language triggers, an inline banner in the editor: "Download rust-analyzer v0.x (12 MB) to enable code intelligence? [Download] [Not now]". Choice persisted per server in settings. Never silent.

### Runtime detection

macOS GUI apps get a minimal PATH — resolving `node`/`java`/`dotnet` must go through the user's login shell (`$SHELL -lc 'command -v node && node --version'`), same class of problem the PTY env already deals with. Cache per app run; re-probe on banner retry. Version-gate (Node ≥18, JDK ≥17) with a clear banner naming the requirement when missing or too old.

### Server lifecycle

- Key: `(language, workspace_root)`. One server per key, shared across all open files under it.
- **Root detection** (Rust, walk up from the file): `Cargo.toml` / `tsconfig.json`|`package.json` / `*.sln`|`*.csproj` / `pom.xml`|`build.gradle(.kts)` → else git root → else file's directory.
- LRU cap of 4 live servers; idle shutdown (no open documents) after 10 min. JDT.LS and tsserver are memory-hungry; the cap is the guardrail.
- Crash: auto-restart once per 5 min window, then error chip with manual restart. Graceful `shutdown`/`exit` on editor close and app quit.

### Document sync

The CM6 buffer is the source of truth: `didOpen` on file open, incremental `didChange` debounced ~200ms, `didSave` on ⌘S, `didClose` on pane close. **Position mapping gotcha:** LSP positions are UTF-16 code units per line; CM6 offsets are UTF-16 too (JS strings) — mapping is line/char arithmetic via the CM6 `Text` API, but it gets a dedicated util + tests because every feature depends on it.

## Editor UX

- **⌘click** on a symbol → go to definition. Same file: jump + flash line. Other file: open in the editor pane (existing open-file path), then jump. ⌥⌘click → references list (panel below editor, click to jump).
- **Hover** (~300ms dwell): CM6 tooltip with type signature + docs (markdown rendered). CM6's own tooltip system, not `attachTooltip` (in-editor positioning needs CM6's view coordinates) — visual style matches the app (sharp corners, theme tokens).
- **Diagnostics:** CM6 `lint` package: squiggles, gutter markers, diagnostics tooltip. Severity colors from theme.
- **Completion:** LSP completion source plugs into the already-installed `@codemirror/autocomplete`.
- **Rename** (F2 / context menu): inline input; applies the returned WorkspaceEdit. Edits to non-open files are applied via backend write; multi-file rename shows a count confirmation first.
- **Code actions:** lightbulb in the gutter on lines with actions; menu applies the WorkspaceEdit.
- **Status chip** in the editor header: per-language state (downloading %, starting, ready, error) with the existing chip styling. All copy in English.
- **Settings:** "Code intelligence" section — master toggle (default ON; per-server consent still gates downloads), per-language toggle, list of downloaded servers with size + delete.

## Security

- sha256 pinned in the manifest; https only; no execution of anything not hash-verified.
- Servers run as plain user child processes with cwd = workspace root. They are NOT agent-executed commands — the agent policy framework (`crates/agent/safety.rs`) is not in this path and stays out of it.
- LSP servers can read the workspace (that's their job) but get no Covenant credentials or env beyond a minimal inherited env.

## Error handling

- Download failure → banner with error + retry.
- Missing/old runtime → banner naming the exact requirement ("Requires Node ≥ 18 — not found in your shell PATH").
- Request timeouts (10s): hover/definition fail silently (log at debug); rename/code-action failures surface a toast.
- Malformed server messages: log + drop, never crash the pump.

## Testing

- `crates/lsp` unit tests: manifest deserialization, sha256 verification, framing codec (split/joined chunks, huge messages), root detection table-driven, archive unpack.
- Frontend vitest (repo root): transport mock round-trip, position-mapping util (multi-byte chars, emoji, CRLF), WorkspaceEdit application, consent-state logic.
- Integration smoke (macOS, skipped when binary absent): download rust-analyzer, spawn against a fixture crate, initialize, request definition, assert a result. Gated so CI without network/binary stays green.

## Phasing (each phase shippable)

1. **P1 — Pipeline + Rust navigation:** crates/lsp complete (registry/download/spawn/framing), transport, client, ⌘click definition + hover + references with rust-analyzer. Proves everything end-to-end with the zero-dependency server.
2. **P2 — Full IDE on Rust:** diagnostics, completion, rename, code actions. All CM6 feature UI lands here.
3. **P3 — TypeScript:** Node detection, npm-tarball distribution path. New code is only registry entries + runtime probing; features come free.
4. **P4 — C#:** Roslyn LSP self-contained + .NET SDK detection.
5. **P5 — Java:** JDT.LS: JDK detection, its nonstandard launcher config, slow-start UX (persistent "indexing…" state in the chip).
