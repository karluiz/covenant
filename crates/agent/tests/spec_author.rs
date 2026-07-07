use async_trait::async_trait;
use chrono::Utc;
use karl_agent::spec_author::{
    list_drafts, load_draft, mark_published, save_draft, step, validate_spec_markdown, Dispatcher,
    DraftMessage, DraftStatus, MessageRole, Phase, SpecAuthorError, SpecDraft, StepOutput,
};
use std::collections::VecDeque;
use std::sync::Mutex;
use ulid::Ulid;

fn make_draft(status: DraftStatus) -> SpecDraft {
    SpecDraft {
        id: Ulid::new(),
        messages: vec![
            DraftMessage::user("What should the spec cover?".to_string()),
            DraftMessage::assistant("Let's start with the goal.".to_string()),
        ],
        partial_md: Some("## Goal\n\nFoo bar.".to_string()),
        last_updated: Utc::now(),
        status,
        repo_root: None,
    }
}

/// Step 1.4 — round-trip: save then load, assert equality.
#[test]
fn round_trip() {
    let dir = tempfile::tempdir().expect("tempdir");
    let draft = make_draft(DraftStatus::InProgress { phase: Phase::Goal });

    save_draft(dir.path(), &draft).expect("save");
    let loaded = load_draft(dir.path(), draft.id).expect("load");

    assert_eq!(draft.id, loaded.id);
    assert_eq!(draft.messages, loaded.messages);
    assert_eq!(draft.partial_md, loaded.partial_md);
    assert_eq!(draft.status, loaded.status);
    // DateTime<Utc> round-trips through JSON with second precision; verify same timestamp.
    assert_eq!(
        draft.last_updated.timestamp(),
        loaded.last_updated.timestamp()
    );
}

/// Step 1.4 — NotFound error for a missing id.
#[test]
fn load_missing_returns_not_found() {
    let dir = tempfile::tempdir().expect("tempdir");
    let id = Ulid::new();
    let err = load_draft(dir.path(), id).unwrap_err();
    assert!(
        matches!(err, SpecAuthorError::NotFound { id: e_id } if e_id == id),
        "expected NotFound, got {err:?}"
    );
}

/// Step 1.5 — list_drafts ignores malformed JSON; returns only valid drafts.
#[test]
fn list_drafts_ignores_corrupt_files() {
    let dir = tempfile::tempdir().expect("tempdir");

    // Valid draft.
    let draft = make_draft(DraftStatus::Ready);
    save_draft(dir.path(), &draft).expect("save");

    // Corrupt JSON file in the same directory.
    let corrupt_path = dir.path().join("spec-drafts").join("corrupt.json");
    std::fs::write(&corrupt_path, b"{not valid json}").expect("write corrupt");

    let results = list_drafts(dir.path());
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].id, draft.id);
}

/// list_drafts returns empty vec when the directory doesn't exist (no panic).
#[test]
fn list_drafts_empty_when_no_dir() {
    let dir = tempfile::tempdir().expect("tempdir");
    // Do NOT create spec-drafts subdirectory.
    let results = list_drafts(dir.path());
    assert!(results.is_empty());
}

/// list_drafts orders by last_updated descending.
#[test]
fn list_drafts_ordered_desc() {
    let dir = tempfile::tempdir().expect("tempdir");

    let earlier = SpecDraft {
        last_updated: chrono::DateTime::from_timestamp(1_000, 0).unwrap(),
        ..make_draft(DraftStatus::Ready)
    };
    let later = SpecDraft {
        last_updated: chrono::DateTime::from_timestamp(2_000, 0).unwrap(),
        ..make_draft(DraftStatus::Published)
    };

    save_draft(dir.path(), &earlier).expect("save earlier");
    save_draft(dir.path(), &later).expect("save later");

    let results = list_drafts(dir.path());
    assert_eq!(results.len(), 2);
    assert_eq!(results[0].id, later.id, "most recent first");
    assert_eq!(results[1].id, earlier.id);
}

/// list_drafts caps at 20 entries.
#[test]
fn list_drafts_capped_at_20() {
    let dir = tempfile::tempdir().expect("tempdir");
    for i in 0..25i64 {
        let d = SpecDraft {
            last_updated: chrono::DateTime::from_timestamp(i, 0).unwrap(),
            ..make_draft(DraftStatus::Ready)
        };
        save_draft(dir.path(), &d).expect("save");
    }
    let results = list_drafts(dir.path());
    assert_eq!(results.len(), 20);
}

// ── Task 2 tests ──────────────────────────────────────────────────────────────

/// Mock dispatcher that returns pre-canned responses in order.
struct MockDispatcher {
    responses: Mutex<VecDeque<String>>,
}

