use crate::{Context, LlmUsage, ModelSource, ScoreStore};
use serde::Deserialize;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};

const SOURCE: &str = "codex";

#[derive(Deserialize)]
struct Line { model: Option<String>, usage: Option<Usage> }
#[derive(Deserialize)]
struct Usage {
    #[serde(default)] prompt_tokens: u64,
    #[serde(default)] completion_tokens: u64,
}

pub fn candidate_files() -> Vec<PathBuf> {
    let Some(home) = dirs::home_dir() else { return vec![]; };
    let root = home.join(".codex").join("sessions");
    walkdir::WalkDir::new(&root).into_iter().filter_map(Result::ok)
        .filter(|e| e.path().extension().and_then(|s| s.to_str()) == Some("jsonl"))
        .map(|e| e.path().to_path_buf())
        .collect()
}

pub fn poll_one(store: &ScoreStore, path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let path_s = path.to_string_lossy().to_string();
    let watermark = store.get_watermark(SOURCE, &path_s)?;
    let mut file = std::fs::File::open(path)?;
    let size = file.metadata()?.len();
    if size <= watermark { return Ok(()); }
    file.seek(SeekFrom::Start(watermark))?;
    let reader = BufReader::new(&mut file);

    let ctx = Context::default();
    let mut new_offset = watermark;
    for line in reader.lines() {
        let line = match line { Ok(l) => l, Err(_) => break };
        new_offset += line.len() as u64 + 1;
        let Ok(parsed) = serde_json::from_str::<Line>(&line) else { continue };
        let Some(usage) = parsed.usage else { continue };
        let model = parsed.model.unwrap_or_else(|| "unknown".into());
        store.append_llm_call(
            chrono::Utc::now().timestamp_millis(),
            ModelSource::External, Some("codex"), "openai", &model,
            LlmUsage { input: usage.prompt_tokens, output: usage.completion_tokens, cache_read: 0, cache_creation: 0 },
            &ctx,
        )?;
    }
    store.set_watermark(SOURCE, &path_s, new_offset)?;
    Ok(())
}
