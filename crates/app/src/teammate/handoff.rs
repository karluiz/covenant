//! Operator→operator handoff router. Resolves the target, derives the
//! delegation chain, runs the safety gate, and (on accept) persists the
//! edge + creates the receiver Task, claiming the receiver in the runtime.
//! The UI attaches the spawned session later (Plan 2), exactly like the
//! propose_task confirm flow.

use std::sync::Arc;

use crate::operator_registry::{Operator, OperatorId};
use crate::storage::Storage;
use crate::teammate::handoff_safety::{self, GateInput, HandoffReject};
use crate::teammate::runtime::TeammateRuntime;
use crate::teammate::types::*;

/// What the caller needs to act on after routing.
pub struct RouteAccepted {
    pub handoff: Handoff,
    pub task: Task,
    pub executor: String,
}

pub enum RouteResult {
    Accepted(RouteAccepted),
    Rejected { handoff: Handoff, reason: HandoffReject },
}

/// Resolve `to_operator` name → id (case-insensitive, exact match) against
/// the current roster. Passing a slice (not the whole registry) keeps
/// `route` trivially unit-testable — the caller passes `registry.list()`.
fn resolve(roster: &[Operator], name: &str) -> Option<OperatorId> {
    roster.iter().find(|o| o.name.eq_ignore_ascii_case(name)).map(|o| o.id)
}

