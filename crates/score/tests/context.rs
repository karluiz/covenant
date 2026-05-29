use karl_score::context::ContextResolver;
use std::process::Command;

fn tmp_git_repo(branch: &str) -> tempfile::TempDir {
    let d = tempfile::tempdir().unwrap();
    let p = d.path();
    let r = |args: &[&str]| {
        Command::new("git")
            .current_dir(p)
            .args(args)
            .output()
            .unwrap();
    };
    r(&["init", "-q", "-b", branch]);
    r(&["config", "user.email", "t@t"]);
    r(&["config", "user.name", "t"]);
    r(&["commit", "--allow-empty", "-m", "init", "-q"]);
    d
}

#[test]
fn resolves_repo_basename_and_branch() {
    let d = tmp_git_repo("notch");
    let resolver = ContextResolver::new();
    let ctx = resolver.resolve("sess-1", d.path(), Some("main".into()), Some("ws-x".into()));
    assert_eq!(
        ctx.repo.as_deref(),
        Some(d.path().file_name().unwrap().to_str().unwrap())
    );
    assert_eq!(ctx.branch.as_deref(), Some("notch"));
    assert_eq!(ctx.group_name.as_deref(), Some("main"));
    assert_eq!(ctx.workspace.as_deref(), Some("ws-x"));
}

#[test]
fn returns_none_outside_git_repo() {
    let d = tempfile::tempdir().unwrap();
    let resolver = ContextResolver::new();
    let ctx = resolver.resolve("sess-2", d.path(), None, None);
    assert!(ctx.repo.is_none() && ctx.branch.is_none());
}

#[test]
fn caches_within_ttl() {
    let d = tmp_git_repo("main");
    let resolver = ContextResolver::new();
    let _ = resolver.resolve("sess-3", d.path(), None, None);
    // Rename branch externally; cached value should still return "main"
    Command::new("git")
        .current_dir(d.path())
        .args(["branch", "-M", "renamed"])
        .output()
        .unwrap();
    let ctx = resolver.resolve("sess-3", d.path(), None, None);
    assert_eq!(ctx.branch.as_deref(), Some("main"));
}

#[test]
fn detached_head_reports_sha7() {
    let d = tmp_git_repo("main");
    Command::new("git")
        .current_dir(d.path())
        .args(["checkout", "--detach", "HEAD"])
        .output()
        .unwrap();
    let resolver = ContextResolver::new();
    let ctx = resolver.resolve("sess-4", d.path(), None, None);
    assert!(ctx.branch.as_deref().unwrap().starts_with("detached:"));
}
