//! Canon eval format + results store (Plan A of the eval runner).
//!
//! Evals are per-unit `.toml` files under
//! `.covenant/canon/evals/<kind>/<name>/*.toml`, one tree shared by every
//! evaluable kind. Each is a behavior test: a `scenario` fed to a real
//! executor and a `rubric` the judge applies to the transcript. Results are
//! stored in `.covenant/canon/eval-results.json`, keyed by `"<kind>/<name>"`.

use crate::kind::ContextKind;
use crate::manifest::canon_dir;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Eval {
    pub id: String,
    pub scenario: String,
    pub rubric: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EvalResult {
    pub eval_id: String,
    pub pass: bool,
    pub reason: String,
    pub ran_at_ms: i64,
    pub duration_ms: u64,
    #[serde(default)]
    pub baseline_pass: Option<bool>,
}

/// `.covenant/canon/evals/<kind>/<name>/` — one tree for every evaluable kind,
/// so the path and the results key are the same string.
fn evals_dir(repo_root: &Path, kind: ContextKind, name: &str) -> std::path::PathBuf {
    canon_dir(repo_root)
        .join("evals")
        .join(kind.slug())
        .join(name)
}

/// The `eval-results.json` key for a unit: `"command/horizon"`.
pub fn unit_key(kind: ContextKind, name: &str) -> String {
    format!("{}/{}", kind.slug(), name)
}

/// Scan `.covenant/canon/evals/<kind>/<name>/*.toml`, sorted by id.
/// Unparseable or non-toml files are skipped (warned), never fatal.
pub fn read_evals(repo_root: &Path, kind: ContextKind, name: &str) -> Vec<Eval> {
    let dir = evals_dir(repo_root, kind, name);
    let mut out = Vec::new();
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return out, // no evals dir → no evals
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("toml") {
            continue;
        }
        match std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| toml::from_str::<Eval>(&s).ok())
        {
            Some(ev) => out.push(ev),
            None => {
                tracing::warn!(target: "canon", path = %path.display(), "skipping unparseable eval")
            }
        }
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

fn results_path(repo_root: &Path) -> std::path::PathBuf {
    canon_dir(repo_root).join("eval-results.json")
}

type ResultMap = BTreeMap<String, BTreeMap<String, EvalResult>>;

/// Load all stored results (skill → eval_id → result). Empty on missing/corrupt.
pub fn read_results(repo_root: &Path) -> ResultMap {
    std::fs::read_to_string(results_path(repo_root))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Process-global lock: serialises concurrent `write_result` calls so two
/// simultaneous "Run evals" can't clobber each other's data.
static WRITE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Upsert one result and persist atomically. Creates `.covenant/canon/` if needed.
///
/// Concurrent safety: all writes are serialised behind `WRITE_LOCK`.
/// Corrupt-file safety: if the results file exists, is non-empty, but fails
/// JSON parsing it is renamed to `eval-results.corrupt.json` (best-effort)
/// and a fresh map is started — the old bytes are preserved for inspection.
/// Write atomicity: serialised to `eval-results.json.tmp` then renamed over
/// the target so a partial write can never leave the file in a corrupt state.
pub fn write_result(
    repo_root: &Path,
    kind: ContextKind,
    name: &str,
    result: &EvalResult,
) -> std::io::Result<()> {
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());

    let path = results_path(repo_root);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    // Read current results; handle a corrupt-but-present file by backing it up.
    let mut all: ResultMap = BTreeMap::new();
    if path.exists() {
        match std::fs::read_to_string(&path) {
            Ok(s) if !s.trim().is_empty() => match serde_json::from_str::<ResultMap>(&s) {
                Ok(m) => all = m,
                Err(_) => {
                    let backup = path.with_extension("corrupt.json");
                    tracing::warn!(
                        target: "canon",
                        "eval-results.json is corrupt; backing up to {}",
                        backup.display()
                    );
                    let _ = std::fs::rename(&path, &backup); // best-effort; proceed from empty
                }
            },
            _ => {} // missing or empty → start fresh
        }
    }

    all.entry(unit_key(kind, name))
        .or_default()
        .insert(result.eval_id.clone(), result.clone());

    let json = serde_json::to_string_pretty(&all)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;

    // Atomic write: write to a sibling .tmp then rename over the target.
    // On rename failure, best-effort remove the .tmp so it does not linger.
    let tmp_path = path.with_extension("json.tmp");
    std::fs::write(&tmp_path, &json)?;
    std::fs::rename(&tmp_path, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp_path);
        e
    })
}

/// Write one eval as `<id>.toml` under the unit's evals dir. Refuses to
/// overwrite an existing file so a re-draft never clobbers a hand-tuned eval.
pub fn write_eval(
    repo_root: &Path,
    kind: ContextKind,
    name: &str,
    eval: &Eval,
) -> std::io::Result<std::path::PathBuf> {
    let dir = evals_dir(repo_root, kind, name);
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(format!("{}.toml", eval.id));
    if path.exists() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            format!("{} already exists", path.display()),
        ));
    }
    let body = toml::to_string_pretty(eval)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string()))?;
    std::fs::write(&path, body)?;
    Ok(path)
}

