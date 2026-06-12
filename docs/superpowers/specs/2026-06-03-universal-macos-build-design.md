# Universal macOS Build (Intel + Apple Silicon)

**Date:** 2026-06-03
**Status:** Approved (design)

## Problem

Covenant ships an `aarch64-apple-darwin`-only DMG, and the Homebrew cask is pinned
to `depends_on arch: :arm64`. Intel Mac users hit:

```
Error: Cask covenant depends on hardware architecture being one of
[{type: :arm, bits: 64}], but you are running {type: :intel, bits: 64}.
```

There is no Intel artifact to fall back to, and Intel users on an old version
receive no auto-updates (the updater manifest has no `darwin-x86_64` entry).

## Goal

One universal DMG that runs natively on both Apple Silicon and Intel, distributed
through the existing GitHub Release + Homebrew tap path, with a working auto-updater
for both arches. No app/runtime code changes.

## Approach: Universal binary via `lipo`

Chosen over two separate per-arch DMGs because it keeps distribution single-artifact:
one cask URL, no `on_arm`/`on_intel` logic, one updater entry source, one
sign+notarize pass. Trade-off accepted: DMG size roughly doubles (both arch slices
fused). Tauri supports `--target universal-apple-darwin` natively.

## Changes

### 1. `.github/workflows/release-macos.yml`

- **Toolchain targets:** add `x86_64-apple-darwin` alongside `aarch64-apple-darwin`
  in the `dtolnay/rust-toolchain` step (both slices must compile).
- **Build command:** change
  `npm run tauri build -- --target aarch64-apple-darwin`
  → `npm run tauri build -- --target universal-apple-darwin`.
  Tauri compiles both arches, `lipo`-fuses them, then signs + notarizes the fused
  bundle once. Same `APPLE_*` / `TAURI_SIGNING_*` secrets — no new secrets.
- **Artifact locate:** the existing `find target -name '*.dmg'` /
  `'*.app.tar.gz'` globs are name-agnostic and already handle the renamed
  `Covenant_<version>_universal.dmg` output. Verify the actual emitted filename
  during first run.

### 2. Updater manifest fragment (same workflow)

The universal `.app.tar.gz` runs on both arches, so emit **both** platform keys
pointing at the same URL + signature:

```json
{
  "darwin-aarch64": { "signature": "<sig>", "url": "<universal tgz url>" },
  "darwin-x86_64":  { "signature": "<sig>", "url": "<universal tgz url>" }
}
```

This is the only way existing Intel users (if any) get auto-updates; previously the
fragment had `darwin-aarch64` only. `release-manifest.yml` merges fragments with
`reduce .[] as $f ({}; . * $f)` — both keys flow through unchanged, no edit needed.

### 3. Homebrew cask (generated inline in `release-macos.yml`)

- Remove `depends_on arch: :arm64`.
- Keep `depends_on macos: ">= :ventura"` — Intel Macs top out at Ventura, so this
  bound still holds for both arches.
- Change URL suffix `_aarch64.dmg` → `_universal.dmg`:
  `url ".../Covenant_#{version}_universal.dmg"`.
- `sha256` is still the single fused-DMG hash (already computed by `dmg_sha256`).

### 4. `crates/app/tauri.conf.json`

No change. `--target universal-apple-darwin` drives the bundle; `bundle.targets`
stays as-is.

## Risks / Verification

- **DMG filename:** confirm Tauri emits `_universal` (not `_aarch64`) for the
  universal target; the locate globs are robust either way, but the cask URL string
  is hardcoded and must match. Verify on first tagged build.
- **Notarization of fused bundle:** standard Tauri path, but confirm `notarytool`
  accepts the `lipo`-fused `.app` without per-slice complaints.
- **Build time / runner:** two-arch compile roughly doubles CI build time on the
  `macos-latest` runner. Acceptable; no parallelism needed.

## Out of scope

- Separate per-arch DMGs (rejected in favor of universal).
- Windows / Intel-Windows (unrelated pipeline).
- Submission to official homebrew-cask repo.
