#!/usr/bin/env bash
# Build Covenant in release mode and install the .app into /Applications,
# replacing any previous install. After this, the Spotlight entry
# "Covenant — Applications" always points to the latest build.
#
# Usage:
#   ./scripts/install.sh         # build + install (auto-backs up user data)
#   ./scripts/install.sh --skip-build  # only copy an already-built bundle
#   ./scripts/install.sh --open  # also launch the app after install
#   ./scripts/install.sh --no-backup   # skip the user-data snapshot
#
# Backups live under:
#   ~/Library/Application Support/com.karluiz.covenant/backups/<timestamp>/
# The 5 most recent are kept; older ones are pruned automatically.
# Restore with: cp -R <backup>/tab_manifest.json "$DATA_DIR/"

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUNDLE="$REPO_ROOT/target/release/bundle/macos/Covenant.app"
DEST="/Applications/Covenant.app"

SKIP_BUILD=0
LAUNCH=0
SKIP_BACKUP=0
for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=1 ;;
    --open|--launch) LAUNCH=1 ;;
    --no-backup) SKIP_BACKUP=1 ;;
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
  # --bundles app: only the .app, skip .dmg. The dmg path requires
  # `create-dmg` to be invoked with specific args that have broken
  # in some Tauri CLI versions; we don't ship via .dmg locally so
  # there's no point letting that block our install loop.
  npx tauri build --bundles app
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

# Snapshot user state before swapping the .app. The install itself
# only touches /Applications, but a corrupt schema bump or a bad
# migration in the new build could brick the data dir on first launch.
# A timestamped copy under …/backups/ gives us a one-command rollback.
DATA_DIR="$HOME/Library/Application Support/com.karluiz.covenant"
BACKUP_ROOT="$DATA_DIR/backups"
if [[ -d "$DATA_DIR" && "$SKIP_BACKUP" -eq 0 ]]; then
  STAMP="$(date +%Y%m%d-%H%M%S)"
  BACKUP_DIR="$BACKUP_ROOT/$STAMP"
  echo "→ backing up user data to ${BACKUP_DIR}…"
  mkdir -p "$BACKUP_ROOT"
  # Copy everything except the backups dir itself (avoid recursion).
  # rsync handles "source/." semantics cleanly and preserves perms.
  rsync -a --exclude="backups" "$DATA_DIR/" "$BACKUP_DIR/" 2>/dev/null || {
    echo "  rsync failed; skipping backup (data dir untouched)" >&2
  }
  # Prune: keep the 5 most recent snapshots.
  if [[ -d "$BACKUP_ROOT" ]]; then
    # shellcheck disable=SC2012
    ls -1t "$BACKUP_ROOT" | tail -n +6 | while read -r old; do
      rm -rf "$BACKUP_ROOT/$old"
    done
  fi
fi

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
