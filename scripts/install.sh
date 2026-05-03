#!/usr/bin/env bash
# Build Covenant in release mode and install the .app into /Applications,
# replacing any previous install. After this, the Spotlight entry
# "Covenant — Applications" always points to the latest build.
#
# Usage:
#   ./scripts/install.sh         # build + install
#   ./scripts/install.sh --skip-build  # only copy an already-built bundle
#   ./scripts/install.sh --open  # also launch the app after install

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUNDLE="$REPO_ROOT/target/release/bundle/macos/Covenant.app"
DEST="/Applications/Covenant.app"

SKIP_BUILD=0
LAUNCH=0
for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=1 ;;
    --open|--launch) LAUNCH=1 ;;
    -h|--help)
      sed -n '2,12p' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *)
      echo "unknown arg: $arg" >&2
      exit 2
      ;;
  esac
done

cd "$REPO_ROOT"

if [[ "$SKIP_BUILD" -eq 0 ]]; then
  echo "→ building release bundle (this can take a couple of minutes the first time)…"
  npm run tauri:build
else
  echo "→ skipping build (--skip-build)"
fi

if [[ ! -d "${BUNDLE}" ]]; then
  echo "✗ bundle not found at ${BUNDLE}" >&2
  echo "  run without --skip-build, or check the tauri:build output for errors." >&2
  exit 1
fi

# Quit any running instance so the rm doesn't fight an open file handle.
# osascript exits 0 even if Covenant isn't running, so this is safe.
echo "→ quitting running Covenant if any…"
osascript -e 'tell application "Covenant" to quit' >/dev/null 2>&1 || true
sleep 0.5

echo "→ installing to ${DEST}…"
rm -rf "${DEST}"
cp -R "${BUNDLE}" "${DEST}"

# Strip the macOS quarantine xattr so Gatekeeper doesn't show the
# "downloaded from internet" prompt on first launch of a fresh build.
xattr -dr com.apple.quarantine "${DEST}" 2>/dev/null || true

echo "✓ installed Covenant.app at ${DEST}"

if [[ "${LAUNCH}" -eq 1 ]]; then
  echo "→ launching…"
  open "${DEST}"
fi
