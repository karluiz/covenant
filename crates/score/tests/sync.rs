use std::sync::Mutex;
use std::time::Duration;

use karl_score::{sync, EventKind, ScoreStore};
use tempfile::tempdir;

// COVENANT_BACKEND_URL / COVENANT_DEV_JWT are process-global; serialize the
// tests so each one points at its own mockito server.
static ENV_LOCK: Mutex<()> = Mutex::new(());

fn store_with_events(n: i64) -> (tempfile::TempDir, ScoreStore) {
    let dir = tempdir().unwrap();
    let store = ScoreStore::open(dir.path()).unwrap();
    for i in 0..n {
        store.append(i, EventKind::Prompt, "claude").unwrap();
    }
    (dir, store)
}

#[tokio::test]
async fn push_drain_empties_a_backlog_larger_than_one_batch() {
    let _guard = ENV_LOCK.lock().unwrap();
    let mut server = mockito::Server::new_async().await;
    let mock = server
        .mock("POST", "/sync/events")
        .with_status(200)
        .with_body(r#"{"inserted": 500, "server_cursor_ms": 1}"#)
        .expect(3)
        .create_async()
        .await;

    std::env::set_var("COVENANT_DEV_JWT", "test-jwt");
    std::env::set_var("COVENANT_BACKEND_URL", server.url());

    // 1200 events = full batch (500) + full batch (500) + partial (200).
    let (_dir, store) = store_with_events(1200);

    let pushed = sync::push_drain(&store, Duration::ZERO).await.unwrap();
    assert_eq!(pushed, 1200);

    let status = sync::status(&store).unwrap();
    assert_eq!(status.pending_events, 0);
    mock.assert_async().await;
}

#[tokio::test]
async fn push_drain_with_no_pending_events_pushes_nothing() {
    let _guard = ENV_LOCK.lock().unwrap();
    let mut server = mockito::Server::new_async().await;
    let mock = server
        .mock("POST", "/sync/events")
        .expect(0)
        .create_async()
        .await;

    std::env::set_var("COVENANT_DEV_JWT", "test-jwt");
    std::env::set_var("COVENANT_BACKEND_URL", server.url());

    let (_dir, store) = store_with_events(0);

    let pushed = sync::push_drain(&store, Duration::ZERO).await.unwrap();
    assert_eq!(pushed, 0);
    mock.assert_async().await;
}

#[tokio::test]
async fn push_drain_stops_on_server_error_without_advancing_cursor() {
    let _guard = ENV_LOCK.lock().unwrap();
    let mut server = mockito::Server::new_async().await;
    let _mock = server
        .mock("POST", "/sync/events")
        .with_status(500)
        .with_body("boom")
        .create_async()
        .await;

    std::env::set_var("COVENANT_DEV_JWT", "test-jwt");
    std::env::set_var("COVENANT_BACKEND_URL", server.url());

    let (_dir, store) = store_with_events(700);

    let result = sync::push_drain(&store, Duration::ZERO).await;
    assert!(result.is_err());

    let status = sync::status(&store).unwrap();
    assert_eq!(status.pending_events, 700);
}
