#!/usr/bin/env bash
# install-linux.sh — install a Covenant build on Linux.
#
# Usage:
#   ./scripts/install-linux.sh [--format appimage|deb|rpm] [--no-backup]
#
# Default format is auto-detected from whatever was built last.
# Requires: pkill (from procps), xdg-open (xdg-utils).
#
# Data backup: copies $XDG_DATA_HOME/com.karluiz.covenant (or
#   ~/.config/com.karluiz.covenant) to a timestamped .tar.gz.
#   Keeps the 5 most recent backups. Pass --no-backup to skip.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUNDLE_BASE="${REPO_ROOT}/target/release/bundle"

FORMAT="${FORMAT:-auto}"
DO_BACKUP=true
OPEN_AFTER=false

for arg in "$@"; do
    case "$arg" in
        --format=*) FORMAT="${arg#--format=}" ;;
        --format)   shift; FORMAT="$1" ;;
        --no-backup) DO_BACKUP=false ;;
        --open)     OPEN_AFTER=true ;;
        *) echo "Unknown argument: $arg" >&2; exit 1 ;;
    esac
done

# ---------------------------------------------------------------------------
# Detect format
# ---------------------------------------------------------------------------

if [[ "$FORMAT" == "auto" ]]; then
    if [[ -d "${BUNDLE_BASE}/appimage" ]]; then
        FORMAT="appimage"
    elif [[ -d "${BUNDLE_BASE}/deb" ]]; then
        FORMAT="deb"
    elif [[ -d "${BUNDLE_BASE}/rpm" ]]; then
        FORMAT="rpm"
    else
        echo "No bundle found under ${BUNDLE_BASE}. Run 'npm run tauri:build' first." >&2
        exit 1
    fi
fi

# ---------------------------------------------------------------------------
# Locate bundle artifact
# ---------------------------------------------------------------------------

case "$FORMAT" in
    appimage)
        ARTIFACT="$(find "${BUNDLE_BASE}/appimage" -name "*.AppImage" | sort | tail -1)"
        ;;
    deb)
        ARTIFACT="$(find "${BUNDLE_BASE}/deb" -name "*.deb" | sort | tail -1)"
        ;;
    rpm)
        ARTIFACT="$(find "${BUNDLE_BASE}/rpm" -name "*.rpm" | sort | tail -1)"
        ;;
    *)
        echo "Unknown format: $FORMAT (must be appimage, deb, or rpm)" >&2
        exit 1
        ;;
esac

if [[ -z "$ARTIFACT" || ! -f "$ARTIFACT" ]]; then
    echo "Bundle artifact not found for format '${FORMAT}'. Run 'npm run tauri:build' first." >&2
    exit 1
fi

echo "Installing ${FORMAT}: ${ARTIFACT}"

# ---------------------------------------------------------------------------
# Backup user data
# ---------------------------------------------------------------------------

DATA_DIR="${XDG_CONFIG_HOME:-${HOME}/.config}/com.karluiz.covenant"

if $DO_BACKUP && [[ -d "$DATA_DIR" ]]; then
    BACKUP_DIR="${DATA_DIR}/backups"
    mkdir -p "$BACKUP_DIR"
    STAMP="$(date +%Y%m%d_%H%M%S)"
    BACKUP_FILE="${BACKUP_DIR}/covenant_${STAMP}.tar.gz"
    echo "Backing up ${DATA_DIR} → ${BACKUP_FILE}"
    tar -czf "$BACKUP_FILE" -C "$(dirname "$DATA_DIR")" "$(basename "$DATA_DIR")" \
        --exclude="$(basename "$DATA_DIR")/backups"
    # Keep only the 5 most recent backups.
    ls -t "${BACKUP_DIR}"/covenant_*.tar.gz 2>/dev/null | tail -n +6 | xargs -r rm --
fi

# ---------------------------------------------------------------------------
# Quit running instance
# ---------------------------------------------------------------------------

if pkill -0 -x covenant 2>/dev/null; then
    echo "Quitting running Covenant instance…"
    pkill -x covenant || true
    sleep 1
fi

# ---------------------------------------------------------------------------
# Install
# ---------------------------------------------------------------------------

DEST_APPIMAGE="${HOME}/.local/bin/covenant"

case "$FORMAT" in
    appimage)
        mkdir -p "${HOME}/.local/bin"
        cp -f "$ARTIFACT" "$DEST_APPIMAGE"
        chmod +x "$DEST_APPIMAGE"
        echo "Installed to ${DEST_APPIMAGE}"

        # Install .desktop file for app launchers.
        DESKTOP_DIR="${XDG_DATA_HOME:-${HOME}/.local/share}/applications"
        mkdir -p "$DESKTOP_DIR"
        cat > "${DESKTOP_DIR}/covenant.desktop" <<DESKTOP
[Desktop Entry]
Version=1.0
Name=Covenant
Comment=AI-native terminal
Exec=${DEST_APPIMAGE} %U
Icon=covenant
Terminal=false
Type=Application
Categories=TerminalEmulator;
StartupWMClass=covenant
DESKTOP
        # Refresh desktop database if xdg-desktop-menu is available.
        command -v xdg-desktop-menu &>/dev/null && xdg-desktop-menu forceupdate || true
        ;;
    deb)
        echo "Installing .deb (requires sudo)…"
        sudo apt-get install -y "$ARTIFACT"
        ;;
    rpm)
        echo "Installing .rpm (requires sudo)…"
        if command -v dnf &>/dev/null; then
            sudo dnf install -y "$ARTIFACT"
        elif command -v rpm &>/dev/null; then
            sudo rpm -Uvh "$ARTIFACT"
        else
            echo "Neither dnf nor rpm found. Install manually: $ARTIFACT" >&2
            exit 1
        fi
        ;;
esac

echo "Done."

# ---------------------------------------------------------------------------
# Launch
# ---------------------------------------------------------------------------

if $OPEN_AFTER; then
    case "$FORMAT" in
        appimage) "$DEST_APPIMAGE" & ;;
        *)        command -v covenant &>/dev/null && covenant & || true ;;
    esac
fi
