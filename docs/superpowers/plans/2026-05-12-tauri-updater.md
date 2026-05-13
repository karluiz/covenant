# Tauri Auto-Updater Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-update Covenant from GitHub Releases on macOS and Windows: silent check at boot + manual "Check for updates" button in Settings. Releases publish signed `latest.json` + signed artifacts; client verifies signature, downloads, installs, restarts.

**Architecture:** Use the official Tauri 2 plugin pair `tauri-plugin-updater` (Rust) + `@tauri-apps/plugin-updater` (JS). Endpoint URL points at GitHub Releases `latest/download/latest.json` with `{{target}}` + `{{arch}}` interpolation. CI signs artifacts with `TAURI_SIGNING_PRIVATE_KEY` (GitHub Actions secret) and uploads `.tar.gz`/`.msi.zip` + `.sig` + `latest.json` to the release. App embeds the corresponding public key in `tauri.conf.json`.

**Tech Stack:** Tauri 2.x, `tauri-plugin-updater` v2, GitHub Actions (existing `release-windows.yml` extended + new `release-macos.yml`), `tauri-action@v0` for build+sign+publish.

---

## Pre-Work (one-time, user runs locally — NOT a code task)

Before Task 1, the **human** must:

1. Run `npx @tauri-apps/cli signer generate -w ~/.tauri/covenant.key` (interactive, asks for a passphrase — leave blank or remember it). Outputs:
   - Private key file at `~/.tauri/covenant.key` (NEVER commit).
   - Public key printed to stdout (base64-ish string ~88 chars).
2. Save the public key. It goes into `tauri.conf.json` in Task 2.
3. Add two secrets to the GitHub repo (`https://github.com/karluiz/covenant/settings/secrets/actions`):
   - `TAURI_SIGNING_PRIVATE_KEY` = full contents of `~/.tauri/covenant.key`.
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` = passphrase from step 1 (empty string if no passphrase — set anyway so workflow env eval doesn't fail).

The agent executing this plan **MUST stop and ask the human for the public key string** if it's not provided before Task 2. Do NOT proceed with a fake key — the whole signature chain depends on this value.

---

## File Structure

- **Modify** `crates/app/Cargo.toml` — add `tauri-plugin-updater = "2"`.
- **Modify** `package.json` — add `@tauri-apps/plugin-updater` and `@tauri-apps/plugin-process` (the latter is needed to relaunch after install).
- **Modify** `crates/app/tauri.conf.json` — add `plugins.updater` section with `endpoints` + `pubkey`.
- **Modify** `crates/app/src/lib.rs` — register the updater plugin and the process plugin.
- **Create** `ui/src/updater/check.ts` — typed wrapper around `check()` from `@tauri-apps/plugin-updater`. Pure-ish: pulls platform/version into a result struct.
- **Create** `ui/src/updater/banner.ts` — discreet "Update available — install now / later" banner UI element.
- **Modify** `ui/src/main.ts` — call `runStartupUpdateCheck()` after window mount.
- **Modify** `ui/src/settings/panel.ts` — add "Check for updates" button + status text in the existing Notifications/General section (whichever fits).
- **Modify** `crates/app/capabilities/default.json` — grant `updater:default` and `process:default` capabilities to the main window.
- **Create** `.github/workflows/release-macos.yml` — new workflow: build .app on macOS runner, sign with `TAURI_SIGNING_PRIVATE_KEY`, upload `.app.tar.gz` + `.sig` to release.
- **Modify** `.github/workflows/release-windows.yml` — sign MSI for updater (produces `.msi.zip` + `.sig`), upload both alongside the existing raw `.msi`.
- **Create** `.github/workflows/release-manifest.yml` — runs after both platform builds; aggregates per-platform sigs into a single `latest.json` and uploads to release.
- **Modify** `CHANGELOG.md` — document the feature.

**Note on file boundaries:** `updater/check.ts` is the pure logic (testable). `updater/banner.ts` is the DOM glue (manual smoke test only). Keep them separate so Vitest (if added later) can hit `check.ts` without DOM.

---

## Task 1: Add updater dependencies (Rust + JS)

**Files:**
- Modify: `crates/app/Cargo.toml`
- Modify: `package.json`

- [ ] **Step 1: Add Rust dep**

In `crates/app/Cargo.toml`, in the `[dependencies]` section after the other `tauri-plugin-*` entries:

```toml
tauri-plugin-updater = "2"
tauri-plugin-process = "2"
```

- [ ] **Step 2: Add JS deps**

```bash
npm install @tauri-apps/plugin-updater @tauri-apps/plugin-process
```

This updates `package.json` and `package-lock.json`. Both files are committed.

- [ ] **Step 3: Verify build**

```bash
cargo build -p covenant
```

Expected: clean build (no use of the new plugins yet — just verifies they resolve).

- [ ] **Step 4: Commit**

```bash
git add crates/app/Cargo.toml Cargo.lock package.json package-lock.json
git commit -m "chore(deps): add tauri-plugin-updater + plugin-process"
```

---

## Task 2: Wire the plugins (Rust)

**Files:**
- Modify: `crates/app/src/lib.rs`
- Modify: `crates/app/tauri.conf.json`
- Modify: `crates/app/capabilities/default.json` (or whichever capabilities file the project uses — grep first)

**HUMAN INPUT REQUIRED:** the `<PUBKEY>` value from the pre-work step. If not provided, STOP and ask.

- [ ] **Step 1: Register plugins in Rust**

In `crates/app/src/lib.rs`, find the existing `tauri::Builder::default()` chain. After `.plugin(tauri_plugin_notification::init())` (or whichever neighbouring plugin is last), add:

```rust
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
```

Both calls return `Plugin`, both go on the builder. Do NOT add anything else to the chain.

- [ ] **Step 2: Add updater config to tauri.conf.json**

Find the existing top-level `"plugins"` key (search `"plugins"` in `crates/app/tauri.conf.json`). If absent, add it as a top-level sibling of `"bundle"`. Insert:

```json
  "plugins": {
    "updater": {
      "active": true,
      "endpoints": [
        "https://github.com/karluiz/covenant/releases/latest/download/latest.json"
      ],
      "dialog": false,
      "pubkey": "<PUBKEY>"
    }
  }
