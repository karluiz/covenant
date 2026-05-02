# OSC 133 + OSC 7 shell integration for karl-terminal (zsh).
#
# Emits the prompt / command / exit markers karl-blocks parses to segment
# the byte stream into Blocks. Composes with Starship, Powerlevel10k, and
# anything else that drives PROMPT via precmd_functions, but only if this
# file is sourced AFTER the prompt framework's init in your ~/.zshrc:
#
#     eval "$(starship init zsh)"
#     source /path/to/shell-integration/osc133.zsh
#
# Reference:
#   https://wezfurlong.org/wezterm/shell-integration.html
#   https://gitlab.freedesktop.org/Per_Bothner/specifications/blob/master/proposals/semantic-prompts.md

[[ -n "${ZSH_VERSION:-}" ]] || return 0
[[ -n "${_KARL_OSC133_LOADED:-}" ]] && return 0
_KARL_OSC133_LOADED=1

# Tracks whether a `preexec` has fired without a matching `D` yet, so the
# very first prompt — before any user command has run — does not emit a
# spurious `D ; 0` based on the shell's own initialization $?.
_karl_cmd_active=0

__karl_emit_prompt_start() {
    print -nr -- $'\e]133;A\e\\'
}

__karl_emit_command_done() {
    print -nr -- $'\e]133;D;'"$1"$'\e\\'
}

__karl_emit_output_start() {
    print -nr -- $'\e]133;C\e\\'
}

__karl_emit_osc7() {
    print -nr -- $'\e]7;file://'"${HOST:-localhost}""$PWD"$'\e\\'
}

__karl_precmd() {
    local exit=$?
    if (( _karl_cmd_active )); then
        __karl_emit_command_done "$exit"
        _karl_cmd_active=0
    fi
    __karl_emit_prompt_start
    __karl_emit_osc7
}

__karl_preexec() {
    __karl_emit_output_start
    _karl_cmd_active=1
}

# Append `133;B` (prompt end / command start) to PS1 every precmd, AFTER
# any other precmd_function (e.g. starship_precmd) has rebuilt PROMPT.
# `%{...%}` keeps zsh's prompt-width math correct.
__karl_inject_b() {
    if [[ "$PS1" != *$'\e]133;B'* ]]; then
        PS1="${PS1}%{"$'\e]133;B\e\\'"%}"
    fi
}

typeset -ag precmd_functions preexec_functions

# Drop any prior __karl_* entries so re-sourcing is idempotent, then
# splice ours: __karl_precmd FIRST (so D-for-previous fires before any
# Starship-style PS1 rebuild), __karl_inject_b LAST (so the B marker
# survives whatever the framework wrote to PS1).
precmd_functions=(${precmd_functions:#__karl_*})
precmd_functions=(__karl_precmd $precmd_functions __karl_inject_b)

preexec_functions=(${preexec_functions:#__karl_preexec})
preexec_functions+=(__karl_preexec)
