#![allow(unreachable_code, unused)]
use covenant_lib::operator_mind::{ParseFailure, ParseFailureReason};
use covenant_lib::telegram::outbound::{format_message, OutboundContext};
use karl_session::{EscalationKind, OperatorRef, ProjectRef};

fn main() {
    let pf = ParseFailure {
        session_id: "x".into(),
        reason: ParseFailureReason::NoJsonObject,
        raw_excerpt: String::new(),
    };
    let op: OperatorRef = unimplemented!();
    let proj: ProjectRef = unimplemented!();
    let ctx = OutboundContext {
        operator: &op,
        project: &proj,
        session_short: "S",
        kind: &EscalationKind::Blocked,
        summary: pf, // expected `&str`, got `ParseFailure`
        actions: &[],
    };
    let _ = format_message(&ctx);
}
