# fastembed / ort — macOS notarization risk assessment

## Summary

- **Risk: low.** `ort` 2.0.0-rc.12 (pulled by `fastembed = "5"`) defaults to the pyke `download-binaries` feature, which on `aarch64-apple-darwin` ships a **static archive** (`libonnxruntime.a`), not a dylib. The current `target/debug/covenant` Mach-O has zero `onnxruntime` references in `otool -L`.
- **Fix: none required.** No Cargo change. No extra entitlements. No `extraResources`. Hardened runtime + standard codesign of the single main binary is sufficient because ONNX Runtime is statically linked into `libcovenant_lib.dylib` / `covenant`.
- **Caveat:** model weights (`*.onnx`) are downloaded by `fastembed`/`hf-hub` at first run into the user's cache dir. That happens post-install at runtime, not in the bundle, so notarization is not affected. Network access at first launch is required (already true for Anthropic API calls).

## Findings

### Cargo.lock

| Crate | Version | Source |
|---|---|---|
| `fastembed` | 5.13.4 | crates.io |
| `ort` | 2.0.0-rc.12 | crates.io |
| `ort-sys` | 2.0.0-rc.12 | crates.io |

`crates/app/Cargo.toml`:
```toml
fastembed = "5"
```
No explicit `ort` declaration; we inherit fastembed v5's default features. Fastembed v5's default for `ort` enables `download-binaries`, which fetches a prebuilt onnxruntime via `ort-sys`'s `pyke` distribution channel.

### Build artefacts

- pyke cache (build-time only, not bundled): `~/Library/Caches/ort.pyke.io/dfbin/aarch64-apple-darwin/<hash>/libonnxruntime.a` — **static archive, no dylib present**.
- `find target/debug -name "*onnxruntime*"` → empty (no dylib copied into target).
- `find target/debug -maxdepth 3 -name "*.dylib"` → only proc-macro and `libcovenant_lib.dylib`. No ONNX dylib.
- `otool -L target/debug/covenant | grep -i onnx` → empty. Confirms static linkage.

### Tauri config (`crates/app/tauri.conf.json`)

Current `bundle` block is minimal:
```json
"bundle": {
  "active": true,
  "targets": "all",
  "icon": [ ... ]
}
```

Gaps relative to a signed/notarized release (independent of fastembed):
- No `bundle.macOS.signingIdentity`.
- No `bundle.macOS.entitlements` path.
- No `bundle.macOS.hardenedRuntime` toggle (Tauri defaults to true on signed builds, but config is silent).
- No `bundle.macOS.minimumSystemVersion`.
- No `bundle.macOS.providerShortName` / notarization team id (handled via env vars `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` at `tauri build` time — fine, but worth documenting).

None of these gaps are caused by fastembed. They are baseline Tauri release-engineering work.

## Required changes for a signed release (fastembed-specific)

**None.** Because ONNX Runtime is statically linked, the standard single-binary notarization path works. Specifically:

- Do **not** add `com.apple.security.cs.disable-library-validation`.
- Do **not** add `extraResources` for `libonnxruntime.dylib`.
- Do **not** add `dlopen` allow-rules.
- Do **not** switch to `load-dynamic`.

The PTY child shell is a separate concern (`com.apple.security.cs.allow-unsigned-executable-memory` is generally NOT needed; `com.apple.security.cs.allow-jit` likewise NOT for our use case; the shell is a separate signed system binary at `/bin/zsh`).

## Recommended approach

**Keep current configuration.** Static linkage via pyke is the path of least resistance and is what we're already on by accident-of-defaults. To make this intentional and CI-stable, optionally pin in `crates/app/Cargo.toml`:

```toml
fastembed = { version = "5", default-features = false, features = ["ort-download-binaries"] }
```

This is cosmetic — it documents intent. We did not apply it because (a) it's not load-bearing today and (b) feature-name churn between fastembed minor versions could break CI for no current benefit. Revisit if we ever cross-compile or hit a CI builder without internet (the pyke cache is a build-time download).

If we ever want to remove the build-time download (hermetic builds), the alternative is:
```toml
ort = { version = "=2.0.0-rc.12", features = ["copy-dylibs"], default-features = false }
```
plus vendoring `libonnxruntime.a` ourselves and pointing `ORT_LIB_LOCATION` at it. Out of scope today.

## Open questions

- Have we run `tauri build --target aarch64-apple-darwin` end-to-end? The static-link conclusion was verified on the **debug** binary. Release LTO + strip should preserve static linkage, but we haven't produced a `.app` and codesigned it yet. First release-build attempt will confirm.
- Universal2 (`x86_64 + arm64`) build: pyke ships separate static archives per arch. If we go universal, both archives must be available at build time on the build host. Not a notarization issue per se — a CI/build-matrix issue.
- Future fastembed major bump (v6+): re-verify default features for `ort`. If upstream switches default to `load-dynamic`, this analysis must be redone and the recommendations above flip from "do nothing" to "ship dylib in `Frameworks/` + sign it + add entitlement".
