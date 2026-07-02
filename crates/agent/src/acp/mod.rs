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

pub mod protocol;
pub mod session;
pub mod policy;    // Task 3
pub mod run;       // Task 4

pub use protocol::{
    ContentBlock, FrameKind, InboundFrame, PermissionOption, PermissionRequest,
    PermissionToolCall, RpcError, SessionNotification, SessionUpdate, ToolCallFields,
};
pub use session::{AcpError, AcpSession, AcpSpawnOpts, PermissionResolver};
pub use run::{run_task, AcpRunOpts, AcpRunReport};                     // Task 4
