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
    Rejected {
        handoff: Handoff,
        reason: HandoffReject,
    },
}

/// Lowercase, trim, dedup, and sort the union of all operators' tags — the
/// team's skill vocabulary. Advertised in the `handoff_task` tool schema so
/// the delegator can only request skills that exist.
pub fn skill_union(roster: &[Operator]) -> Vec<String> {
    let mut set: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for o in roster {
        for t in &o.tags {
            let s = t.trim().to_ascii_lowercase();
            if !s.is_empty() {
                set.insert(s);
            }
        }
    }
    set.into_iter().collect()
}

/// How many DISTINCT requested skills an operator covers (case-insensitive).
fn overlap_count(op_tags: &[String], required: &[String]) -> usize {
    let req: std::collections::HashSet<String> = required
        .iter()
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty())
        .collect();
    op_tags
        .iter()
        .map(|t| t.trim().to_ascii_lowercase())
        .filter(|t| req.contains(t))
        .collect::<std::collections::HashSet<_>>()
        .len()
}

/// Resolve the best-suited peer for `required` skills. Excludes `from`
/// (no self-handoff). Ranks candidates by `(available, overlap, xp)`
/// descending — availability outranks raw skill match so the work goes to
/// someone who can start now. Returns `None` when no operator overlaps
/// at least one requested skill.
fn resolve_by_skills(
    roster: &[Operator],
    required: &[String],
    from: OperatorId,
    is_available: impl Fn(OperatorId) -> bool,
) -> Option<OperatorId> {
    roster
        .iter()
        .filter(|o| o.id != from)
        .filter_map(|o| {
            let c = overlap_count(&o.tags, required);
            (c > 0).then_some((o, c))
        })
        // On a full tie across (available, overlap, xp), max_by_key returns the
        // last candidate in roster order (registry creation order). Acceptable —
        // ties this exact are rare and any equally-ranked peer is a valid pick.
        .max_by_key(|(o, c)| (is_available(o.id) as u8, *c, o.xp))
        .map(|(o, _)| o.id)
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
    // 1. Resolve target by capability — best-suited AVAILABLE peer, self excluded.
    let to = resolve_by_skills(roster, &req.required_skills, from_operator_id, |id| {
        !matches!(runtime.state(id), Some(OperatorState::OnTask { .. }))
    });

    // 2. Derive the delegation chain from the delegator's current task.
    let origin_task_id = match runtime.state(from_operator_id) {
        Some(OperatorState::OnTask { task, .. }) => Some(task),
        _ => None,
    };
    let parent = match origin_task_id {
        Some(t) => storage
            .teammate_get_handoff_by_task(t)
            .await
            .map_err(|e| e.to_string())?,
        None => None,
    };
    let (chain_id, next_depth) = match &parent {
        Some(p) => (p.chain_id, p.depth.saturating_add(1)),
        None => (ChainId::new(), 0),
    };

    // 3. Gather chain facts for the gate.
    let chain = storage
        .teammate_list_handoffs_in_chain(chain_id)
        .await
        .map_err(|e| e.to_string())?;
    let chain_from_ops: Vec<OperatorId> = chain.iter().map(|h| h.from_operator_id).collect();
    let chain_inflight = chain
        .iter()
        .filter(|h| h.status == HandoffStatus::Running)
        .count();
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
            id: HandoffId::new(),
            chain_id,
            depth: next_depth,
            from_operator_id,
            to_operator_id: to.unwrap_or(from_operator_id),
            task_id: None,
            origin_task_id,
            origin_thread_id,
            status: match reason {
                HandoffReject::DepthExceeded { .. }
                | HandoffReject::Cycle { .. }
                | HandoffReject::ChainSaturated { .. } => HandoffStatus::BlockedBySafety,
                _ => HandoffStatus::Rejected,
            },
            brief: req.brief.clone(),
            result_summary: Some(reason.message()),
            created_at_unix_ms: now_ms,
            reported_at_unix_ms: None,
        };
        storage
            .teammate_insert_handoff(&h)
            .await
            .map_err(|e| e.to_string())?;
        return Ok(RouteResult::Rejected { handoff: h, reason });
    }

    let Some(to) = to else {
        return Err("handoff gate accepted a None target".into());
    };

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
    runtime
        .start_task(to, task.id, None)
        .map_err(|e| e.to_string())?;

    let h = Handoff {
        id: HandoffId::new(),
        chain_id,
        depth: next_depth,
        from_operator_id,
        to_operator_id: to,
        task_id: Some(task.id),
        origin_task_id,
        origin_thread_id,
        status: HandoffStatus::Running,
        brief: req.brief.clone(),
        result_summary: None,
        created_at_unix_ms: now_ms,
        reported_at_unix_ms: None,
    };

    // Persist task + edge; on failure release the claim.
    let persisted = async {
        storage
            .teammate_insert_task(&task)
            .await
            .map_err(|e| e.to_string())?;
        storage
            .teammate_insert_handoff(&h)
            .await
            .map_err(|e| e.to_string())
    }
    .await;
    if let Err(e) = persisted {
        let _ = runtime.finish_task(to, task.id);
        return Err(e);
    }

    Ok(RouteResult::Accepted(RouteAccepted {
        handoff: h,
        task,
        executor: req.executor.clone(),
    }))
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
            acp_enabled: false,
            perception_enabled: false,
            org_slug: None,
        }
    }

    async fn fixture() -> (
        Arc<Storage>,
        Arc<TeammateRuntime>,
        Vec<Operator>,
        OperatorId,
        OperatorId,
    ) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.sqlite");
        Box::leak(Box::new(dir));
        let storage = Arc::new(Storage::open(&path).unwrap());
        let runtime = Arc::new(TeammateRuntime::new());
        let mut zeta = mk_operator("Zeta");
        zeta.tags = vec!["ops".into()];
        let mut kiro = mk_operator("Kiro");
        kiro.tags = vec!["rust".into()];
        storage.operator_insert(zeta.clone()).await.unwrap();
        storage.operator_insert(kiro.clone()).await.unwrap();
        let (zid, kid) = (zeta.id, kiro.id);
        (storage, runtime, vec![zeta, kiro], zid, kid)
    }

    fn req(skills: &[&str]) -> HandoffRequest {
        HandoffRequest {
            required_skills: skills.iter().map(|s| s.to_string()).collect(),
            brief: "do the thing".into(),
            deliverable: "thing done".into(),
            executor: "codex".into(),
            context: None,
        }
    }

    #[tokio::test]
    async fn happy_path_creates_task_and_edge() {
        let (s, rt, roster, zeta, _kiro) = fixture().await;
        let r = route(
            &s,
            &rt,
            &roster,
            zeta,
            ThreadId::new(),
            &req(&["rust"]),
            100,
        )
        .await
        .unwrap();
        let acc = match r {
            RouteResult::Accepted(a) => a,
            _ => panic!("expected accept"),
        };
        assert_eq!(acc.executor, "codex");
        let edge = s
            .teammate_get_handoff_by_task(acc.task.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(edge.status, HandoffStatus::Running);
        assert_eq!(edge.depth, 0);
        assert!(matches!(
            rt.state(acc.task.operator_id),
            Some(OperatorState::OnTask { .. })
        ));
    }

    #[tokio::test]
    async fn rejects_no_capable_operator() {
        let (s, rt, roster, zeta, _kiro) = fixture().await;
        let r = route(
            &s,
            &rt,
            &roster,
            zeta,
            ThreadId::new(),
            &req(&["python"]),
            100,
        )
        .await
        .unwrap();
        assert!(matches!(
            r,
            RouteResult::Rejected {
                reason: HandoffReject::NoCapableOperator,
                ..
            }
        ));
    }

    #[tokio::test]
    async fn excludes_delegator_from_routing() {
        // Only the delegator (Zeta) carries the skill → no peer matches → NoCapableOperator.
        let (s, rt, roster, zeta, _kiro) = fixture().await;
        let r = route(&s, &rt, &roster, zeta, ThreadId::new(), &req(&["ops"]), 100)
            .await
            .unwrap();
        assert!(matches!(
            r,
            RouteResult::Rejected {
                reason: HandoffReject::NoCapableOperator,
                ..
            }
        ));
    }

    #[tokio::test]
    async fn rejects_busy_receiver() {
        let (s, rt, roster, zeta, kiro) = fixture().await;
        rt.start_task(kiro, TaskId::new(), None).unwrap(); // Kiro (only "rust" peer) is busy
        let r = route(
            &s,
            &rt,
            &roster,
            zeta,
            ThreadId::new(),
            &req(&["rust"]),
            100,
        )
        .await
        .unwrap();
        assert!(matches!(
            r,
            RouteResult::Rejected {
                reason: HandoffReject::ReceiverBusy,
                ..
            }
        ));
    }

    fn with_skills(name: &str, tags: &[&str], xp: u64) -> Operator {
        let mut o = mk_operator(name);
        o.tags = tags.iter().map(|s| s.to_string()).collect();
        o.xp = xp;
        o
    }

    #[test]
    fn skill_union_normalizes_dedups_sorts() {
        let roster = vec![
            with_skills("A", &["Rust", "migrations"], 0),
            with_skills("B", &["rust", "UI"], 0),
        ];
        assert_eq!(
            super::skill_union(&roster),
            vec!["migrations", "rust", "ui"]
        );
    }

    #[test]
    fn overlap_is_case_insensitive_and_deduped() {
        let tags = vec!["Rust".to_string(), "rust".to_string(), "ui".to_string()];
        assert_eq!(super::overlap_count(&tags, &["RUST".into()]), 1);
        assert_eq!(
            super::overlap_count(&tags, &["rust".into(), "ui".into()]),
            2
        );
        assert_eq!(super::overlap_count(&tags, &["python".into()]), 0);
    }

    #[test]
    fn resolve_picks_highest_overlap() {
        let from = OperatorId(ulid::Ulid::new());
        let a = with_skills("A", &["rust"], 0);
        let b = with_skills("B", &["rust", "migrations"], 0);
        let roster = vec![a, b.clone()];
        let got =
            super::resolve_by_skills(&roster, &["rust".into(), "migrations".into()], from, |_| {
                true
            });
        assert_eq!(got, Some(b.id));
    }

    #[test]
    fn resolve_excludes_delegator() {
        let a = with_skills("A", &["rust"], 999);
        let roster = vec![a.clone()];
        let got = super::resolve_by_skills(&roster, &["rust".into()], a.id, |_| true);
        assert_eq!(got, None);
    }

    #[test]
    fn resolve_prefers_available_over_busy_at_equal_score() {
        let busy = with_skills("Busy", &["rust"], 1000);
        let free = with_skills("Free", &["rust"], 0);
        let from = OperatorId(ulid::Ulid::new());
        let roster = vec![busy.clone(), free.clone()];
        let got = super::resolve_by_skills(&roster, &["rust".into()], from, |id| id == free.id);
        assert_eq!(got, Some(free.id));
    }

    #[test]
    fn resolve_prefers_higher_xp_at_equal_score_and_availability() {
        let lo = with_skills("Lo", &["rust"], 10);
        let hi = with_skills("Hi", &["rust"], 90);
        let from = OperatorId(ulid::Ulid::new());
        let roster = vec![hi.clone(), lo]; // hi first: win must come from xp, not roster position
        let got = super::resolve_by_skills(&roster, &["rust".into()], from, |_| true);
        assert_eq!(got, Some(hi.id));
    }

    #[test]
    fn resolve_none_on_zero_overlap() {
        let a = with_skills("A", &["rust"], 0);
        let from = OperatorId(ulid::Ulid::new());
        let roster = vec![a];
        assert_eq!(
            super::resolve_by_skills(&roster, &["python".into()], from, |_| true),
            None
        );
    }
}
