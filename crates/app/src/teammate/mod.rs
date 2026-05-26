//! Teammate layer — first-class operator-as-teammate primitives.
//!
//! Phase 1 (v0.8.0): scaffolding only.
//! - Types for tasks, messages, artifacts, and the per-operator state machine.
//! - Storage methods (in `crate::storage`) that round-trip them.
//! - Runtime skeleton with the transition table and an empty event loop.
//! - Tauri commands stubs that read/write text-only messages.
//!
//! No LLM calls happen yet — that lands in Phase 2 (v0.8.1).

pub mod anthropic_http;
pub mod commands;
pub mod llm;
pub mod openai_http;
pub mod runtime;
pub mod sentiment_resolver;
pub mod tools;
pub mod types;
pub mod world_snapshot;

pub use runtime::TeammateRuntime;
pub use types::{
    ArtifactId, MessageContent, MessageId, OperatorState, Role, Sentiment, Task, TaskArchetype,
    TaskArtifact, TaskMessage, TaskScope, TaskStatus, TaskId, WatchPredicate,
};
