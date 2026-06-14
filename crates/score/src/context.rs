use crate::types::Context;
use std::collections::HashMap;
use std::path::Path;
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const TTL: Duration = Duration::from_secs(5);

struct Entry {
    ctx: Context,
    at: Instant,
}

pub struct ContextResolver {
    cache: Mutex<HashMap<String, Entry>>,
}

impl ContextResolver {
    pub fn new() -> Self {
        Self {
            cache: Mutex::new(HashMap::new()),
        }
    }

    pub fn resolve(
        &self,
        session_id: &str,
        cwd: &Path,
        group_name: Option<String>,
        workspace: Option<String>,
    ) -> Context {
        if let Ok(g) = self.cache.lock() {
            if let Some(e) = g.get(session_id) {
                if e.at.elapsed() < TTL {
                    let mut c = e.ctx.clone();
                    if group_name.is_some() {
                        c.group_name = group_name.clone();
                    }
                    if workspace.is_some() {
                        c.workspace = workspace.clone();
                    }
                    return c;
                }
            }
        }
        let ctx = Self::compute(cwd, group_name, workspace);
        if let Ok(mut g) = self.cache.lock() {
            g.insert(
                session_id.to_string(),
                Entry {
                    ctx: ctx.clone(),
                    at: Instant::now(),
                },
            );
        }
        ctx
    }

    fn compute(cwd: &Path, group_name: Option<String>, workspace: Option<String>) -> Context {
        let toplevel = Self::git(cwd, &["rev-parse", "--show-toplevel"]);
        if let Some(t) = toplevel.as_deref() {
            crate::register_toplevel(Path::new(t));
        }
        let repo = toplevel
            .as_deref()
            .and_then(|p| Path::new(p).file_name().and_then(|n| n.to_str()))
            .map(String::from);
        let branch = if repo.is_some() {
            let b = Self::git(cwd, &["branch", "--show-current"]).unwrap_or_default();
            if b.is_empty() {
                let sha = Self::git(cwd, &["rev-parse", "--short=7", "HEAD"]).unwrap_or_default();
                if sha.is_empty() {
                    None
                } else {
                    Some(format!("detached:{sha}"))
                }
            } else {
                Some(b)
            }
        } else {
            None
        };
        Context {
            repo,
            branch,
            group_name,
            workspace,
        }
    }

    fn git(cwd: &Path, args: &[&str]) -> Option<String> {
        let out = Command::new("git")
            .current_dir(cwd)
            .args(args)
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if s.is_empty() {
            None
        } else {
            Some(s)
        }
    }
}

/// Resolve the git toplevel for an arbitrary cwd. None outside a repo.
pub(crate) fn toplevel_for_cwd(cwd: &Path) -> Option<std::path::PathBuf> {
    ContextResolver::git(cwd, &["rev-parse", "--show-toplevel"]).map(std::path::PathBuf::from)
}

/// Resolve the repo name (git toplevel basename) for a cwd learned from a
/// transcript line rather than a live session. Same naming as prompt events.
pub fn repo_name_for_cwd(cwd: &Path) -> Option<String> {
    let toplevel = toplevel_for_cwd(cwd)?;
    toplevel
        .file_name()
        .and_then(|n| n.to_str())
        .map(String::from)
}

impl Default for ContextResolver {
    fn default() -> Self {
        Self::new()
    }
}
