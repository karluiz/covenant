//! Pi RPC executor — JSONL protocol over stdin/stdout for the `pi` coding
//! agent (https://pi.dev). See
//! `docs/superpowers/specs/2026-05-16-pi-rpc-executor-design.md`.
//!
//! Layout:
//!   - [`framer`]   — byte-exact JSONL line framer (PI-0)
//!   - [`protocol`] — `PiCommand` / `PiEvent` / `PiResponse` wire types (PI-1)
//!   - [`session`]  — `PiSession` spawn / send / reader task (PI-1)

pub mod framer;
pub mod protocol;
pub mod session;

pub use framer::LineFramer;
pub use protocol::{
    AgentMessage, AssistantContent, AssistantMessage, BashExecutionMessage, CompactionReason,
    CompactionResult, DeltaEvent, MessageRole, PiCommand, PiEnvelope, PiEvent, PiResponse,
    PiSessionStats, PiState, StopReason, StreamingBehavior, ThinkingLevel, ToolResultContent,
    ToolResultMessage, UiMethod, UserMessage,
};
pub use session::{parse_session_stats, parse_state, PiSession, PiSpawnError, PiSpawnOpts};
