//! ACP (Agent Client Protocol) client for `copilot --acp` — JSON-RPC 2.0
//! over child stdio, newline-delimited. Mirrors the [`crate::pi_rpc`]
//! layout; reuses its [`crate::pi_rpc::framer::LineFramer`].
//!
//! Layout:
//!   - [`protocol`] — inbound frame + `session/update` wire types (A0-1)
//!   - [`session`]  — `AcpSession` spawn / request / reader task (A0-2)
//!   - [`policy`]   — headless permission resolution via `safety` (A0-3)
//!   - [`run`]      — one-shot `run_task` orchestrator (A0-4)
//!
//! Spec: https://agentclientprotocol.com — but fixtures in tests were
//! captured from copilot 1.0.68 and win over the spec on any conflict.

pub mod perception;
pub mod policy; // Task 3
pub mod protocol;
pub mod run;
pub mod session; // Task 4

pub use perception::{
    build_judge_prompt, decide as perception_decide, parse_judge_reply, JudgeVerdict,
    PerceptionDecision,
};
pub use protocol::{
    AvailableCommand, ContentBlock, FrameKind, InboundFrame, PermissionOption, PermissionRequest,
    PermissionToolCall, RpcError, SessionNotification, SessionUpdate, ToolCallFields,
};
pub use run::{run_task, AcpRunOpts, AcpRunReport};
pub use session::{
    AcpError, AcpSession, AcpSessionEvent, AcpSpawnOpts, PermissionDecision, PermissionResolver,
}; // Task 4
