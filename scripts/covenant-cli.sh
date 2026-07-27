#!/bin/sh
# `covenant [path]` — open a folder (as a group) or file in Covenant.
# Bundled at Covenant.app/Contents/Resources/covenant; the Homebrew cask
# symlinks it into the PATH, and Settings offers a manual install.
#
# The app is single-instance: if Covenant is already running, the spawned
# process forwards its argv to the live instance and exits immediately.
set -e

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

# `covenant mcp-config` is a CLI subcommand, not a path — hand it straight to
# the app binary's early-arg handler (crates/app/src/lib.rs) in the
# foreground so stdout/stderr and the exit code reach the caller. This must
# run before the path-existence check below, otherwise a file literally
# named `mcp-config` in cwd would shadow the subcommand. `covenant
# ./mcp-config` still opens the file.
if [ "${1:-}" = "mcp-config" ]; then
  exec "$app_binary" mcp-config
fi

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

# Detach so the shell prompt returns immediately on cold start.
nohup "$app_binary" "$abs" >/dev/null 2>&1 &
