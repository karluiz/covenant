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

# ── Worktree prompt compaction ───────────────────────────────────────
# Inside `<repo>/.covenant/worktrees/<slug>`, trim the `\w` prompt path
# to its last 2 components (`.../worktrees/<slug>`) via bash-native
# PROMPT_DIRTRIM; restore the user's prior value everywhere else.
# Display-only. Gated on COVENANT_COMPACT_WORKTREE (Settings → Terminal).
if [ -n "${COVENANT_COMPACT_WORKTREE:-}" ]; then
    __karl_dirtrim() {
        case "$PWD" in
            */.covenant/worktrees/*)
                # Save the caller's value once, on entry into a worktree.
                if [ "${_karl_dirtrim_saved+x}" != x ]; then
                    _karl_dirtrim_saved="${PROMPT_DIRTRIM-__karl_unset__}"
                fi
                PROMPT_DIRTRIM=2
                ;;
            *)
                # Restore once, on exit from a worktree. Leave an
                # interactively-set PROMPT_DIRTRIM alone otherwise —
                # we only ever touched it during a worktree stay.
                if [ "${_karl_dirtrim_saved+x}" = x ]; then
                    if [ "$_karl_dirtrim_saved" = "__karl_unset__" ]; then
                        unset PROMPT_DIRTRIM
                    else
                        PROMPT_DIRTRIM="$_karl_dirtrim_saved"
                    fi
                    unset _karl_dirtrim_saved
                fi
                ;;
        esac
    }
    case "$PROMPT_COMMAND" in
        *__karl_dirtrim*) ;;
        *) PROMPT_COMMAND="${PROMPT_COMMAND:+$PROMPT_COMMAND$'\n'}__karl_dirtrim" ;;
    esac
fi

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
