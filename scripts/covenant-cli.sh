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

# `mcp-config` / `mcp-stdio` are CLI subcommands, not paths — hand them
# straight to the app binary's early-arg handler (crates/app/src/lib.rs) in
# the foreground so stdin/stdout/stderr and the exit code reach the caller
# (`mcp-stdio` speaks JSON-RPC over exactly that pipe). This must run before
# the path-existence check below, otherwise a file literally named
# `mcp-config` in cwd would shadow the subcommand. `covenant ./mcp-config`
# still opens the file.
case "${1:-}" in
  mcp-config | mcp-stdio) exec "$app_binary" "$1" ;;
esac

# `covenant mcp-stdio` — stdio transport for the app's MCP server, so
# executor configs can point at a stable command even though the HTTP
# endpoint rebinds (fresh port + token) on every app boot. Reads the
# discovery file at connect time and delegates the transport to mcp-remote.
if [ "${1:-}" = "mcp-stdio" ]; then
  disc="$HOME/Library/Application Support/com.karluiz.covenant/mcp.json"
  if [ ! -f "$disc" ]; then
    echo "covenant: app not running (no discovery file at $disc)" >&2
    exit 1
  fi
  url=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['url'])" "$disc")
  token=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['token'])" "$disc")
  exec npx -y mcp-remote "$url" --header "Authorization: Bearer $token" --transport http-only
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
