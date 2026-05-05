use chrono::Utc;
use karl_agent::spec_author::{
    list_drafts, load_draft, save_draft, DraftMessage, DraftStatus, MessageRole, Phase, SpecDraft,
    SpecAuthorError,
};
use ulid::Ulid;

fn make_draft(status: DraftStatus) -> SpecDraft {
    SpecDraft {
        id: Ulid::new(),
        messages: vec![
            DraftMessage {
                role: MessageRole::User,
                content: "What should the spec cover?".to_string(),
            },
            DraftMessage {
                role: MessageRole::Assistant,
                content: "Let's start with the goal.".to_string(),
            },
        ],
        partial_md: Some("## Goal\n\nFoo bar.".to_string()),
        last_updated: Utc::now(),
        status,
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
