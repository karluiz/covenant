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
            if let Some(p) = which_on_path("pwsh.exe") {
                return Ok(ShellKind::PowerShell { program: p, pwsh: true });
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
            if lower == "cmd.exe" || lower == "cmd" {
                return Err(ShellError::Unsupported(name.to_string()));
            }
            if lower == "powershell.exe" || lower == "powershell" {
                return Err(ShellError::Unsupported(
                    "powershell.exe (5.1) is not supported; use pwsh.exe".to_string(),
                ));
            }
            if lower == "pwsh.exe" || lower == "pwsh" {
                if let Some(p) = which_on_path("pwsh.exe") {
                    return Ok(ShellKind::PowerShell { program: p, pwsh: true });
                }
                return Err(ShellError::NotFound);
            }
            Err(ShellError::Unsupported(name.to_string()))
        }
    }
}

#[cfg(unix)]
fn shell_kind_for_unix_path(p: PathBuf) -> ShellKind {
    let name = p
        .file_name()
        .and_then(|f| f.to_str())
        .unwrap_or("");
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
    fn windows_rejects_cmd_exe() {
        let result = ShellKind::resolve_explicit("cmd.exe");
        assert!(
            matches!(result, Err(ShellError::Unsupported(_))),
            "expected Unsupported, got: {result:?}"
        );
    }
}
