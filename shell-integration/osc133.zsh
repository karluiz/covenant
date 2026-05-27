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

# Suppress zsh's "partial line" indicator (the inverse `%` shown when the
# previous command's output didn't end with a newline). Covenant segments
# output into Blocks via OSC 133, so the visual marker is redundant noise
# — and appears on every fresh session because the OSC 133;A sequence
# itself counts as output without a trailing newline.
unsetopt PROMPT_SP 2>/dev/null
PROMPT_EOL_MARK=''

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
    # WezTerm/iTerm extension: emit the actual command line as the OSC
    # 133;C payload so the parser does not have to reconstruct it from
    # ZLE bytes — which breaks under zsh-autosuggestions, history-
    # substring-search, syntax-highlighting, etc. Strip control bytes
    # that would corrupt the OSC string terminator.
    local cmd="${1//[$'\e\x07\x00']/}"
    print -nr -- $'\e]133;C;'"$cmd"$'\e\\'
}

__karl_emit_osc7() {
    print -nr -- $'\e]7;file://'"${HOST:-localhost}""$PWD"$'\e\\'
}

__karl_precmd() {
    local exit=$?
    # Re-assert PROMPT_SP suppression every prompt: some frameworks
    # (p10k, oh-my-zsh option-restore, plugins using LOCAL_OPTIONS)
    # flip it back on between prompts, which brings back the inverse
    # `%` on tab reopen.
    unsetopt PROMPT_SP 2>/dev/null
    PROMPT_EOL_MARK=''
    if (( _karl_cmd_active )); then
        __karl_emit_command_done "$exit"
        _karl_cmd_active=0
    fi
    __karl_emit_prompt_start
    __karl_emit_osc7
}

__karl_preexec() {
    # zsh's preexec receives 3 args:
    #   $1 = line exactly as the user typed it (e.g. "cc help")
    #   $2 = line after history expansion
    #   $3 = line after ALL expansions including alias resolution
    #        (e.g. "claude help" if `alias cc=claude`)
    # We emit $3 so downstream consumers (Operator pattern matching,
    # block parser, executor detection) see the real command being
    # run — aliases like `cc=claude`, `oc=opencode`, `ai=aider` resolve
    # transparently. Falls back to $1 if $3 is unset (older zsh paths).
    __karl_emit_output_start "${3:-$1}"
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

# ─── zsh-autosuggestions integration ──────────────────────────────────
#
# Inline ghost-text autocomplete (https://github.com/zsh-users/zsh-autosuggestions).
# Covenant doesn't bundle it — too many install conventions to manage —
# but we probe the common paths and source the first hit so the user
# gets fish-like as-you-type completion in Covenant tabs without any
# manual config. If their .zshrc already loaded it (oh-my-zsh, sheldon,
# antidote, manual), this no-ops because the plugin sets a guard.
#
# Tuning rationale:
#   - STRATEGY=(history completion): try shell history first, then fall
#     back to zsh's completion system. Skip the `match_prev_cmd` strategy
#     — it's slow on big histories and we have Recall for that anyway.
#   - BUFFER_MAX_SIZE=20: don't suggest for huge pasted lines.
#   - HIGHLIGHT_STYLE: dim cyan, plays nice with our covenant-cyan
#     accent without competing with the user's actual prompt colors.
__karl_load_autosuggestions() {
    # Already loaded by the user's own config — leave it alone.
    if (( ${+ZSH_AUTOSUGGEST_VERSION} )); then
        export _COVENANT_AUTOSUGGEST=user
        return 0
    fi

    local candidates=(
        # Homebrew (Apple Silicon)
        /opt/homebrew/share/zsh-autosuggestions/zsh-autosuggestions.zsh
        # Homebrew (Intel)
        /usr/local/share/zsh-autosuggestions/zsh-autosuggestions.zsh
        # oh-my-zsh custom plugin layout
        "${ZSH_CUSTOM:-$HOME/.oh-my-zsh/custom}/plugins/zsh-autosuggestions/zsh-autosuggestions.zsh"
        # oh-my-zsh bundled plugin layout (some installs)
        "${ZSH:-$HOME/.oh-my-zsh}/plugins/zsh-autosuggestions/zsh-autosuggestions.zsh"
        # antidote / antibody / sheldon manual clone
        "$HOME/.zsh/plugins/zsh-autosuggestions/zsh-autosuggestions.zsh"
        "$HOME/.local/share/zsh-autosuggestions/zsh-autosuggestions.zsh"
        # Linux distros
        /usr/share/zsh-autosuggestions/zsh-autosuggestions.zsh
        /usr/share/zsh/plugins/zsh-autosuggestions/zsh-autosuggestions.zsh
    )

    local p
    for p in $candidates; do
        if [[ -r "$p" ]]; then
            # Defaults BEFORE source so the plugin picks them up.
            : ${ZSH_AUTOSUGGEST_STRATEGY:='history completion'}
            : ${ZSH_AUTOSUGGEST_BUFFER_MAX_SIZE:=20}
            : ${ZSH_AUTOSUGGEST_HIGHLIGHT_STYLE:='fg=#5c7080'}
            source "$p"
            export _COVENANT_AUTOSUGGEST=loaded:$p
            return 0
        fi
    done

    export _COVENANT_AUTOSUGGEST=missing
    return 1
}

__karl_load_autosuggestions
