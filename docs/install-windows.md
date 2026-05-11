# Installing Covenant on Windows

> v0.3.0 — unsigned build. SmartScreen will warn on first launch; click "More info → Run anyway".

## Requirements

- Windows 10 (build 1809+) or Windows 11
- [PowerShell 7+](https://learn.microsoft.com/powershell/scripting/install/installing-powershell-on-windows) (`pwsh`)
- WebView2 Runtime — bundled installer fetches it automatically if missing

## Install

1. Download `Covenant_0.3.0_x64_en-US.msi` from the latest [GitHub Release](https://github.com/karluiz/karlTerminal/releases/latest).
2. Run the MSI. SmartScreen → "More info" → "Run anyway".
3. Launch Covenant from the Start menu.

## Enable shell integration (required for blocks)

Open a Covenant tab and run:

```powershell
mkdir $HOME\.covenant -Force
Copy-Item "$env:LOCALAPPDATA\Programs\Covenant\shell-integration\osc133.ps1" $HOME\.covenant\
Add-Content $PROFILE '. "$HOME\.covenant\osc133.ps1"'
. $PROFILE
```

Reload the tab. You should see commands appear as discrete blocks in the sidebar.

## Known limitations (v0.3.0)

- Build is **unsigned** — SmartScreen warning is expected
- Windows PowerShell 5.1, `cmd.exe`, and WSL not supported (use `pwsh`)
- No auto-updater — re-download to upgrade