#[allow(clippy::too_many_arguments)]
pub async fn route(
    storage: &Arc<Storage>,
    runtime: &Arc<TeammateRuntime>,
    roster: &[Operator],
    from_operator_id: OperatorId,
    origin_thread_id: ThreadId,
    req: &HandoffRequest,
    now_ms: u64,
) -> Result<RouteResult, String> {
    // 1. Resolve target.
    let to = resolve(roster, &req.to_operator);

    // 2. Derive the delegation chain from the delegator's current task.
    let origin_task_id = match runtime.state(from_operator_id) {
        Some(OperatorState::OnTask { task, .. }) => Some(task),
        _ => None,
    };
    let parent = match origin_task_id {
        Some(t) => storage.teammate_get_handoff_by_task(t).await.map_err(|e| e.to_string())?,
        None => None,
    };
    let (chain_id, next_depth) = match &parent {
        Some(p) => (p.chain_id, p.depth.saturating_add(1)),
        None => (ChainId::new(), 0),
    };

    // 3. Gather chain facts for the gate.
    let chain = storage.teammate_list_handoffs_in_chain(chain_id).await.map_err(|e| e.to_string())?;
    let chain_from_ops: Vec<OperatorId> = chain.iter().map(|h| h.from_operator_id).collect();
    let chain_inflight = chain.iter().filter(|h| h.status == HandoffStatus::Running).count();
    let receiver_busy = matches!(
        to.and_then(|t| runtime.state(t)),
        Some(OperatorState::OnTask { .. })
    );

    let gate = GateInput {
        from: from_operator_id,
        to,
        self_handoff: to == Some(from_operator_id),
        receiver_busy,
        next_depth,
        chain_from_ops,
        chain_inflight,
    };

    // 4. Decide.
    if let Err(reason) = handoff_safety::decide(&gate) {
        let h = Handoff {
            id: HandoffId::new(), chain_id, depth: next_depth,
            from_operator_id, to_operator_id: to.unwrap_or(from_operator_id),
            task_id: None, origin_task_id, origin_thread_id,
            status: match reason {
                HandoffReject::DepthExceeded { .. } | HandoffReject::Cycle { .. }
                | HandoffReject::ChainSaturated { .. } => HandoffStatus::BlockedBySafety,
                _ => HandoffStatus::Rejected,
            },
            brief: req.brief.clone(), result_summary: Some(reason.message()),
            created_at_unix_ms: now_ms, reported_at_unix_ms: None,
        };
        storage.teammate_insert_handoff(&h).await.map_err(|e| e.to_string())?;
        return Ok(RouteResult::Rejected { handoff: h, reason });
    }

    let Some(to) = to else { return Err("handoff gate accepted a None target".into()); };

    // 5. Create the receiver task (mirrors confirm_task_inner's constructor).
    let title: String = req.brief.chars().take(80).collect();
    let task = Task {
        id: TaskId::new(),
        operator_id: to,
        archetype: TaskArchetype::Do,
        title,
        body: req.context.clone().unwrap_or_default(),
        deliverable: req.deliverable.clone(),
        status: TaskStatus::Active,
        scope: TaskScope::default(),
        spawned_session: None,
        created_at_unix_ms: now_ms,
        updated_at_unix_ms: now_ms,
        completed_at_unix_ms: None,
        cost_usd_cents: 0,
    };
    // Claim the receiver FIRST (prevents a second concurrent handoff winning).
    runtime.start_task(to, task.id, None).map_err(|e| e.to_string())?;

    let h = Handoff {
        id: HandoffId::new(), chain_id, depth: next_depth,
        from_operator_id, to_operator_id: to,
        task_id: Some(task.id), origin_task_id, origin_thread_id,
        status: HandoffStatus::Running,
        brief: req.brief.clone(), result_summary: None,
        created_at_unix_ms: now_ms, reported_at_unix_ms: None,
    };

    // Persist task + edge; on failure release the claim.
    let persisted = async {
        storage.teammate_insert_task(&task).await.map_err(|e| e.to_string())?;
        storage.teammate_insert_handoff(&h).await.map_err(|e| e.to_string())
    }.await;
    if let Err(e) = persisted {
        let _ = runtime.finish_task(to, task.id);
        return Err(e);
    }

    Ok(RouteResult::Accepted(RouteAccepted { handoff: h, task, executor: req.executor.clone() }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::operator_registry::{Operator, VoiceTone};

    fn mk_operator(name: &str) -> Operator {
        Operator {
            id: OperatorId(ulid::Ulid::new()),
            name: name.into(),
            emoji: "🤖".into(),
            color: "#000".into(),
            tags: vec![],
            persona: "".into(),
            escalate_threshold: 0.6,
            model: "x".into(),
            hard_constraints: "".into(),
            voice: VoiceTone::Terse,
            is_default: false,
            created_at_unix_ms: 0,
            updated_at_unix_ms: 0,
            xp: 0,
            soul_path: None,
            soul_mtime_unix_ms: 0,
            github_access: crate::operator_registry::GithubAccess::Off,
        }
    }

    async fn fixture() -> (Arc<Storage>, Arc<TeammateRuntime>, Vec<Operator>, OperatorId, OperatorId) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.sqlite");
        Box::leak(Box::new(dir));
        let storage = Arc::new(Storage::open(&path).unwrap());
        let runtime = Arc::new(TeammateRuntime::new());
        let zeta = mk_operator("Zeta");
        let kiro = mk_operator("Kiro");
        storage.operator_insert(zeta.clone()).await.unwrap();
        storage.operator_insert(kiro.clone()).await.unwrap();
        let (zid, kid) = (zeta.id, kiro.id);
        (storage, runtime, vec![zeta, kiro], zid, kid)
    }

    fn req(to: &str) -> HandoffRequest {
        HandoffRequest { to_operator: to.into(), brief: "do the thing".into(),
            deliverable: "thing done".into(), executor: "codex".into(), context: None }
    }

    #[tokio::test]
    async fn happy_path_creates_task_and_edge() {
        let (s, rt, roster, zeta, _kiro) = fixture().await;
        let r = route(&s, &rt, &roster, zeta, ThreadId::new(), &req("Kiro"), 100).await.unwrap();
        let acc = match r { RouteResult::Accepted(a) => a, _ => panic!("expected accept") };
        assert_eq!(acc.executor, "codex");
        let edge = s.teammate_get_handoff_by_task(acc.task.id).await.unwrap().unwrap();
        assert_eq!(edge.status, HandoffStatus::Running);
        assert_eq!(edge.depth, 0);
        assert!(matches!(rt.state(acc.task.operator_id), Some(OperatorState::OnTask { .. })));
    }

    #[tokio::test]
    async fn rejects_unknown_operator() {
        let (s, rt, roster, zeta, _kiro) = fixture().await;
        let r = route(&s, &rt, &roster, zeta, ThreadId::new(), &req("Nobody"), 100).await.unwrap();
        assert!(matches!(r, RouteResult::Rejected { reason: HandoffReject::UnknownOperator, .. }));
    }

    #[tokio::test]
    async fn rejects_self_handoff() {
        let (s, rt, roster, zeta, _kiro) = fixture().await;
        let r = route(&s, &rt, &roster, zeta, ThreadId::new(), &req("Zeta"), 100).await.unwrap();
        assert!(matches!(r, RouteResult::Rejected { reason: HandoffReject::SelfHandoff, .. }));
    }

    #[tokio::test]
    async fn rejects_busy_receiver() {
        let (s, rt, roster, zeta, kiro) = fixture().await;
        rt.start_task(kiro, TaskId::new(), None).unwrap();
        let r = route(&s, &rt, &roster, zeta, ThreadId::new(), &req("Kiro"), 100).await.unwrap();
        assert!(matches!(r, RouteResult::Rejected { reason: HandoffReject::ReceiverBusy, .. }));
    }
}