impl MockDispatcher {
    fn new(responses: impl IntoIterator<Item = impl Into<String>>) -> Self {
        Self {
            responses: Mutex::new(responses.into_iter().map(|s| s.into()).collect()),
        }
    }
}

#[async_trait]
impl Dispatcher for MockDispatcher {
    async fn dispatch(
        &self,
        _system: &str,
        _messages: &[DraftMessage],
    ) -> karl_agent::spec_author::Result<String> {
        let mut q = self.responses.lock().unwrap();
        Ok(q.pop_front().unwrap_or_default())
    }
}

fn fresh_draft() -> SpecDraft {
    SpecDraft {
        id: Ulid::new(),
        messages: vec![],
        partial_md: None,
        last_updated: Utc::now(),
        status: DraftStatus::InProgress { phase: Phase::Goal },
        repo_root: None,
    }
}

const VALID_SPEC: &str = r#"# 3.99 — Test Feature

## Goal

A single sentence describing the user-visible problem.

## Out of scope

- Unrelated thing A
- Unrelated thing B

## Acceptance criteria

- [ ] User can do X via Y
- [ ] Command Z passes

## File boundaries

- **Create**: `src/foo.rs` (≤ 50 lines)
- **DO NOT touch**: `src/bar.rs`

## Complexity

`small`

## Open questions

- None at this time
"#;

/// Step 2.4 — first call returns a Question; 6th (with valid spec) returns Final + Ready.
#[tokio::test]
async fn step_question_then_final() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut draft = fresh_draft();

    let final_response = format!("<spec>\n{VALID_SPEC}</spec>");
    let mock = MockDispatcher::new([
        "What is the user-visible problem?",
        "What should be out of scope?",
        "What are the acceptance criteria?",
        "Which files are in scope?",
        "Is this small, medium, or large?",
        final_response.as_str(),
    ]);

    // Turn 1: should return Question.
    let out = step(&mock, &mut draft, "Start".to_string(), dir.path())
        .await
        .expect("step 1");
    assert!(
        matches!(out, StepOutput::Question { .. }),
        "expected Question on turn 1"
    );

    // Turns 2–5: questions.
    for i in 2..=5 {
        let out = step(&mock, &mut draft, format!("Answer {i}"), dir.path())
            .await
            .unwrap_or_else(|e| panic!("step {i} failed: {e}"));
        assert!(
            matches!(out, StepOutput::Question { .. }),
            "expected Question on turn {i}"
        );
    }

    // Turn 6: should return Final.
    let out = step(
        &mock,
        &mut draft,
        "No open questions".to_string(),
        dir.path(),
    )
    .await
    .expect("step 6");
    assert!(
        matches!(out, StepOutput::Final { .. }),
        "expected Final on turn 6, got {out:?}"
    );
    assert_eq!(draft.status, DraftStatus::Ready);

    // Verify draft was persisted.
    let loaded = load_draft(dir.path(), draft.id).expect("load after Final");
    assert_eq!(loaded.status, DraftStatus::Ready);
}

/// Step 2.5 — invalid spec (missing ## File boundaries) returns Err(InvalidSpec) and draft
/// stays InProgress.
#[tokio::test]
async fn step_invalid_spec_keeps_in_progress() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut draft = fresh_draft();

    let bad_spec = r#"# 3.X — Bad

## Goal

The goal.

## Out of scope

- nothing

## Acceptance criteria

- [ ] something passes

## Complexity

`small`

## Open questions

- none
"#;

    let mock = MockDispatcher::new([format!("<spec>\n{bad_spec}</spec>")]);

    let err = step(&mock, &mut draft, "go".to_string(), dir.path())
        .await
        .expect_err("should have returned Err(InvalidSpec)");

    match err {
        SpecAuthorError::InvalidSpec { ref missing } => {
            assert!(
                missing.iter().any(|s| s.contains("File boundaries")),
                "expected 'File boundaries' in missing sections, got {missing:?}"
            );
        }
        other => panic!("expected InvalidSpec, got {other:?}"),
    }

    // Draft must remain InProgress.
    assert!(
        matches!(draft.status, DraftStatus::InProgress { .. }),
        "draft should stay InProgress after InvalidSpec"
    );
}

/// validate_spec_markdown passes on a complete spec.
#[test]
fn validate_passes_complete_spec() {
    validate_spec_markdown(VALID_SPEC).expect("should be valid");
}

/// Task 6 — mark_published: save InProgress draft, call mark_published, reload, assert Published.
#[test]
fn mark_published_sets_status() {
    let dir = tempfile::tempdir().expect("tempdir");
    let draft = make_draft(DraftStatus::InProgress { phase: Phase::Goal });
    let id = draft.id;
    let original_ts = draft.last_updated;

    save_draft(dir.path(), &draft).expect("save");

    // Small sleep so last_updated is guaranteed to advance.
    std::thread::sleep(std::time::Duration::from_millis(5));

    mark_published(id, dir.path()).expect("mark_published");

    let loaded = load_draft(dir.path(), id).expect("load after mark_published");
    assert_eq!(loaded.status, DraftStatus::Published);
    assert!(
        loaded.last_updated >= original_ts,
        "last_updated should be >= original after mark_published"
    );
}

