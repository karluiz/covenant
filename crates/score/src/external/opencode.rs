use crate::ScoreStore;
use std::path::{Path, PathBuf};

pub fn candidate_files() -> Vec<PathBuf> { vec![] }
pub fn poll_one(_store: &ScoreStore, _path: &Path) -> Result<(), Box<dyn std::error::Error>> { Ok(()) }
