//! Capability discovery for agent tooling (Claude Code, Copilot CLI, opencode, shared ~/.agents).
//!
//! Each tool gets its own adapter under `adapters/`. There is intentionally **no** unified
//! `Capability` trait — the shapes differ enough that abstraction leaks. See
//! `docs/superpowers/specs/2026-05-11-capabilities-browser.md`.

pub mod adapters;
pub mod frontmatter;
pub mod model;

pub use model::{Tool, Kind, CapabilityError, CapabilityResult};
