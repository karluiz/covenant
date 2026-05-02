# OSC 133 + OSC 7 shell integration for karl-terminal (fish).
#
# Source from your config.fish AFTER any prompt customization:
#
#     starship init fish | source
#     source /path/to/shell-integration/osc133.fish

status is-interactive; or exit 0
set -q _KARL_OSC133_LOADED; and exit 0
set -g _KARL_OSC133_LOADED 1

set -g _karl_cmd_active 0

function __karl_precmd --on-event fish_prompt
    set -l exit $status
    if test "$_karl_cmd_active" = "1"
        printf '\e]133;D;%s\e\\' $exit
        set -g _karl_cmd_active 0
    end
    printf '\e]133;A\e\\'
    printf '\e]7;file://%s%s\e\\' (hostname) "$PWD"
end

function __karl_preexec --on-event fish_preexec
    printf '\e]133;C\e\\'
    set -g _karl_cmd_active 1
end

# Wrap fish_prompt so 133;B is emitted at the end of every prompt render.
if functions -q fish_prompt
    functions -e __karl_orig_fish_prompt 2>/dev/null
    functions -c fish_prompt __karl_orig_fish_prompt
    function fish_prompt
        __karl_orig_fish_prompt
        printf '\e]133;B\e\\'
    end
end
