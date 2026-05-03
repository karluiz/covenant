use covenant_lib::operator_registry::{Operator, OperatorId, OperatorRegistry};
use covenant_lib::storage::Storage;
use karl_session::SessionId;
use ulid::Ulid;

fn tmp_storage() -> (tempfile::TempDir, Storage) {
    let dir = tempfile::tempdir().unwrap();
    let s = Storage::open(&dir.path().join("t.db")).unwrap();
    (dir, s)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

fn sample(name: &str, is_default: bool) -> Operator {
    Operator {
        id: OperatorId(Ulid::new()),
        name: name.into(),
        emoji: "🤖".into(),
        color: "#6B7280".into(),
        tags: vec![],
        persona: "be helpful".into(),
        escalate_threshold: 0.6,
        model: "claude-sonnet-4-6".into(),
        hard_constraints: "".into(),
        is_default,
        created_at_unix_ms: now_ms(),
        updated_at_unix_ms: now_ms(),
    }
}

#[tokio::test]
async fn insert_then_list_returns_row() {
    let (_d, s) = tmp_storage();
    let reg = OperatorRegistry::load(&s).await.unwrap();
    reg.create(&s, sample("Default", true)).await.unwrap();
    let rows = reg.list();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].name, "Default");
    assert!(rows[0].is_default);
}

#[tokio::test]
async fn duplicate_name_rejected_case_insensitive() {
    let (_d, s) = tmp_storage();
    let reg = OperatorRegistry::load(&s).await.unwrap();
    reg.create(&s, sample("Default", true)).await.unwrap();
    let err = reg.create(&s, sample("default", false)).await.unwrap_err();
    assert!(matches!(err,
        covenant_lib::operator_registry::RegistryError::DuplicateName(_)));
}

#[tokio::test]
async fn cannot_delete_default() {
    let (_d, s) = tmp_storage();
    let reg = OperatorRegistry::load(&s).await.unwrap();
    let def = sample("Default", true);
    let id = def.id;
    reg.create(&s, def).await.unwrap();
    let err = reg.delete(&s, id).await.unwrap_err();
    assert!(matches!(err,
        covenant_lib::operator_registry::RegistryError::DefaultProtected));
}

#[tokio::test]
async fn set_default_flips_atomically() {
    let (_d, s) = tmp_storage();
    let reg = OperatorRegistry::load(&s).await.unwrap();
    let a = sample("A", true);
    let b = sample("B", false);
    let (id_a, id_b) = (a.id, b.id);
    reg.create(&s, a).await.unwrap();
    reg.create(&s, b).await.unwrap();
    reg.set_default(&s, id_b).await.unwrap();
    let rows = reg.list();
    let map: std::collections::HashMap<_, _> =
        rows.iter().map(|o| (o.id, o.is_default)).collect();
    assert_eq!(map[&id_a], false);
    assert_eq!(map[&id_b], true);
}

#[tokio::test]
async fn effective_for_unpinned_session_returns_default() {
    let (_d, s) = tmp_storage();
    let reg = OperatorRegistry::load(&s).await.unwrap();
    reg.create(&s, sample("Default", true)).await.unwrap();
    let session_id = SessionId::new();
    let op = reg.effective_for(session_id);
    assert_eq!(op.name, "Default");
}
