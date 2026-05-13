# Auto-Updater — Operator Notes

Covenant uses Tauri's `tauri-plugin-updater` against GitHub Releases.

## How it works

1. App boots → calls the updater plugin which fetches
   `https://github.com/karluiz/covenant/releases/latest/download/latest.json`.
2. Plugin compares the JSON's `version` to the embedded app version.
3. If newer, the UI shows a banner. On confirm: download `.tar.gz` /
   `.msi.zip`, verify Ed25519 signature against the embedded pubkey,
   replace the bundle, relaunch.

## Required GitHub Actions secrets

GitHub repo → Settings → Secrets → Actions:

- `TAURI_SIGNING_PRIVATE_KEY` — contents of `~/.tauri/covenant.key`
  (generated locally with `npx @tauri-apps/cli signer generate --ci -p "" -w ~/.tauri/covenant.key`).
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — passphrase from generation.
  GitHub disallows empty secrets, so set a placeholder like `none` when
  no passphrase was used (Tauri ignores the value when the key is
  unencrypted).

## Backing up the private key

If the private key is lost, **no current or future client will accept
your updates** — every installed copy of Covenant becomes a manual-
upgrade-only client. Keep an offline backup of `~/.tauri/covenant.key`.

## Rotating the key

1. Generate a fresh keypair locally with the same CLI command.
2. Update `plugins.updater.pubkey` in `crates/app/tauri.conf.json`.
3. Replace both GitHub Actions secrets.
4. Ship a release built with the new pubkey. Older clients that
   already trust the previous pubkey will **never** accept updates
   signed by the new key — they must be re-installed manually. Treat
   key rotation as a breaking event.

## Forcing a fresh install (bypassing the updater)

Download the raw `.app` (macOS) or `.msi` (Windows) from the release
page and install over the existing copy. The updater is not the only
install path; it's just the convenient one.

## Codesigning vs updater signing

The updater's Ed25519 signature is **separate** from platform
codesigning (Apple Developer / Authenticode). Without codesigning,
Gatekeeper and SmartScreen will still warn users on first launch
even though the updater signature verifies. Adding codesigning is a
follow-up not covered by this release.
