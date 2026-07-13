#!/bin/sh
# `covenant [path]` — open a folder (as a group) or file in Covenant.
# Bundled at Covenant.app/Contents/Resources/covenant; the Homebrew cask
# symlinks it into the PATH, and Settings offers a manual install.
#
# The app is single-instance: if Covenant is already running, the spawned
# process forwards its argv to the live instance and exits immediately.
set -e

target="${1:-.}"
if [ ! -e "$target" ]; then
  echo "covenant: no such file or directory: $target" >&2
  exit 1
fi

# Resolve to an absolute path; the app canonicalizes the rest.
case "$target" in
  /*) abs="$target" ;;
  *) abs="$(cd "$(dirname "$target")" && pwd -P)/$(basename "$target")" ;;
esac

# $0 is usually a symlink (Homebrew binary stanza / manual install into
# the PATH) — walk the chain back to the real file inside the .app.
self="$0"
while [ -L "$self" ]; do
  link="$(readlink "$self")"
  case "$link" in
    /*) self="$link" ;;
    *) self="$(dirname "$self")/$link" ;;
  esac
done

app_binary="$(cd "$(dirname "$self")" && pwd -P)/../MacOS/Covenant"
if [ ! -x "$app_binary" ]; then
  app_binary="/Applications/Covenant.app/Contents/MacOS/Covenant"
fi

# Detach so the shell prompt returns immediately on cold start.
nohup "$app_binary" "$abs" >/dev/null 2>&1 &
