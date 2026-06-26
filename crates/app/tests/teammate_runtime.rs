use covenant_lib::operator_registry::OperatorId;
use covenant_lib::teammate::{OperatorState, TaskId, TeammateRuntime};
use karl_session::SessionId;
use ulid::Ulid;

fn op() -> OperatorId {
    OperatorId(Ulid::new())
}
fn session() -> SessionId {
    SessionId::new()
}

#[test]
fn idle_to_pinned_legal() {
    let rt = TeammateRuntime::new();
    let id = op();
    let s = session();
    rt.pin(id, s).expect("idle → pinned is legal");
    assert!(matches!(rt.state(id), Some(OperatorState::Pinned { session }) if session == s));
}

#[test]
fn pinned_to_ontask_unpins_first() {
    let rt = TeammateRuntime::new();
    let id = op();
    rt.pin(id, session()).unwrap();
    let t = TaskId::new();
    rt.start_task(id, t, None)
        .expect("pinned → ontask is legal (auto-unpin)");
    assert!(
        matches!(rt.state(id), Some(OperatorState::OnTask { task, session: None }) if task == t)
    );
}

#[test]
fn ontask_to_ontask_rejected() {
    let rt = TeammateRuntime::new();
    let id = op();
    rt.start_task(id, TaskId::new(), None).unwrap();
    let err = rt.start_task(id, TaskId::new(), None).unwrap_err();
    let msg = format!("{err}");
    assert!(msg.contains("already on task"), "got: {msg}");
}

#[test]
fn finishing_task_returns_to_idle() {
    let rt = TeammateRuntime::new();
    let id = op();
    let t = TaskId::new();
    rt.start_task(id, t, None).unwrap();
    rt.finish_task(id, t).unwrap();
    assert_eq!(rt.state(id), Some(OperatorState::Idle));
}
