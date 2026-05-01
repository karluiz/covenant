//! OSC 133 block parser and `Block` types for karl-terminal.
//!
//! M1 will land the actual parser. For now this crate exposes the type
//! skeleton so downstream crates can compile against it.

use serde::{Deserialize, Serialize};
use ulid::Ulid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct BlockId(pub Ulid);

impl BlockId {
    pub fn new() -> Self {
        Self(Ulid::new())
    }
}

impl Default for BlockId {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Display for BlockId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}