/// validate_spec_markdown fails when sections are missing.
#[test]
fn validate_detects_missing_sections() {
    let no_complexity = VALID_SPEC.replace("## Complexity", "## Complexidad");
    let err = validate_spec_markdown(&no_complexity).expect_err("should fail");
    match err {
        SpecAuthorError::InvalidSpec { missing } => {
            assert!(missing.contains(&"## Complexity".to_string()));
        }
        other => panic!("expected InvalidSpec, got {other:?}"),
    }
}

// ── Repo grounding ────────────────────────────────────────────────────────────

use karl_agent::spec_author::{compose_system, resolve_repo_root, step_with_context};

#[test]
fn resolve_repo_root_walks_up_to_git_root() {
    let dir = tempfile::tempdir().expect("tempdir");
    let root = dir.path().join("repo");
    std::fs::create_dir_all(root.join(".git")).expect("mk .git");
    let nested = root.join("sub").join("dir");
    std::fs::create_dir_all(&nested).expect("mk nested");

    let resolved = resolve_repo_root(&nested);
    assert_eq!(resolved, std::fs::canonicalize(&root).unwrap());
}

#[test]
fn resolve_repo_root_falls_back_to_cwd_without_git() {
    let dir = tempfile::tempdir().expect("tempdir");
    let plain = dir.path().join("plain");
    std::fs::create_dir_all(&plain).expect("mk plain");

    let resolved = resolve_repo_root(&plain);
    assert_eq!(resolved, std::fs::canonicalize(&plain).unwrap());
}

#[test]
fn compose_system_grounds_tools_at_git_root_and_states_path_rule() {
    let dir = tempfile::tempdir().expect("tempdir");
    let root = dir.path().join("repo");
    std::fs::create_dir_all(root.join(".git")).expect("mk .git");
    let nested = root.join("ui");
    std::fs::create_dir_all(&nested).expect("mk nested");
    let fallback = dir.path().join("covenant");
    std::fs::create_dir_all(&fallback).expect("mk fallback");

    let (jail, system) = compose_system(Some(&nested), &fallback);
    let canon_root = std::fs::canonicalize(&root).unwrap();
    assert_eq!(
        jail, canon_root,
        "tool jail must be the git root, not the raw cwd"
    );
    assert!(
        system.contains(&canon_root.display().to_string()),
        "system prompt must state the repo root path"
    );
    assert!(
        system.contains("relative to this root"),
        "system prompt must explain that tool paths are root-relative"
    );
}

#[test]
fn compose_system_without_cwd_admits_no_repo() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (jail, system) = compose_system(None, dir.path());
    assert_eq!(jail, dir.path());
    assert!(
        system.contains("No repository is attached"),
        "system prompt must say there is no repo context instead of staying silent"
    );
}

#[test]
fn compose_system_with_missing_dir_admits_no_repo() {
    let dir = tempfile::tempdir().expect("tempdir");
    let ghost = dir.path().join("does-not-exist");
    let (jail, system) = compose_system(Some(&ghost), dir.path());
    assert_eq!(jail, dir.path());
    assert!(system.contains("No repository is attached"));
}

/// Mock dispatcher that records the system prompt of every call.
#[derive(Default)]
struct RecordingDispatcher {
    systems: Mutex<Vec<String>>,
}

#[async_trait]
impl Dispatcher for RecordingDispatcher {
    async fn dispatch(
        &self,
        system: &str,
        _messages: &[DraftMessage],
    ) -> karl_agent::spec_author::Result<String> {
        self.systems.lock().unwrap().push(system.to_string());
        Ok("What is the goal?".to_string())
    }
}

#[tokio::test]
async fn step_with_context_keeps_repo_context_on_every_turn() {
    let dir = tempfile::tempdir().expect("tempdir");
    let repo = dir.path().join("repo");
    std::fs::create_dir_all(repo.join(".git")).expect("mk .git");

    let mut draft = fresh_draft();
    let disp = RecordingDispatcher::default();

    step_with_context(&disp, &mut draft, "turn 1".into(), dir.path(), Some(&repo))
        .await
        .expect("turn 1");
    step_with_context(&disp, &mut draft, "turn 2".into(), dir.path(), Some(&repo))
        .await
        .expect("turn 2");

    let systems = disp.systems.lock().unwrap();
    assert!(systems[0].contains("Repository context"));
    assert!(
        systems[1].contains("Repository context"),
        "repo context must not be dropped after the first turn"
    );
}