```

Replace `<PUBKEY>` with the user-provided public key (one-line base64 string). Set `"dialog": false` because we render our own banner in the UI (Task 4) rather than using the plugin's built-in dialog.

If `plugins` already exists with other entries, merge — don't overwrite.

- [ ] **Step 3: Grant capabilities**

Locate the capabilities file:

```bash
ls crates/app/capabilities/ 2>/dev/null || ls src-tauri/capabilities/ 2>/dev/null
```

Open the default capabilities JSON (likely `default.json`). Add to its `permissions` array:

```json
    "updater:default",
    "process:default"
```

Keep array ordering/style consistent with neighbouring entries.

- [ ] **Step 4: Build**

```bash
cargo build -p covenant
```

Expected: clean.

- [ ] **Step 5: Smoke run (no install yet — just verify it boots)**

```bash
npm run tauri dev
```

Open the app, confirm it launches without errors. Quit.

- [ ] **Step 6: Commit**

```bash
git add crates/app/src/lib.rs crates/app/tauri.conf.json crates/app/capabilities/default.json
git commit -m "feat(updater): register plugin and capabilities"
```

---

## Task 3: TS typed wrapper around `check()`

**Files:**
- Create: `ui/src/updater/check.ts`

- [ ] **Step 1: Write the file**

```ts
// Thin typed wrapper around @tauri-apps/plugin-updater. Lets the rest
// of the UI consume update state as a discriminated union instead of
// the plugin's looser shape, and centralises error handling for the
// silent boot-time check (which must never surface a toast on its own
// — failures are logged, not shown).

import { check, type Update } from "@tauri-apps/plugin-updater";

export type UpdateCheckResult =
  | { kind: "available"; version: string; notes: string | null; update: Update }
  | { kind: "uptodate"; currentVersion: string }
  | { kind: "error"; message: string };

export async function runUpdateCheck(opts: {
  currentVersion: string;
  silent: boolean;
}): Promise<UpdateCheckResult> {
  try {
    const update = await check();
    if (update?.available) {
      return {
        kind: "available",
        version: update.version,
        notes: update.body ?? null,
        update,
      };
    }
    return { kind: "uptodate", currentVersion: opts.currentVersion };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (opts.silent) {
      console.warn("[updater] silent check failed:", message);
    }
    return { kind: "error", message };
  }
}

