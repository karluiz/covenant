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

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct EvalResult {
    pub eval_id: String,
    pub pass: bool,
    pub reason: String,
    pub ran_at_ms: i64,
    pub duration_ms: u64,
    #[serde(default)]
    pub baseline_pass: Option<bool>,
    /// A later run of this eval timed out or errored — this verdict is from a
    /// PRIOR run and must never be presented as current.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub stale: bool,
    /// Model the harness ran the scenario with (provenance).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub executor_model: Option<String>,
    /// Model that judged the transcript (provenance).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub judge_model: Option<String>,
}

/// Full record of one eval run — everything needed to understand a verdict.
/// One file per eval id, last run wins (bounded by construction: re-runs
/// overwrite, so the store never grows past one file per authored eval).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EvalRunDetail {
    pub eval_id: String,
    pub scenario: String,
    pub rubric: String,
    pub pass: bool,
    pub reason: String,
    pub ran_at_ms: i64,
    pub duration_ms: u64,
    #[serde(default)]
    pub baseline_pass: Option<bool>,
    #[serde(default)]
    pub executor_model: Option<String>,
    #[serde(default)]
    pub judge_model: Option<String>,
    /// Agent transcript, with-unit arm. Secret-masked by the caller.
    pub transcript: String,
    /// Agent transcript, baseline arm. None when the baseline was skipped,
    /// cached, or opted out.
    #[serde(default)]
    pub baseline_transcript: Option<String>,
}

/// One case's verdict inside a history record — enough to reconstruct that
/// run's case list even though the detail store only keeps the last run.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EvalCaseRecord {
    pub eval_id: String,
    pub pass: bool,
    pub reason: String,
    pub duration_ms: u64,
}

/// One line of the append-only run log: a completed suite run's aggregate.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EvalRunRecord {
    pub kind: String,
    pub name: String,
    pub passed: usize,
    pub total: usize,
    pub at_ms: i64,
    /// Per-case verdicts of THIS run. Empty on records written before this
    /// field existed — the UI falls back to unit-level (last-run) state.
    #[serde(default)]
    pub cases: Vec<EvalCaseRecord>,
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
    update_results(repo_root, |all| {
        all.entry(unit_key(kind, name))
            .or_default()
            .insert(result.eval_id.clone(), result.clone());
    })
}

/// Mark a stored verdict stale — a newer run of this eval timed out or
/// errored, so the stored PASS/FAIL is from a prior run and must not be
/// presented as current. No-op if the eval has no stored result.
pub fn mark_result_stale(
    repo_root: &Path,
    kind: ContextKind,
    name: &str,
    eval_id: &str,
) -> std::io::Result<()> {
    update_results(repo_root, |all| {
        if let Some(r) = all
            .get_mut(&unit_key(kind, name))
            .and_then(|m| m.get_mut(eval_id))
        {
            r.stale = true;
        }
    })
}

