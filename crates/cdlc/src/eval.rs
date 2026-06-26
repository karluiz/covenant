//! CDLC eval format + results store (Plan A of the eval runner).
//!
//! Evals are per-skill `.toml` files under
//! `.covenant/cdlc/skills/<skill>/evals/*.toml`. Each is a behavior test:
//! a `scenario` fed to a real executor and a `rubric` the judge applies to
//! the transcript. Results are stored in `.covenant/cdlc/eval-results.json`.

use crate::manifest::cdlc_dir;
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
}

fn evals_dir(repo_root: &Path, skill: &str) -> std::path::PathBuf {
    cdlc_dir(repo_root).join("skills").join(skill).join("evals")
}

/// Scan `.covenant/cdlc/skills/<skill>/evals/*.toml`, sorted by id.
/// Unparseable or non-toml files are skipped (warned), never fatal.
pub fn read_evals(repo_root: &Path, skill: &str) -> Vec<Eval> {
    let dir = evals_dir(repo_root, skill);
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
        match std::fs::read_to_string(&path).ok().and_then(|s| toml::from_str::<Eval>(&s).ok()) {
            Some(ev) => out.push(ev),
            None => tracing::warn!(target: "cdlc", path = %path.display(), "skipping unparseable eval"),
        }
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

fn results_path(repo_root: &Path) -> std::path::PathBuf {
    cdlc_dir(repo_root).join("eval-results.json")
}

type ResultMap = BTreeMap<String, BTreeMap<String, EvalResult>>;

/// Load all stored results (skill → eval_id → result). Empty on missing/corrupt.
pub fn read_results(repo_root: &Path) -> ResultMap {
    std::fs::read_to_string(results_path(repo_root))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Upsert one result and persist. Creates `.covenant/cdlc/` if needed.
pub fn write_result(repo_root: &Path, skill: &str, result: &EvalResult) -> std::io::Result<()> {
    let mut all = read_results(repo_root);
    all.entry(skill.to_string())
        .or_default()
        .insert(result.eval_id.clone(), result.clone());
    let path = results_path(repo_root);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(&all)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    std::fs::write(path, json)
}

/// `(passed, total)` over stored results for `skill`; `None` if none yet.
pub fn pass_rate(repo_root: &Path, skill: &str) -> Option<(usize, usize)> {
    let all = read_results(repo_root);
    let inner = all.get(skill)?;
    if inner.is_empty() {
        return None;
    }
    let passed = inner.values().filter(|r| r.pass).count();
    Some((passed, inner.len()))
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
        let evals_dir = tmp.path().join(".covenant/cdlc/skills/kyc-peru/evals");
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

        let evals = read_evals(tmp.path(), "kyc-peru");
        assert_eq!(evals.len(), 2, "two valid evals, malformed/non-toml skipped");
        assert_eq!(evals[0].id, "one", "sorted by id");
        assert_eq!(evals[1].scenario, "S2");
    }

    #[test]
    fn no_evals_dir_returns_empty() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(read_evals(tmp.path(), "missing").is_empty());
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
        };
        write_result(tmp.path(), "kyc-peru", &mk("e1", true)).unwrap();
        write_result(tmp.path(), "kyc-peru", &mk("e2", false)).unwrap();
        // Re-running an eval overwrites its prior result.
        write_result(tmp.path(), "kyc-peru", &mk("e2", true)).unwrap();

        assert_eq!(pass_rate(tmp.path(), "kyc-peru"), Some((2, 2)));
        assert_eq!(pass_rate(tmp.path(), "other"), None);
        let all = read_results(tmp.path());
        assert_eq!(all["kyc-peru"]["e2"].pass, true, "latest run wins");
    }
}
