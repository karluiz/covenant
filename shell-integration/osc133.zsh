# OSC 133 shell integration for karl-terminal (zsh).
#
# Source this file from ~/.zshrc to emit the prompt/command/exit markers
# karl-terminal's block parser depends on. Reference:
#   https://wezfurlong.org/wezterm/shell-integration.html
#   https://gitlab.freedesktop.org/Per_Bothner/specifications/blob/master/proposals/semantic-prompts.md
#
# TODO(M1): land a hardened version that also emits OSC 7 (cwd) and
# survives prompt themes (Powerlevel10k, Starship, etc.) by composing with
# precmd_functions / preexec_functions instead of overwriting PROMPT.