/// Read-modify-write of `eval-results.json` behind `WRITE_LOCK`, with the
/// corrupt-file backup and atomic tmp+rename shared by every mutation.
fn update_results(repo_root: &Path, mutate: impl FnOnce(&mut ResultMap)) -> std::io::Result<()> {
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

    mutate(&mut all);

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

// --- run details (transcripts) ------------------------------------------

/// `.covenant/canon/eval-runs/<kind>/<name>/<eval_id>.json`
fn run_detail_path(
    repo_root: &Path,
    kind: ContextKind,
    name: &str,
    eval_id: &str,
) -> std::path::PathBuf {
    canon_dir(repo_root)
        .join("eval-runs")
        .join(kind.slug())
        .join(name)
        .join(format!("{eval_id}.json"))
}

/// Persist one run's full detail (transcripts included). Overwrites the prior
/// run's file — retention is exactly one run per eval id.
pub fn write_run_detail(
    repo_root: &Path,
    kind: ContextKind,
    name: &str,
    detail: &EvalRunDetail,
) -> std::io::Result<()> {
    let path = run_detail_path(repo_root, kind, name, &detail.eval_id);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(detail)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    std::fs::write(&path, json)
}

/// Read one eval's last run detail. None if never run (or predates details).
pub fn read_run_detail(
    repo_root: &Path,
    kind: ContextKind,
    name: &str,
    eval_id: &str,
) -> Option<EvalRunDetail> {
    std::fs::read_to_string(run_detail_path(repo_root, kind, name, eval_id))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
}

/// Delete one eval's authored `.toml` (and its stored run detail, if any).
/// The stored verdict in `eval-results.json` is removed too so summaries
/// don't keep counting a deleted eval.
pub fn delete_eval(
    repo_root: &Path,
    kind: ContextKind,
    name: &str,
    eval_id: &str,
) -> std::io::Result<()> {
    std::fs::remove_file(evals_dir(repo_root, kind, name).join(format!("{eval_id}.toml")))?;
    let _ = std::fs::remove_file(run_detail_path(repo_root, kind, name, eval_id));
    update_results(repo_root, |all| {
        if let Some(m) = all.get_mut(&unit_key(kind, name)) {
            m.remove(eval_id);
        }
    })
}

/// Write one eval unconditionally — the explicit-overwrite path behind the
/// UI's "overwrite existing" choice. `write_eval` stays the safe default.
pub fn overwrite_eval(
    repo_root: &Path,
    kind: ContextKind,
    name: &str,
    eval: &Eval,
) -> std::io::Result<std::path::PathBuf> {
    let dir = evals_dir(repo_root, kind, name);
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(format!("{}.toml", eval.id));
    let body = toml::to_string_pretty(eval)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string()))?;
    std::fs::write(&path, body)?;
    Ok(path)
}

// --- baseline cache ------------------------------------------------------

/// The bare-sandbox arm is identical for a given scenario text across runs
/// and units, so its verdict is cached by scenario hash — re-runs cost half.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BaselineVerdict {
    pub pass: bool,
    pub judged_at_ms: i64,
}

fn baseline_cache_path(repo_root: &Path) -> std::path::PathBuf {
    canon_dir(repo_root).join("eval-baseline-cache.json")
}

/// Stable key for a scenario's baseline verdict.
pub fn scenario_hash(scenario: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(scenario.as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn read_baseline_cache(repo_root: &Path) -> BTreeMap<String, BaselineVerdict> {
    std::fs::read_to_string(baseline_cache_path(repo_root))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Upsert one baseline verdict. Shares `WRITE_LOCK` with the results file —
/// both are small read-modify-write JSON stores mutated from the same run.
pub fn write_baseline_verdict(
    repo_root: &Path,
    hash: &str,
    verdict: &BaselineVerdict,
) -> std::io::Result<()> {
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let path = baseline_cache_path(repo_root);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut all = read_baseline_cache(repo_root);
    all.insert(hash.to_string(), verdict.clone());
    let json = serde_json::to_string_pretty(&all)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &json)?;
    std::fs::rename(&tmp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e
    })
}

// --- run history ----------------------------------------------------------

fn history_path(repo_root: &Path) -> std::path::PathBuf {
    canon_dir(repo_root).join("eval-history.jsonl")
}

/// Append one completed run's aggregate to the run log (JSONL, append-only).
pub fn append_history(repo_root: &Path, record: &EvalRunRecord) -> std::io::Result<()> {
    use std::io::Write;
    let path = history_path(repo_root);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let line = serde_json::to_string(record)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)?;
    writeln!(f, "{line}")
}

