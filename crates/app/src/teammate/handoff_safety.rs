//! Pure decision gate for operator→operator handoff. No I/O — the router
//! gathers chain/runtime facts and asks `decide`. Mirrors the discipline of
//! `crates/agent/src/safety.rs`: removing a check requires a justifying
//! review comment.

use crate::operator_registry::OperatorId;

pub const MAX_DEPTH: u8 = 4;
pub const MAX_CHAIN_INFLIGHT: usize = 8;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HandoffReject {
    SelfHandoff,
    UnknownOperator,
    ReceiverBusy,
    DepthExceeded { depth: u8, max: u8 },
    Cycle { operator: OperatorId },
    ChainSaturated { inflight: usize, max: usize },
}

impl HandoffReject {
    pub fn message(&self) -> String {
        match self {
            HandoffReject::SelfHandoff => "cannot hand off to yourself".into(),
            HandoffReject::UnknownOperator => "no operator by that name".into(),
            HandoffReject::ReceiverBusy => "receiver is busy on another task; retry later".into(),
            HandoffReject::DepthExceeded { depth, max } =>
                format!("delegation chain too deep ({depth} ≥ {max})"),
            HandoffReject::Cycle { .. } => "delegation would form a cycle".into(),
            HandoffReject::ChainSaturated { inflight, max } =>
                format!("delegation chain saturated ({inflight} ≥ {max} in flight)"),
        }
    }
}

/// Facts the router supplies. `chain_from_ops` is the ordered list of
/// `from_operator_id`s already in this chain (used for cycle detection).
pub struct GateInput {
    pub from: OperatorId,
    pub to: Option<OperatorId>,      // None = name didn't resolve
    pub self_handoff: bool,
    pub receiver_busy: bool,
    pub next_depth: u8,
    pub chain_from_ops: Vec<OperatorId>,
    pub chain_inflight: usize,
}

pub fn decide(i: &GateInput) -> Result<(), HandoffReject> {
    let to = match i.to {
        None => return Err(HandoffReject::UnknownOperator),
        Some(t) => t,
    };
    if i.self_handoff || to == i.from {
        return Err(HandoffReject::SelfHandoff);
    }
    if i.next_depth >= MAX_DEPTH {
        return Err(HandoffReject::DepthExceeded { depth: i.next_depth, max: MAX_DEPTH });
    }
    if i.chain_from_ops.contains(&to) {
        return Err(HandoffReject::Cycle { operator: to });
    }
    if i.chain_inflight >= MAX_CHAIN_INFLIGHT {
        return Err(HandoffReject::ChainSaturated { inflight: i.chain_inflight, max: MAX_CHAIN_INFLIGHT });
    }
    if i.receiver_busy {
        return Err(HandoffReject::ReceiverBusy);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn op() -> OperatorId { OperatorId(ulid::Ulid::new()) }

    fn base(from: OperatorId, to: OperatorId) -> GateInput {
        GateInput { from, to: Some(to), self_handoff: false, receiver_busy: false,
                    next_depth: 0, chain_from_ops: vec![], chain_inflight: 0 }
    }

    #[test]
    fn happy_path_ok() {
        let (a, b) = (op(), op());
        assert!(decide(&base(a, b)).is_ok());
    }
    #[test]
    fn rejects_self() {
        let a = op();
        let mut i = base(a, a);
        i.to = Some(a);
        assert_eq!(decide(&i), Err(HandoffReject::SelfHandoff));
    }
    #[test]
    fn rejects_unknown_operator() {
        let a = op();
        let mut i = base(a, op());
        i.to = None;
        assert_eq!(decide(&i), Err(HandoffReject::UnknownOperator));
    }
    #[test]
    fn rejects_depth() {
        let (a, b) = (op(), op());
        let mut i = base(a, b);
        i.next_depth = MAX_DEPTH;
        assert!(matches!(decide(&i), Err(HandoffReject::DepthExceeded { .. })));
    }
    #[test]
    fn rejects_cycle() {
        let (a, b) = (op(), op());
        let mut i = base(a, b);
        i.chain_from_ops = vec![b];
        assert!(matches!(decide(&i), Err(HandoffReject::Cycle { .. })));
    }
    #[test]
    fn rejects_saturated_chain() {
        let (a, b) = (op(), op());
        let mut i = base(a, b);
        i.chain_inflight = MAX_CHAIN_INFLIGHT;
        assert!(matches!(decide(&i), Err(HandoffReject::ChainSaturated { .. })));
    }
    #[test]
    fn rejects_busy_receiver() {
        let (a, b) = (op(), op());
        let mut i = base(a, b);
        i.receiver_busy = true;
        assert_eq!(decide(&i), Err(HandoffReject::ReceiverBusy));
    }
}
