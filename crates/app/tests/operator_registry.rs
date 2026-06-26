use covenant_lib::operator_registry::{Operator, OperatorId, OperatorRegistry};
use covenant_lib::settings::OperatorConfig;
use covenant_lib::storage::Storage;
use karl_session::SessionId;
use ulid::Ulid;

fn tmp_storage() -> (tempfile::TempDir, Storage) {
    let dir = tempfile::tempdir().unwrap();
    let s = Storage::open(&dir.path().join("t.db")).unwrap();
    (dir, s)
}

/// souls dir for a registry under test, derived from the per-test TempDir so
/// SOUL.md files (written by create/update) land inside the temp tree.
fn souls(d: &tempfile::TempDir) -> std::path::PathBuf {
    d.path().join("operators")
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
        xp: 0,
        voice: covenant_lib::operator_registry::VoiceTone::default(),
        github_access: covenant_lib::operator_registry::GithubAccess::default(),
        soul_path: None,
        soul_mtime_unix_ms: 0,
    }
}

#[tokio::test]
async fn insert_then_list_returns_row() {
    let (_d, s) = tmp_storage();
    let reg = OperatorRegistry::load(&s, souls(&_d)).await.unwrap();
    reg.create(&s, sample("Default", true)).await.unwrap();
    let rows = reg.list();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].name, "Default");
    assert!(rows[0].is_default);
}

#[tokio::test]
async fn duplicate_name_rejected_case_insensitive() {
    let (_d, s) = tmp_storage();
    let reg = OperatorRegistry::load(&s, souls(&_d)).await.unwrap();
    reg.create(&s, sample("Default", true)).await.unwrap();
    let err = reg.create(&s, sample("default", false)).await.unwrap_err();
    assert!(matches!(
        err,
        covenant_lib::operator_registry::RegistryError::DuplicateName(_)
    ));
}

#[tokio::test]
async fn cannot_delete_default() {
    let (_d, s) = tmp_storage();
    let reg = OperatorRegistry::load(&s, souls(&_d)).await.unwrap();
    let def = sample("Default", true);
    let id = def.id;
    reg.create(&s, def).await.unwrap();
    let err = reg.delete(&s, id).await.unwrap_err();
    assert!(matches!(
        err,
        covenant_lib::operator_registry::RegistryError::DefaultProtected
    ));
}

#[tokio::test]
async fn set_default_flips_atomically() {
    let (_d, s) = tmp_storage();
    let reg = OperatorRegistry::load(&s, souls(&_d)).await.unwrap();
    let a = sample("A", true);
    let b = sample("B", false);
    let (id_a, id_b) = (a.id, b.id);
    reg.create(&s, a).await.unwrap();
    reg.create(&s, b).await.unwrap();
    reg.set_default(&s, id_b).await.unwrap();
    let rows = reg.list();
    let map: std::collections::HashMap<_, _> = rows.iter().map(|o| (o.id, o.is_default)).collect();
    assert_eq!(map[&id_a], false);
    assert_eq!(map[&id_b], true);
}

#[tokio::test]
async fn effective_for_unpinned_session_returns_default() {
    let (_d, s) = tmp_storage();
    let reg = OperatorRegistry::load(&s, souls(&_d)).await.unwrap();
    reg.create(&s, sample("Default", true)).await.unwrap();
    let session_id = SessionId::new();
    let op = reg.effective_for(session_id);
    assert_eq!(op.name, "Default");
}

#[tokio::test]
async fn migration_seeds_default_from_settings_only_once() {
    let (_d, s) = tmp_storage();
    let cfg = OperatorConfig::default();
    let model = "claude-sonnet-4-6".to_string();

    let reg1 = OperatorRegistry::load(&s, souls(&_d)).await.unwrap();
    let inserted = reg1
        .seed_default_from_settings(&s, &cfg, &model)
        .await
        .unwrap();
    assert!(inserted, "first call should insert");
    assert_eq!(reg1.list().len(), 1);
    let def = reg1.default().unwrap();
    assert_eq!(def.name, "Default");
    assert_eq!(def.persona, cfg.persona);
    assert!(def.is_default);

    // Second call (e.g. next boot) is a no-op.
    let reg2 = OperatorRegistry::load(&s, souls(&_d)).await.unwrap();
    let inserted2 = reg2
        .seed_default_from_settings(&s, &cfg, &model)
        .await
        .unwrap();
    assert!(!inserted2, "second call should be a no-op");
    assert_eq!(reg2.list().len(), 1);
}

#[tokio::test]
async fn pin_unpin_round_trip() {
    let (_d, s) = tmp_storage();
    let reg = OperatorRegistry::load(&s, souls(&_d)).await.unwrap();
    reg.create(&s, sample("Default", true)).await.unwrap();
    let sec = sample("Sec-Op", false);
    let sec_id = sec.id;
    reg.create(&s, sec).await.unwrap();

    let sid = SessionId::new();
    assert_eq!(reg.effective_for(sid).name, "Default");

    reg.pin_session(sid, sec_id);
    assert_eq!(reg.effective_for(sid).name, "Sec-Op");

    reg.unpin_session(sid);
    assert_eq!(reg.effective_for(sid).name, "Default");
}

#[tokio::test]
async fn teammate_messages_roundtrip() {
    use covenant_lib::teammate::{MessageContent, MessageId, Role, TaskMessage};
    use ulid::Ulid;

    let (_tmp, storage) = tmp_storage();
    // Need an operator row for the FK.
    let op = sample("Mibli", true);
    let op_id = op.id;
    storage.operator_insert(op).await.unwrap();

    let msg = TaskMessage {
        id: MessageId(Ulid::new()),
        operator_id: op_id,
        task_id: None,
        thread_id: None,
        role: Role::User,
        content: MessageContent::Text("hola Mibli".into()),
        created_at_unix_ms: now_ms(),
        confirmed_at_unix_ms: None,
        dismissed_at_unix_ms: None,
        sentiment: None,
    };
    storage.teammate_insert_message(&msg).await.unwrap();

    let listed = storage.teammate_list_messages(op_id, 50).await.unwrap();
    assert_eq!(listed.len(), 1, "message should round-trip");
    let MessageContent::Text(t) = &listed[0].content else {
        panic!("wrong kind")
    };
    assert_eq!(t, "hola Mibli");
}

#[tokio::test]
async fn deleting_pinned_operator_falls_back_to_default() {
    let (_d, s) = tmp_storage();
    let reg = OperatorRegistry::load(&s, souls(&_d)).await.unwrap();
    reg.create(&s, sample("Default", true)).await.unwrap();
    let sec = sample("Sec-Op", false);
    let sec_id = sec.id;
    reg.create(&s, sec).await.unwrap();

    let sid = SessionId::new();
    reg.pin_session(sid, sec_id);
    reg.delete(&s, sec_id).await.unwrap();
    assert_eq!(reg.effective_for(sid).name, "Default");
}
