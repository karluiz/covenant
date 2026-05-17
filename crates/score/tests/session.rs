use karl_score::{session, ScoreStore, User};
use tempfile::tempdir;

#[test]
fn save_and_load_user() {
    let dir = tempdir().unwrap();
    let store = ScoreStore::open(dir.path()).unwrap();
    assert!(session::current(&store).unwrap().is_none());

    let u = User { github_id: 42, login: "karluiz".into(),
                   avatar_url: "https://avatars/x".into(),
                   connected_at_ms: 1_700_000_000_000 };
    session::set_current(&store, &u).unwrap();

    let loaded = session::current(&store).unwrap().unwrap();
    assert_eq!(loaded.github_id, 42);
    assert_eq!(loaded.login, "karluiz");

    session::clear(&store).unwrap();
    assert!(session::current(&store).unwrap().is_none());
}