export async function installAndRelaunch(update: Update): Promise<void> {
  await update.downloadAndInstall();
  // On macOS the plugin auto-restarts after install. On Windows the
  // MSI installer takes over and the app exits; tauri-plugin-process
  // gives us an explicit relaunch in case the platform doesn't.
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```

Expected: clean (no `any` leaks, plugin types resolve).

- [ ] **Step 3: Commit**

```bash
git add ui/src/updater/check.ts
git commit -m "feat(updater): typed wrapper around check + install"
```

---

## Task 4: Update banner UI

**Files:**
- Create: `ui/src/updater/banner.ts`

- [ ] **Step 1: Write the banner**

```ts
// Discreet top-of-window banner shown when an update is available.
// "Install now" triggers download + install + relaunch.
// "Later" hides the banner for this session only — next boot will
// re-check and re-show it.

import type { Update } from "@tauri-apps/plugin-updater";
import { installAndRelaunch } from "./check";

const BANNER_ID = "covenant-update-banner";

export function showUpdateBanner(update: Update): void {
  if (document.getElementById(BANNER_ID)) return; // idempotent

  const banner = document.createElement("div");
  banner.id = BANNER_ID;
  banner.className = "update-banner";
  banner.innerHTML = `
    <span class="update-banner__text">Covenant ${update.version} is available.</span>
    <button class="update-banner__install" type="button">Install now</button>
    <button class="update-banner__dismiss" type="button" aria-label="Dismiss">×</button>
  `;

  banner.querySelector<HTMLButtonElement>(".update-banner__install")!
    .addEventListener("click", async () => {
      banner.classList.add("update-banner--installing");
      banner.querySelector<HTMLElement>(".update-banner__text")!.textContent =
        "Downloading…";
      try {
        await installAndRelaunch(update);
      } catch (err) {
        banner.querySelector<HTMLElement>(".update-banner__text")!.textContent =
          `Install failed: ${err instanceof Error ? err.message : String(err)}`;
        banner.classList.remove("update-banner--installing");
      }
    });

  banner.querySelector<HTMLButtonElement>(".update-banner__dismiss")!
    .addEventListener("click", () => banner.remove());

  document.body.prepend(banner);
}
```

- [ ] **Step 2: Add CSS**

Append to `ui/src/styles.css` (find a sensible spot near other top-bar styles):

```css
.update-banner {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 9999;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 16px;
  background: rgba(40, 60, 110, 0.95);
  color: #f0f4ff;
  font-size: 13px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
}
.update-banner__text { flex: 1; }
.update-banner__install {
  background: #4a7dff; color: white; border: 0;
  padding: 4px 12px; border-radius: 4px; cursor: pointer;
}
.update-banner__install:hover { background: #5a8aff; }
.update-banner--installing .update-banner__install { opacity: 0.5; pointer-events: none; }
.update-banner__dismiss {
  background: transparent; border: 0; color: inherit;
  cursor: pointer; font-size: 18px; padding: 0 4px;
}
```

- [ ] **Step 3: Typecheck**

```bash
npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add ui/src/updater/banner.ts ui/src/styles.css
git commit -m "feat(updater): update available banner"
```

---

## Task 5: Wire silent boot check + Settings button

**Files:**
- Modify: `ui/src/main.ts`
- Modify: `ui/src/settings/panel.ts`

- [ ] **Step 1: Silent boot check in main.ts**

Find the bottom of `ui/src/main.ts` (where the app has finished mounting — search for whatever bootstrap call exists, e.g. `mountUI()` or end of `init()`). Add:

```ts
import { getVersion } from "@tauri-apps/api/app";
import { runUpdateCheck } from "./updater/check";
import { showUpdateBanner } from "./updater/banner";

async function startupUpdateCheck(): Promise<void> {
  const currentVersion = await getVersion();
  const result = await runUpdateCheck({ currentVersion, silent: true });
  if (result.kind === "available") {
    showUpdateBanner(result.update);
  }
  // "uptodate" and "error" are silent on boot.
}

// Fire-and-forget — never block window mount.
void startupUpdateCheck();
```

Place the `void startupUpdateCheck()` call AFTER the existing mount/init logic completes. If main.ts has an `async function bootstrap()`, append it at the end of that function or right after its invocation. Don't await it from anything that gates UI rendering.

- [ ] **Step 2: Manual check button in Settings**

In `ui/src/settings/panel.ts`, find a sensible section (the existing "About" / "General" area; if none, create a small section above Notifications). Add:

```ts
// === Updates section ===
const updatesField = document.createElement("div");
updatesField.className = "settings-field";
updatesField.innerHTML = `
  <label class="settings-checkbox-row" style="cursor: default;">
    <span>Check for updates</span>
    <button type="button" class="settings-button" id="settings-check-updates">Check now</button>
  </label>
  <small class="settings-hint" id="settings-update-status">Checks GitHub for the latest version.</small>
`;
pageBody.appendChild(updatesField);

const checkBtn = updatesField.querySelector<HTMLButtonElement>("#settings-check-updates")!;
const statusEl = updatesField.querySelector<HTMLElement>("#settings-update-status")!;
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
```

Adjust variable names (`pageBody`, etc.) to match the actual identifiers in panel.ts — read the file first. Match neighbouring section markup (don't invent new class names; reuse `settings-field`, `settings-button`, `settings-hint`).

- [ ] **Step 3: Typecheck + dev smoke**

```bash
npx tsc --noEmit
npm run tauri dev
```

Open Settings → click "Check now" → expect "Check failed: …" (because no signed `latest.json` exists yet — that's Task 6). Verify the error path renders cleanly, no console errors beyond the expected network/404.

- [ ] **Step 4: Commit**

```bash
git add ui/src/main.ts ui/src/settings/panel.ts
git commit -m "feat(updater): boot check + settings manual trigger"
```

---

## Task 6: GitHub Actions — macOS release workflow (new)

**Files:**
- Create: `.github/workflows/release-macos.yml`

- [ ] **Step 1: Write the workflow**

```yaml
name: Release macOS

on:
  push:
    tags:
      - 'v*'
  workflow_dispatch:

jobs:
  build:
    runs-on: macos-latest
    permissions:
      contents: write

    steps:
      - uses: actions/checkout@v4

      - name: Install Rust stable
        uses: dtolnay/rust-toolchain@stable
        with:
          targets: aarch64-apple-darwin,x86_64-apple-darwin

      - name: Cache cargo
        uses: actions/cache@v4
        with:
          path: |
            ~/.cargo/registry
            ~/.cargo/git
            target
          key: macos-cargo-${{ hashFiles('**/Cargo.lock') }}

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install frontend deps
        run: npm ci

      - name: Build + sign Tauri (universal bundle)
        env:
          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
        run: npm run tauri build -- --target universal-apple-darwin

      - name: Locate updater artifacts
        id: artifacts
        run: |
          TGZ=$(find target -name '*.app.tar.gz' | head -n1)
          SIG=$(find target -name '*.app.tar.gz.sig' | head -n1)
          if [ -z "$TGZ" ] || [ -z "$SIG" ]; then
            echo "missing tar.gz or .sig"; exit 1
          fi
          echo "tgz=$TGZ" >> "$GITHUB_OUTPUT"
          echo "sig=$SIG" >> "$GITHUB_OUTPUT"
          echo "sig_contents=$(cat "$SIG")" >> "$GITHUB_OUTPUT"

      - name: Upload to GitHub Release
        if: startsWith(github.ref, 'refs/tags/v')
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          TAG="${{ github.ref_name }}"
          gh release view "$TAG" >/dev/null 2>&1 || \
            gh release create "$TAG" --title "$TAG" --notes "Automated release. See CHANGELOG for details."
          gh release upload "$TAG" "${{ steps.artifacts.outputs.tgz }}" --clobber
          gh release upload "$TAG" "${{ steps.artifacts.outputs.sig }}" --clobber

      - name: Emit per-platform manifest fragment
        run: |
          mkdir -p manifest-fragments
          cat > "manifest-fragments/darwin-universal.json" <<EOF
          {
            "darwin-universal": {
              "signature": "$(cat "${{ steps.artifacts.outputs.sig }}")",
              "url": "https://github.com/karluiz/covenant/releases/download/${{ github.ref_name }}/$(basename "${{ steps.artifacts.outputs.tgz }}")"
            }
          }
          EOF

      - name: Upload manifest fragment artifact
        uses: actions/upload-artifact@v4
        with:
          name: manifest-darwin
          path: manifest-fragments/darwin-universal.json
```

Notes:
- `universal-apple-darwin` produces one bundle that runs on both Intel and Apple Silicon. Simpler than two separate builds; tauri-action handles the lipo step.
- No Apple Developer codesigning here. The bundle will Gatekeeper-block on first launch — the user already accepts that for current releases. Updater signature is **separate** from Gatekeeper codesigning; the updater plugin only verifies its own signature.

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/release-macos.yml
git commit -m "ci(release): macOS workflow with updater signing"
```

---

## Task 7: Extend Windows workflow with updater signing

**Files:**
- Modify: `.github/workflows/release-windows.yml`

- [ ] **Step 1: Add signing env to the existing `Build Tauri MSI` step**

Find this block in the workflow:

```yaml
      - name: Build Tauri MSI
        run: npm run tauri build
        env:
          # Unsigned build — TAURI_SIGNING_PRIVATE_KEY intentionally omitted.
          RUST_BACKTRACE: 1
```

Replace with:

```yaml
      - name: Build Tauri MSI (signed for updater)
        run: npm run tauri build
        env:
          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
          RUST_BACKTRACE: 1
```

- [ ] **Step 2: Add a step to locate the updater artifacts (.msi.zip + .sig)**

After the existing `Locate MSI` step, add:

```yaml
      - name: Locate updater artifacts
        id: updater
        shell: pwsh
        run: |
          $zip = Get-ChildItem -Recurse -Filter '*.msi.zip' | Select-Object -First 1
          $sig = Get-ChildItem -Recurse -Filter '*.msi.zip.sig' | Select-Object -First 1
          if (-not $zip -or -not $sig) { Write-Error 'missing updater artifacts'; exit 1 }
          "zip_path=$($zip.FullName)" >> $env:GITHUB_OUTPUT
          "zip_name=$($zip.Name)"     >> $env:GITHUB_OUTPUT
          "sig_path=$($sig.FullName)" >> $env:GITHUB_OUTPUT
```

- [ ] **Step 3: Extend the upload step to include .msi.zip + .sig**

In the existing `Upload MSI to release` step, after the existing `gh release upload` for the raw MSI, append:

```pwsh
          gh release upload $tag "${{ steps.updater.outputs.zip_path }}" --clobber
          gh release upload $tag "${{ steps.updater.outputs.sig_path }}" --clobber
```

- [ ] **Step 4: Emit a Windows manifest fragment**

Add at the bottom of the job (mirror the macOS workflow):

```yaml
      - name: Emit per-platform manifest fragment
        shell: pwsh
        run: |
          New-Item -ItemType Directory -Path manifest-fragments -Force | Out-Null
          $sig = Get-Content -Raw "${{ steps.updater.outputs.sig_path }}"
          $url = "https://github.com/karluiz/covenant/releases/download/${{ github.ref_name }}/${{ steps.updater.outputs.zip_name }}"
          $json = @{ "windows-x86_64" = @{ signature = $sig; url = $url } } | ConvertTo-Json -Depth 4
          Set-Content -Path manifest-fragments/windows-x86_64.json -Value $json

      - name: Upload manifest fragment artifact
        uses: actions/upload-artifact@v4
        with:
          name: manifest-windows
          path: manifest-fragments/windows-x86_64.json
```

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/release-windows.yml
git commit -m "ci(release): windows MSI signed for updater"
```

---

## Task 8: Aggregator workflow — build `latest.json` and upload

**Files:**
- Create: `.github/workflows/release-manifest.yml`

- [ ] **Step 1: Write the workflow**

```yaml
name: Release Manifest

on:
  workflow_run:
    workflows: ["Release macOS", "Release Windows"]
    types: [completed]

jobs:
  aggregate:
    if: github.event.workflow_run.conclusion == 'success' && startsWith(github.event.workflow_run.head_branch, 'v')
    runs-on: ubuntu-latest
    permissions:
      contents: write
      actions: read

    steps:
      - uses: actions/checkout@v4

      - name: Download macOS fragment
        uses: actions/download-artifact@v4
        with:
          name: manifest-darwin
          path: fragments
          github-token: ${{ secrets.GITHUB_TOKEN }}
          run-id: ${{ github.event.workflow_run.id }}
        continue-on-error: true

      - name: Download Windows fragment
        uses: actions/download-artifact@v4
        with:
          name: manifest-windows
          path: fragments
          github-token: ${{ secrets.GITHUB_TOKEN }}
          run-id: ${{ github.event.workflow_run.id }}
        continue-on-error: true

      - name: Read existing latest.json (if any) and merge
        id: merge
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          TAG="${{ github.event.workflow_run.head_branch }}"
          VERSION="${TAG#v}"
          DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

          # Start from a previously-uploaded latest.json (carries the
          # other platform's signature when this run only built one).
          EXISTING="{}"
          if gh release view "$TAG" --json assets --jq '.assets[].name' | grep -q '^latest.json$'; then
            gh release download "$TAG" -p latest.json -D /tmp -O latest.json
            EXISTING="$(cat /tmp/latest.json)"
          fi

          MERGED_PLATFORMS=$(jq -s 'reduce .[] as $f ({}; . * $f)' fragments/*.json 2>/dev/null || echo '{}')

          jq -n \
            --arg v "$VERSION" \
            --arg d "$DATE" \
            --arg notes "See https://github.com/karluiz/covenant/releases/tag/$TAG" \
            --argjson existing "$EXISTING" \
            --argjson merged "$MERGED_PLATFORMS" \
            '{version: $v, notes: $notes, pub_date: $d, platforms: (($existing.platforms // {}) * $merged)}' \
            > latest.json

          cat latest.json

      - name: Upload latest.json to release
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          TAG="${{ github.event.workflow_run.head_branch }}"
          gh release upload "$TAG" latest.json --clobber
```

Notes:
- This workflow fires after **either** platform workflow finishes. Each run reads any pre-existing `latest.json` from the release, merges in the new platform's fragment, and re-uploads. This way the second platform's run doesn't clobber the first's signature.
- The `head_branch` filter `startsWith(... 'v')` is a workaround — `workflow_run` events report the source ref via `head_branch` for tag pushes.

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/release-manifest.yml
git commit -m "ci(release): aggregate latest.json manifest"
```

---

## Task 9: Docs + CHANGELOG

**Files:**
- Modify: `CHANGELOG.md`
- Create: `docs/updater.md` (operator/maintainer docs — kept minimal)

- [ ] **Step 1: CHANGELOG entry** — append above `## v0.4.2`:

```markdown
## v0.5.0 — Auto-Updater

Covenant now checks GitHub Releases at boot for new versions and offers
to install + relaunch. A "Check for updates" button in Settings exposes
the same flow manually. Updates are cryptographically signed; the
client refuses to install any artifact whose signature doesn't match
the embedded public key.

### Added

- `tauri-plugin-updater` + `tauri-plugin-process` integration.
- Silent update check at app boot (failures logged, never toasted).
- "Update available" banner with **Install now / Dismiss** actions.
- Settings → "Check for updates" button with inline status feedback.
- macOS release workflow (`release-macos.yml`) producing signed
  `.app.tar.gz` + `.sig` for the updater.
- `release-windows.yml` now signs the MSI bundle and uploads
  `.msi.zip` + `.sig` alongside the raw `.msi`.
- `release-manifest.yml` aggregates per-platform signatures into a
  single `latest.json` published to the release.

### Operator notes

See `docs/updater.md` for keypair rotation and required GitHub
Actions secrets (`TAURI_SIGNING_PRIVATE_KEY`,
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`).
```

Also bump versions:
- `Cargo.toml`: `version = "0.4.2"` → `"0.5.0"`
- `package.json`: `0.4.2` → `0.5.0`
- `crates/app/tauri.conf.json`: `0.4.2` → `0.5.0`

- [ ] **Step 2: Write `docs/updater.md`**

```markdown
# Auto-Updater — Operator Notes

Covenant uses Tauri's `tauri-plugin-updater` against GitHub Releases.

## How it works

1. App boots → calls the updater plugin which fetches
   `https://github.com/karluiz/covenant/releases/latest/download/latest.json`.
2. Plugin compares the JSON's `version` to the embedded app version.
3. If newer, the UI shows a banner. On confirm: download `.tar.gz` /
   `.msi.zip`, verify Ed25519 signature against the embedded pubkey,
   replace the bundle, relaunch.

## Required secrets

GitHub repo settings → Secrets → Actions:

- `TAURI_SIGNING_PRIVATE_KEY` — contents of the keypair's private key
  file (generated locally with `npx @tauri-apps/cli signer generate`).
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — passphrase used at generation
  time. Set to empty string if no passphrase was used (the workflow
  references it unconditionally).

## Rotating the key

1. Generate a fresh keypair locally.
2. Update `plugins.updater.pubkey` in `crates/app/tauri.conf.json`.
3. Replace the two GitHub Actions secrets.
4. Ship a release built with the new pubkey. **Older clients will
   never accept updates signed by the new key** — they must be
   re-installed manually. Treat key rotation as a breaking event.

## Forcing a fresh install (skipping the updater)

If a client is stuck on a broken version, download the raw `.app` /
`.msi` from the GitHub release page and install over the existing
copy. The updater is not the only install path.
```

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md docs/updater.md Cargo.toml Cargo.lock package.json crates/app/tauri.conf.json
git commit -m "chore(release): v0.5.0 — auto-updater"
```

---

## Task 10: End-to-end verification (manual, gated on real release)

**Cannot be automated** — requires publishing a real GitHub Release.

- [ ] **Step 1: Local build sanity**

```bash
cargo build -p covenant
npm run tauri build
```

Confirm both macOS `.app.tar.gz` + `.app.tar.gz.sig` AND, on a Windows machine, `.msi.zip` + `.msi.zip.sig` are produced when `TAURI_SIGNING_PRIVATE_KEY` is exported. (One platform at a time is fine.)

- [ ] **Step 2: Push the v0.5.0 tag**

```bash
git tag v0.5.0
git push origin main --tags
```

Watch both `Release macOS` and `Release Windows` workflows complete. Confirm `Release Manifest` runs after each and that `latest.json` on the release contains BOTH `darwin-universal` and `windows-x86_64` keys after the second run.

- [ ] **Step 3: Install v0.5.0 as the BASELINE**

Install v0.5.0 manually on macOS (and ideally Windows). This is the version that will _check for_ updates — it has the updater plugin embedded.

- [ ] **Step 4: Cut a no-op v0.5.1**

```bash
# Just bump the patch with no real changes
git commit --allow-empty -m "chore(release): v0.5.1 — updater smoke"
git tag v0.5.1
git push origin main --tags
```

Wait for workflows to finish.

- [ ] **Step 5: Launch v0.5.0 → expect banner**

Within ~5 seconds of launch, the "Covenant 0.5.1 is available" banner should appear. Click "Install now" → wait → app relaunches as v0.5.1.

Failure modes to investigate:
- Banner never appears: check `~/Library/Logs/Covenant/` (macOS) / `%LOCALAPPDATA%\Covenant\logs\`. Most common cause: `latest.json` 404 or signature mismatch.
- "Install failed: signature is invalid": pubkey in `tauri.conf.json` doesn't match the private key used to sign. Rebuild + reship.
- Banner appears but install hangs: network issue or the bundle URL in `latest.json` points to a missing asset.

- [ ] **Step 6: Verify the manual button**

Open v0.5.1 → Settings → "Check now" → expect "You're on the latest version (v0.5.1)."

---

## Self-Review Notes

**Spec coverage:**
- "Silent al boot + botón manual en Settings" → Task 5 ✓
- "macOS + Windows" → Tasks 6 + 7 ✓
- "GitHub releases as source" → endpoint in Task 2 + workflows in Tasks 6–8 ✓
- "TDD donde aplique" → updater logic is mostly plumbing (typed wrapper + DOM). The only pure-logic piece is `runUpdateCheck`'s discriminated union; manual smoke + typecheck cover it. No backend Rust logic to TDD (plugin is a black box). E2E test = Task 10. Trade-off: deferring formal unit tests on TS wrappers because real coverage requires the live HTTP/signature path, which a unit test can't faithfully reproduce.

**Placeholder scan:**
- `<PUBKEY>` in Task 2 is explicitly flagged as requiring human input. Not a silent TODO.
- No other placeholders.

**Type consistency:**
- `UpdateCheckResult` shape used by both main.ts and panel.ts.
- `Update` type imported from the plugin in both check.ts and banner.ts.
- Version strings flow through `getVersion()` consistently.

**Risks:**
- macOS workflow currently does no Apple Developer codesigning. Gatekeeper will still warn on first launch of every update. Acceptable today (matches current behavior of v0.4.x). Document this in `docs/updater.md` if it surprises users.
- The aggregator workflow assumes both platform workflows ALWAYS run on the same tag. If only one ran (e.g., Windows-only fix), `latest.json` will still publish but with one platform missing — clients on the other platform will be told there's no update. Acceptable.
