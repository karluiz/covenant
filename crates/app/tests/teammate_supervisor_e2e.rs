//! End-to-end: feeding BlockFinished into the supervisor bus produces
//! sentiment-tagged TaskUpdate rows in storage and flips task status
//! to Blocked. Covers the duda → enojo escalation on 3 repeated failures.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use covenant_lib::operator_registry::{Operator, OperatorId, VoiceTone};
use covenant_lib::storage::Storage;
use covenant_lib::teammate::runtime::TeammateRuntime;
use covenant_lib::teammate::task_supervisor::{MessageEmitter, TaskSupervisor};
use covenant_lib::teammate::{
    Sentiment, Task, TaskArchetype, TaskId, TaskMessage, TaskScope, TaskStatus,
};
use karl_blocks::BlockId;
use karl_session::{SessionEvent, SessionId};
use tokio::sync::broadcast;
use ulid::Ulid;

#[derive(Default)]
struct CapturingEmitter {
    msgs: Mutex<Vec<TaskMessage>>,
}

impl MessageEmitter for CapturingEmitter {
    fn emit_message(&self, msg: &TaskMessage) {
        self.msgs.lock().unwrap().push(msg.clone());
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

#[tokio::test(flavor = "multi_thread")]
async fn supervisor_emits_duda_then_enojo_on_repeated_failure() {
    let dir = tempfile::tempdir().unwrap();
    let storage = Arc::new(Storage::open(&dir.path().join("e2e.db")).expect("storage open"));

    // Need a real operator row for the FK on task / message.
    let op_id = OperatorId(Ulid::new());
    let operator = Operator {
        id: op_id,
        name: "Mibli".into(),
        emoji: "🤖".into(),
        color: "#6B7280".into(),
        tags: vec![],
        persona: "test".into(),
        escalate_threshold: 0.6,
        model: "claude-sonnet-4-6".into(),
        hard_constraints: "".into(),
        is_default: true,
        created_at_unix_ms: now_ms(),
        updated_at_unix_ms: now_ms(),
        xp: 0,
        voice: VoiceTone::default(),
        soul_path: None,
        soul_mtime_unix_ms: 0,
        github_access: covenant_lib::operator_registry::GithubAccess::Off,
    };
    storage
        .operator_insert(operator)
        .await
        .expect("insert operator");

    // Insert a task in Active status.
    let task_id = TaskId::new();
    let task = Task {
        id: task_id,
        operator_id: op_id,
        archetype: TaskArchetype::Do,
        title: "test".into(),
        body: "".into(),
        deliverable: "".into(),
        status: TaskStatus::Active,
        scope: TaskScope::default(),
        spawned_session: None,
        created_at_unix_ms: now_ms(),
        updated_at_unix_ms: now_ms(),
        completed_at_unix_ms: None,
        cost_usd_cents: 0,
    };
    storage
        .teammate_insert_task(&task)
        .await
        .expect("insert task");

    let runtime = Arc::new(TeammateRuntime::new());
    let emitter: Arc<dyn MessageEmitter> = Arc::new(CapturingEmitter::default());

    let supervisor = Arc::new(TaskSupervisor::new(
        storage.clone(),
        runtime.clone(),
        emitter,
    ));
    let session = SessionId::new();
    supervisor.register_task(session, task_id, op_id);

    let (tx, rx) = broadcast::channel::<SessionEvent>(64);
    supervisor.clone().spawn(rx);

    // Three identical failed BlockFinished events.
    for _ in 0..3 {
        tx.send(SessionEvent::BlockFinished {
            session,
            block: BlockId::new(),
            command: "cargo test".into(),
            cwd: std::path::PathBuf::from("/tmp"),
            exit_code: Some(1),
            duration_ms: 10,
            output_text: String::new(),
        })
        .expect("send");
    }

    // Poll storage for up to 2s for both sentiments to materialise.
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    let mut found_duda = false;
    let mut found_enojo = false;
    while std::time::Instant::now() < deadline {
        let msgs = storage
            .teammate_list_messages(op_id, 50)
            .await
            .expect("list messages");
        for m in &msgs {
            if let Some(s) = m.sentiment {
                if s == Sentiment::Duda {
                    found_duda = true;
                }
                if s == Sentiment::Enojo {
                    found_enojo = true;
                }
            }
        }
        if found_duda && found_enojo {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    assert!(found_duda, "expected at least one Duda TaskUpdate");
    assert!(found_enojo, "expected at least one Enojo TaskUpdate");

    let after = storage
        .teammate_get_task(task_id)
        .await
        .expect("get task")
        .expect("task exists");
    assert_eq!(after.status, TaskStatus::Blocked);
}
