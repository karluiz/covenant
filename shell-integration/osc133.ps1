# OSC 133 + OSC 7 shell integration for Covenant Terminal (PowerShell 7+).
#
# Emits the same prompt/command/exit markers as osc133.zsh so the karl-blocks
# parser segments pwsh streams identically. Source from your $PROFILE *after*
# any prompt framework (oh-my-posh, starship) so our PS1 wrapping survives:
#
#     oh-my-posh init pwsh | Invoke-Expression
#     . "$HOME\.covenant\osc133.ps1"
#
# Reference:
#   https://wezfurlong.org/wezterm/shell-integration.html

if ($Global:_CovenantOsc133Loaded) { return }
$Global:_CovenantOsc133Loaded = $true

# Force UTF-8 so OSC payloads (and command output in general) survive the PTY.
try { [Console]::OutputEncoding = [Text.UTF8Encoding]::new() } catch {}
try { $OutputEncoding = [Text.UTF8Encoding]::new() } catch {}

$ESC = [char]27
$ST  = "$ESC\"  # ST = ESC \

function global:__Covenant-EmitOsc7 {
    $cwd = (Get-Location).Path -replace '\\','/'
    [Console]::Write("$ESC]7;file://$env:COMPUTERNAME/$cwd$ST")
}

# Wrap the user's existing `prompt` function so we keep their PS1 chrome and
# only sandwich our markers around it.
$prevPrompt = (Get-Item function:prompt -ErrorAction SilentlyContinue)
$Global:_CovenantPrevPrompt = if ($prevPrompt) { $prevPrompt.ScriptBlock } else { { "PS $($executionContext.SessionState.Path.CurrentLocation)> " } }

function global:prompt {
    $exit = $LASTEXITCODE
    if ($null -ne $Global:_CovenantLastCmd) {
        [Console]::Write("$ESC]133;D;$exit$ST")
        $Global:_CovenantLastCmd = $null
    }
    [Console]::Write("$ESC]133;A$ST")
    __Covenant-EmitOsc7
    $rendered = & $Global:_CovenantPrevPrompt
    "$rendered$ESC]133;B$ST"
}

# Hook command submission via PSReadLine to emit OSC 133;C with the command
# text. AcceptLine is the canonical Enter handler.
if (Get-Module -ListAvailable PSReadLine) {
    Import-Module PSReadLine -ErrorAction SilentlyContinue
    Set-PSReadLineKeyHandler -Key Enter -ScriptBlock {
        param($key, $arg)
        $line = $null; $cursor = $null
        [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$line, [ref]$cursor)
        $clean = ($line -replace "[\x00\x07\x1b]", '')
        [Console]::Write("$ESC]133;C;$clean$ST")
        $Global:_CovenantLastCmd = $clean
        [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine()
    }
}