/// All run records, oldest first. Unparseable lines are skipped.
pub fn read_history(repo_root: &Path) -> Vec<EvalRunRecord> {
    std::fs::read_to_string(history_path(repo_root))
        .unwrap_or_default()
        .lines()
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect()
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

/// Count authored eval files per unit, keyed like `unit_key` ("skill/horizon").
/// File count, not parse count — a malformed toml still shows as authored so
/// the gap is visible in the UI rather than silently ignored.
pub fn authored_counts(repo_root: &Path) -> BTreeMap<String, usize> {
    let mut out = BTreeMap::new();
    let Ok(kinds) = std::fs::read_dir(canon_dir(repo_root).join("evals")) else {
        return out;
    };
    for kind in kinds.flatten() {
        let Ok(units) = std::fs::read_dir(kind.path()) else {
            continue;
        };
        let kind_slug = kind.file_name().to_string_lossy().into_owned();
        for unit in units.flatten() {
            let Ok(files) = std::fs::read_dir(unit.path()) else {
                continue;
            };
            let n = files
                .flatten()
                .filter(|f| f.path().extension().and_then(|e| e.to_str()) == Some("toml"))
                .count();
            if n > 0 {
                out.insert(
                    format!("{kind_slug}/{}", unit.file_name().to_string_lossy()),
                    n,
                );
            }
        }
    }
    out
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
            ..Default::default()
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
            ..Default::default()
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
    fn authored_counts_scans_the_whole_tree() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let ev = |id: &str| Eval {
            id: id.into(),
            scenario: "s".into(),
            rubric: "r".into(),
        };
        super::write_eval(root, crate::ContextKind::Skill, "horizon", &ev("a")).unwrap();
        super::write_eval(root, crate::ContextKind::Skill, "horizon", &ev("b")).unwrap();
        super::write_eval(root, crate::ContextKind::Command, "green", &ev("a")).unwrap();
        // A stray non-toml file must not count.
        std::fs::write(
            root.join(".covenant/canon/evals/skill/horizon/notes.md"),
            "x",
        )
        .unwrap();

        let counts = authored_counts(root);
        assert_eq!(counts.get("skill/horizon"), Some(&2));
        assert_eq!(counts.get("command/green"), Some(&1));
        assert_eq!(counts.len(), 2);
        assert!(authored_counts(tempfile::tempdir().unwrap().path()).is_empty());
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
            ..Default::default()
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
    fn overwrite_eval_replaces_and_delete_eval_removes_everything() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let k = crate::ContextKind::Skill;
        let ev = |s: &str| Eval {
            id: "e1".into(),
            scenario: s.into(),
            rubric: "r".into(),
        };
        super::write_eval(root, k, "horizon", &ev("original")).unwrap();
        // Explicit overwrite replaces where write_eval refuses.
        overwrite_eval(root, k, "horizon", &ev("replaced")).unwrap();
        assert_eq!(read_evals(root, k, "horizon")[0].scenario, "replaced");

        // Seed a verdict + detail, then delete: file, verdict and detail all go.
        write_result(
            root,
            k,
            "horizon",
            &EvalResult {
                eval_id: "e1".into(),
                pass: true,
                ..Default::default()
            },
        )
        .unwrap();
        write_run_detail(
            root,
            k,
            "horizon",
            &EvalRunDetail {
                eval_id: "e1".into(),
                scenario: "s".into(),
                rubric: "r".into(),
                pass: true,
                reason: "ok".into(),
                ran_at_ms: 1,
                duration_ms: 2,
                baseline_pass: None,
                executor_model: None,
                judge_model: None,
                transcript: "t".into(),
                baseline_transcript: None,
            },
        )
        .unwrap();
        delete_eval(root, k, "horizon", "e1").unwrap();
        assert!(read_evals(root, k, "horizon").is_empty());
        assert!(read_run_detail(root, k, "horizon", "e1").is_none());
        assert!(
            read_results(root)
                .get("skill/horizon")
                .map(|m| m.is_empty())
                .unwrap_or(true),
            "stored verdict removed with the eval"
        );
        // Deleting a missing eval errors instead of pretending.
        assert!(delete_eval(root, k, "horizon", "ghost").is_err());
    }

    #[test]
    fn mark_result_stale_flags_existing_and_old_json_defaults_to_fresh() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let k = crate::ContextKind::Command;
        write_result(
            root,
            k,
            "horizon",
            &EvalResult {
                eval_id: "e1".into(),
                pass: true,
                ..Default::default()
            },
        )
        .unwrap();
        mark_result_stale(root, k, "horizon", "e1").unwrap();
        assert!(read_results(root)["command/horizon"]["e1"].stale);
        // Missing eval → no-op, not an error, and nothing invented.
        mark_result_stale(root, k, "horizon", "ghost").unwrap();
        assert!(!read_results(root)["command/horizon"].contains_key("ghost"));

        // Old JSON without the field parses as not-stale.
        let old = r#"{"eval_id":"e1","pass":true,"reason":"ok","ran_at_ms":1,"duration_ms":2}"#;
        let r: EvalResult = serde_json::from_str(old).unwrap();
        assert!(!r.stale);
        assert_eq!(r.executor_model, None);
    }

    #[test]
    fn run_detail_roundtrips() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let d = EvalRunDetail {
            eval_id: "e1".into(),
            scenario: "s".into(),
            rubric: "r".into(),
            pass: false,
            reason: "approved without KYC".into(),
            ran_at_ms: 42,
            duration_ms: 7,
            baseline_pass: Some(false),
            executor_model: Some("sonnet".into()),
            judge_model: Some("claude-sonnet-4-6".into()),
            transcript: "the agent said things".into(),
            baseline_transcript: Some("bare arm".into()),
        };
        write_run_detail(root, crate::ContextKind::Skill, "kyc", &d).unwrap();
        assert_eq!(
            read_run_detail(root, crate::ContextKind::Skill, "kyc", "e1"),
            Some(d)
        );
        assert!(read_run_detail(root, crate::ContextKind::Skill, "kyc", "never").is_none());
    }

    #[test]
    fn baseline_cache_roundtrips_and_hash_is_stable() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let h = scenario_hash("do the thing");
        assert_eq!(h, scenario_hash("do the thing"), "same text, same key");
        assert_ne!(h, scenario_hash("do another thing"));

        assert!(read_baseline_cache(root).is_empty());
        write_baseline_verdict(
            root,
            &h,
            &BaselineVerdict {
                pass: true,
                judged_at_ms: 9,
            },
        )
        .unwrap();
        assert_eq!(
            read_baseline_cache(root).get(&h),
            Some(&BaselineVerdict {
                pass: true,
                judged_at_ms: 9
            })
        );
    }

    #[test]
    fn history_appends_and_reads_in_order() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let rec = |passed: usize, at: i64| EvalRunRecord {
            kind: "skill".into(),
            name: "horizon".into(),
            passed,
            total: 8,
            at_ms: at,
            cases: vec![EvalCaseRecord {
                eval_id: "e1".into(),
                pass: true,
                reason: "refused".into(),
                duration_ms: 41_000,
            }],
        };
        append_history(root, &rec(3, 1)).unwrap();
        append_history(root, &rec(7, 2)).unwrap();
        // A pre-`cases` line must still deserialize (field defaults to empty).
        {
            use std::io::Write;
            let mut f = std::fs::OpenOptions::new()
                .append(true)
                .open(crate::manifest::canon_dir(root).join("eval-history.jsonl"))
                .unwrap();
            writeln!(
                f,
                r#"{{"kind":"skill","name":"horizon","passed":1,"total":8,"at_ms":3}}"#
            )
            .unwrap();
        }
        let all = read_history(root);
        assert_eq!(all.len(), 3);
        assert_eq!((all[0].passed, all[1].passed), (3, 7), "oldest first");
        assert_eq!(all[0].cases.len(), 1);
        assert!(all[2].cases.is_empty(), "legacy line reads with no cases");
        assert!(read_history(tempfile::tempdir().unwrap().path()).is_empty());
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
            ..Default::default()
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
