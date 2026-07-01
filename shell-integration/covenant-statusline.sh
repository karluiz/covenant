#!/bin/sh
# Covenant statusLine bridge for Claude Code.
#
# Claude Code invokes this command with its status JSON on stdin
# (model.display_name, context_window.used_percentage, current_usage
# token breakdown, cost, session_id, ...). This is a documented, stable
# data contract — NOT the rendered TUI — so it survives Claude UI changes.
#
# We do two things:
#   1. Hand the raw JSON to Covenant, keyed by this tab ($COVENANT_TAB).
#      Covenant parses it (serde) and drives the status-bar vitals.
#   2. Chain the user's original statusLine ($COVENANT_ORIG_STATUSLINE)
#      so their prompt renders exactly as before.
#
# No jq dependency: Covenant does the parsing. If neither env var is set
# (i.e. not launched by Covenant), this degrades to a no-op.
input=$(cat)

# Diagnostic: confirm the helper is actually invoked and whether
# COVENANT_TAB propagated. Remove once verified.
printf '%s tab=%s\n' "$(date '+%H:%M:%S')" "${COVENANT_TAB:-UNSET}" >>"$HOME/.covenant/statusline-debug.log" 2>/dev/null

if [ -n "$COVENANT_TAB" ]; then
    dir="${COVENANT_VITALS_DIR:-$HOME/.covenant/vitals}"
    mkdir -p "$dir" 2>/dev/null
    # Atomic write so Covenant never reads a half-written file.
    tmp="$dir/$COVENANT_TAB.json.tmp.$$"
    printf '%s' "$input" >"$tmp" 2>/dev/null && mv -f "$tmp" "$dir/$COVENANT_TAB.json" 2>/dev/null
fi

if [ -n "$COVENANT_ORIG_STATUSLINE" ]; then
    printf '%s' "$input" | eval "$COVENANT_ORIG_STATUSLINE"
fi

exit 0
