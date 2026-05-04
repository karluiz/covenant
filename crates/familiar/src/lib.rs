//! Familiars — per-operator companion AI with persistent memory.
//!
//! See `docs/superpowers/specs/2026-05-04-familiars-design.md`.

pub mod agent;
pub mod cost;
pub mod directive;
pub mod error;
pub mod identity;
pub mod manager;
pub mod memory;
pub mod observer;
pub mod prompts;
pub mod summarizer;

pub use error::{FamiliarError, Result};
pub use identity::{Familiar, FamiliarConfig, FamiliarId, Style};
pub use manager::FamiliarManager;
