use std::path::{Path, PathBuf};

use thiserror::Error;

#[derive(Debug, Error)]
pub enum ShellError {
    #[error("no supported shell found on this platform")]
    NotFound,
    #[error("unsupported shell: {0}")]
    Unsupported(String),
}

#[derive(Debug, Clone)]
pub enum ShellKind {
    #[cfg(unix)]
    Zsh { program: PathBuf },
    #[cfg(unix)]
    Bash { program: PathBuf },
    #[cfg(windows)]
    PowerShell { program: PathBuf, pwsh: bool },
    #[cfg(windows)]
    Cmd { program: PathBuf },
}

impl ShellKind {
    pub fn program(&self) -> &Path {
        match self {
            #[cfg(unix)]
            ShellKind::Zsh { program } => program,
            #[cfg(unix)]
            ShellKind::Bash { program } => program,
            #[cfg(windows)]
            ShellKind::PowerShell { program, .. } => program,
            #[cfg(windows)]
            ShellKind::Cmd { program } => program,
        }
    }

    pub fn default_for_platform() -> Result<Self, ShellError> {
        #[cfg(unix)]
        {
            if let Ok(shell) = std::env::var("SHELL") {
                let p = PathBuf::from(&shell);
                if p.exists() {
                    return Ok(shell_kind_for_unix_path(p));
                }
            }
            let zsh = PathBuf::from("/bin/zsh");
            if zsh.exists() {
                return Ok(ShellKind::Zsh { program: zsh });
            }
            let bash = PathBuf::from("/bin/bash");
            if bash.exists() {
                return Ok(ShellKind::Bash { program: bash });
            }
            Err(ShellError::NotFound)
        }
        #[cfg(windows)]
        {
            // Prefer PowerShell 7 (best OSC 133 story), fall back to the
            // Windows PowerShell 5.1 that ships with the OS, then cmd.exe.
            // A terminal that can't open any shell is broken; block-parsing
            // fidelity is secondary to actually starting. (CLAUDE.md M8)
            if let Some(p) = which_on_path("pwsh.exe") {
                return Ok(ShellKind::PowerShell {
                    program: p,
                    pwsh: true,
                });
            }
            if let Some(p) = which_on_path("powershell.exe") {
                return Ok(ShellKind::PowerShell {
                    program: p,
                    pwsh: false,
                });
            }
            if let Some(p) = which_on_path("cmd.exe") {
                return Ok(ShellKind::Cmd { program: p });
            }
            Err(ShellError::NotFound)
        }
    }

    pub fn resolve_explicit(name: &str) -> Result<Self, ShellError> {
        #[cfg(unix)]
        {
            let p = PathBuf::from(name);
            if !p.exists() {
                return Err(ShellError::NotFound);
            }
            Ok(shell_kind_for_unix_path(p))
        }
        #[cfg(windows)]
        {
            let lower = name.to_lowercase();
            if lower == "pwsh.exe" || lower == "pwsh" {
                return which_on_path("pwsh.exe")
                    .map(|p| ShellKind::PowerShell {
                        program: p,
                        pwsh: true,
                    })
                    .ok_or(ShellError::NotFound);
            }
            if lower == "powershell.exe" || lower == "powershell" {
                return which_on_path("powershell.exe")
                    .map(|p| ShellKind::PowerShell {
                        program: p,
                        pwsh: false,
                    })
                    .ok_or(ShellError::NotFound);
            }
            if lower == "cmd.exe" || lower == "cmd" {
                return which_on_path("cmd.exe")
                    .map(|p| ShellKind::Cmd { program: p })
                    .ok_or(ShellError::NotFound);
            }
            Err(ShellError::Unsupported(name.to_string()))
        }
    }
}

#[cfg(unix)]
fn shell_kind_for_unix_path(p: PathBuf) -> ShellKind {
    let name = p.file_name().and_then(|f| f.to_str()).unwrap_or("");
    if name.contains("zsh") {
        ShellKind::Zsh { program: p }
    } else {
        ShellKind::Bash { program: p }
    }
}

#[cfg(windows)]
fn which_on_path(exe: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        let candidate = dir.join(exe);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_shell_resolves_on_current_platform() {
        let kind = ShellKind::default_for_platform().expect("should find a shell");
        assert!(
            kind.program().exists(),
            "resolved shell binary does not exist: {:?}",
            kind.program()
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_resolves_cmd_exe_as_fallback() {
        // cmd.exe always exists on Windows; it must resolve (not error) so
        // the terminal can start even without pwsh/powershell on PATH.
        let result = ShellKind::resolve_explicit("cmd.exe");
        assert!(
            matches!(result, Ok(ShellKind::Cmd { .. })),
            "expected Cmd, got: {result:?}"
        );
    }
}