/// `(passed, total)` over stored results for a unit; `None` if none yet.
pub fn pass_rate(repo_root: &Path, kind: ContextKind, name: &str) -> Option<(usize, usize)> {
    let all = read_results(repo_root);
    let inner = lookup(&all, kind, name)?;
    if inner.is_empty() {
        return None;
    }
    let passed = inner.values().filter(|r| r.pass).count();
    Some((passed, inner.len()))
}

/// Find a unit's results, tolerating one legacy shape.
///
/// ponytail: the bare-key fallback exists only for `eval-results.json` written
/// by a build that predates kind-keying. Delete it once no such file can still
/// be in the wild — there were none on the authoring machine when this landed.
fn lookup<'a>(
    all: &'a ResultMap,
    kind: ContextKind,
    name: &str,
) -> Option<&'a BTreeMap<String, EvalResult>> {
    all.get(&unit_key(kind, name)).or_else(|| {
        (kind == ContextKind::Skill)
            .then(|| all.get(name))
            .flatten()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write_eval(dir: &std::path::Path, file: &str, body: &str) {
        fs::create_dir_all(dir).unwrap();
        fs::write(dir.join(file), body).unwrap();
    }

    #[test]
    fn reads_and_sorts_evals_for_a_skill() {
        let tmp = tempfile::tempdir().unwrap();
        let evals_dir = tmp.path().join(".covenant/canon/evals/skill/kyc-peru");
        write_eval(
            &evals_dir,
            "b.toml",
            "id = \"two\"\nscenario = \"S2\"\nrubric = \"R2\"\n",
        );
        write_eval(
            &evals_dir,
            "a.toml",
            "id = \"one\"\nscenario = \"S1\"\nrubric = \"R1\"\n",
        );
        // A non-toml file and a malformed toml are ignored.
        write_eval(&evals_dir, "notes.md", "not an eval");
        write_eval(&evals_dir, "bad.toml", "id = ");

        let evals = read_evals(tmp.path(), ContextKind::Skill, "kyc-peru");
        assert_eq!(
            evals.len(),
            2,
            "two valid evals, malformed/non-toml skipped"
        );
        assert_eq!(evals[0].id, "one", "sorted by id");
        assert_eq!(evals[1].scenario, "S2");
    }

    #[test]
    fn no_evals_dir_returns_empty() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(read_evals(tmp.path(), ContextKind::Skill, "missing").is_empty());
    }

    #[test]
    fn write_result_roundtrips_and_pass_rate() {
        let tmp = tempfile::tempdir().unwrap();
        let mk = |id: &str, pass: bool| EvalResult {
            eval_id: id.into(),
            pass,
            reason: "because".into(),
            ran_at_ms: 1,
            duration_ms: 10,
            baseline_pass: None,
        };
        write_result(tmp.path(), ContextKind::Skill, "kyc-peru", &mk("e1", true)).unwrap();
        write_result(tmp.path(), ContextKind::Skill, "kyc-peru", &mk("e2", false)).unwrap();
        // Re-running an eval overwrites its prior result.
        write_result(tmp.path(), ContextKind::Skill, "kyc-peru", &mk("e2", true)).unwrap();

        assert_eq!(
            pass_rate(tmp.path(), ContextKind::Skill, "kyc-peru"),
            Some((2, 2))
        );
        assert_eq!(pass_rate(tmp.path(), ContextKind::Skill, "other"), None);
        let all = read_results(tmp.path());
        assert_eq!(all["skill/kyc-peru"]["e2"].pass, true, "latest run wins");
    }

    #[test]
    fn write_result_preserves_other_skills() {
        let tmp = tempfile::tempdir().unwrap();
        let mk = |id: &str, pass: bool| EvalResult {
            eval_id: id.into(),
            pass,
            reason: "r".into(),
            ran_at_ms: 1,
            duration_ms: 1,
            baseline_pass: None,
        };
        write_result(tmp.path(), ContextKind::Skill, "skill-a", &mk("e1", true)).unwrap();
        write_result(tmp.path(), ContextKind::Skill, "skill-b", &mk("e1", false)).unwrap();
        let all = read_results(tmp.path());
        assert!(
            all.contains_key("skill/skill-a") && all.contains_key("skill/skill-b"),
            "both skills survive interleaved writes"
        );
    }

    #[test]
    fn eval_result_baseline_pass_defaults_to_none_and_roundtrips() {
        // Old JSON without the field → None.
        let old = r#"{"eval_id":"e1","pass":true,"reason":"ok","ran_at_ms":1,"duration_ms":2}"#;
        let r: EvalResult = serde_json::from_str(old).unwrap();
        assert_eq!(r.baseline_pass, None);

        // New value round-trips.
        let mut r2 = r.clone();
        r2.baseline_pass = Some(false);
        let s = serde_json::to_string(&r2).unwrap();
        let back: EvalResult = serde_json::from_str(&s).unwrap();
        assert_eq!(back.baseline_pass, Some(false));
    }

    #[test]
    fn slug_is_lowercase_singular_and_evaluable_excludes_mcp_and_spec() {
        use crate::ContextKind::*;
        assert_eq!(Skill.slug(), "skill");
        assert_eq!(Command.slug(), "command");
        assert_eq!(Agent.slug(), "agent");
        assert_eq!(Context.slug(), "context");
        assert_eq!(Memory.slug(), "memory");
        // dir() is plural and special-cases Spec — slug() must not inherit that.
        assert_eq!(Spec.slug(), "spec");
        assert_eq!(Spec.dir(), "docs/specs");

        for k in [Skill, Command, Agent, Context, Memory] {
            assert!(k.evaluable(), "{k:?} must be evaluable");
        }
        assert!(
            !Mcp.evaluable(),
            "an MCP server is a connection, not context"
        );
        assert!(!Spec.evaluable(), "specs are never projected");
    }

    #[test]
    fn write_eval_round_trips_and_refuses_overwrite() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let ev = Eval {
            id: "refuses-a-dirty-tree".into(),
            scenario: "s".into(),
            rubric: "r".into(),
        };
        let path = super::write_eval(root, crate::ContextKind::Skill, "horizon", &ev).unwrap();
        assert!(path.ends_with(".covenant/canon/evals/skill/horizon/refuses-a-dirty-tree.toml"));

        let read = read_evals(root, crate::ContextKind::Skill, "horizon");
        assert_eq!(read, vec![ev.clone()], "written eval must parse back");

        // A hand-tuned eval must never be clobbered by a re-draft.
        let err = super::write_eval(root, crate::ContextKind::Skill, "horizon", &ev).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::AlreadyExists);
    }

    #[test]
    fn read_evals_finds_them_under_the_kind_keyed_tree() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let dir = root.join(".covenant/canon/evals/command/horizon");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("refuses-a-dirty-tree.toml"),
            "id = \"refuses-a-dirty-tree\"\nscenario = \"s\"\nrubric = \"r\"\n",
        )
        .unwrap();

        let evals = read_evals(root, crate::ContextKind::Command, "horizon");
        assert_eq!(evals.len(), 1);
        assert_eq!(evals[0].id, "refuses-a-dirty-tree");

        // Same name, different kind → not the same evals.
        assert!(read_evals(root, crate::ContextKind::Skill, "horizon").is_empty());
        assert!(read_evals(root, crate::ContextKind::Command, "nope").is_empty());
    }

    /// The reason the tree is kind-keyed: this repo has a command named
    /// `green`, and nothing stops a skill named `green`.
    #[test]
    fn same_name_different_kind_do_not_share_results() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let mk = |pass: bool| EvalResult {
            eval_id: "e1".into(),
            pass,
            reason: "r".into(),
            ran_at_ms: 0,
            duration_ms: 0,
            baseline_pass: None,
        };
        write_result(root, crate::ContextKind::Command, "green", &mk(true)).unwrap();
        write_result(root, crate::ContextKind::Skill, "green", &mk(false)).unwrap();

        assert_eq!(
            pass_rate(root, crate::ContextKind::Command, "green"),
            Some((1, 1))
        );
        assert_eq!(
            pass_rate(root, crate::ContextKind::Skill, "green"),
            Some((0, 1))
        );

        let all = read_results(root);
        assert!(all.contains_key("command/green"));
        assert!(all.contains_key("skill/green"));
    }

    /// History written by a build that keyed results by bare name still reads.
    #[test]
    fn a_legacy_bare_key_is_read_as_a_skill() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join(".covenant/canon")).unwrap();
        std::fs::write(
            root.join(".covenant/canon/eval-results.json"),
            r#"{"kyc-peru":{"e1":{"eval_id":"e1","pass":true,"reason":"r","ran_at_ms":0,"duration_ms":0}}}"#,
        )
        .unwrap();

        assert_eq!(
            pass_rate(root, crate::ContextKind::Skill, "kyc-peru"),
            Some((1, 1))
        );
        assert_eq!(
            pass_rate(root, crate::ContextKind::Command, "kyc-peru"),
            None
        );
    }

    #[test]
    fn write_result_backs_up_corrupt_file_instead_of_losing_it() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join(".covenant/canon");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("eval-results.json"), "{ this is not json").unwrap();
        let r = EvalResult {
            eval_id: "e1".into(),
            pass: true,
            reason: "r".into(),
            ran_at_ms: 1,
            duration_ms: 1,
            baseline_pass: None,
        };
        write_result(tmp.path(), ContextKind::Skill, "skill-a", &r).unwrap();
        assert!(
            dir.join("eval-results.corrupt.json").exists(),
            "corrupt file preserved"
        );
        assert_eq!(
            read_results(tmp.path())["skill/skill-a"]["e1"].pass,
            true,
            "new write still lands"
        );
    }
}
