# OSC 133 + OSC 7 shell integration for karl-terminal (bash 4.4+).
#
# Source AFTER any prompt framework (starship init bash, etc.) so our
# precmd runs alongside theirs:
#
#     eval "$(starship init bash)"
#     source /path/to/shell-integration/osc133.bash

[ -n "${BASH_VERSION:-}" ] || return 0
[ -n "${_KARL_OSC133_LOADED:-}" ] && return 0
_KARL_OSC133_LOADED=1

_karl_cmd_active=0

__karl_precmd() {
    local exit=$?
    if [ "$_karl_cmd_active" = "1" ]; then
        printf '\e]133;D;%s\e\\' "$exit"
        _karl_cmd_active=0
    fi
    printf '\e]133;A\e\\'
    printf '\e]7;file://%s%s\e\\' "${HOSTNAME:-localhost}" "$PWD"
}

__karl_preexec() {
    # The DEBUG trap fires for every simple command including the
    # PROMPT_COMMAND chain itself; suppress those so we only emit C
    # for actual user commands.
    [ "$BASH_COMMAND" = "$PROMPT_COMMAND" ] && return
    [ "${COMP_LINE+x}" = "x" ] && return
    case "$BASH_COMMAND" in
        __karl_*) return ;;
    esac
    # Carry the command line as the OSC 133;C payload (parser prefers
    # this over byte capture). BASH_COMMAND is the simple command, which
    # is good enough for the sidebar.
    local cmd="${BASH_COMMAND//[$'\e\x07\x00']/}"
    printf '\e]133;C;%s\e\\' "$cmd"
    _karl_cmd_active=1
}

trap '__karl_preexec' DEBUG

# Inject `133;B` (prompt end) into PS1 using \[ \] for zero-width.
case "$PS1" in
    *'\[\e]133;B'*) ;;
    *) PS1="${PS1}\\[\\e]133;B\\e\\\\\\]" ;;
esac

# Prepend our precmd to PROMPT_COMMAND.
case "$PROMPT_COMMAND" in
    *__karl_precmd*) ;;
    *) PROMPT_COMMAND="__karl_precmd${PROMPT_COMMAND:+; $PROMPT_COMMAND}" ;;
esac

# ── Covenant theme sync ──────────────────────────────────────────────
# Launch Claude Code matching Covenant's appearance. Covenant exports
# COVENANT_CLAUDE_THEME (e.g. `dark-daltonized`) into this shell's env at
# spawn; we forward it via `--settings` unless the caller already pinned a
# theme. `command claude` avoids recursing into this function.
claude() {
    if [[ -n "${COVENANT_CLAUDE_THEME:-}" && "$*" != *--settings* && "$*" != *--theme* ]]; then
        if [[ -n "${COVENANT_TAB:-}" ]]; then
            command claude --settings "{\"theme\":\"${COVENANT_CLAUDE_THEME}\",\"statusLine\":{\"type\":\"command\",\"command\":\"sh ${HOME}/.covenant/covenant-statusline.sh\",\"padding\":0}}" "$@"
        else
            command claude --settings "{\"theme\":\"${COVENANT_CLAUDE_THEME}\"}" "$@"
        fi
    else
        command claude "$@"
    fi
}
