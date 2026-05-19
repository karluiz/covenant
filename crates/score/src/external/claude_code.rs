use crate::{Context, LlmUsage, ModelSource, ScoreStore};
use serde::Deserialize;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};

const SOURCE: &str = "claude_code";

#[derive(Deserialize)]
struct Line {
    message: Option<Msg>,
}
#[derive(Deserialize)]
struct Msg {
    model: Option<String>,
    usage: Option<Usage>,
}
#[derive(Deserialize)]
struct Usage {
    #[serde(default)]
    input_tokens: u64,
    #[serde(default)]
    output_tokens: u64,
    #[serde(default)]
    cache_read_input_tokens: u64,
    #[serde(default)]
    cache_creation_input_tokens: u64,
}

pub fn candidate_files() -> Vec<PathBuf> {
    let Some(home) = dirs::home_dir() else {
        return vec![];
    };
    let root = home.join(".claude").join("projects");
    walkdir::WalkDir::new(&root)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|e| e.path().extension().and_then(|s| s.to_str()) == Some("jsonl"))
        .map(|e| e.path().to_path_buf())
        .collect()
}

pub fn poll_one(store: &ScoreStore, path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let path_s = path.to_string_lossy().to_string();
    let watermark = store.get_watermark(SOURCE, &path_s)?;
    let mut file = std::fs::File::open(path)?;
    let size = file.metadata()?.len();
    if size <= watermark {
        return Ok(());
    }
    file.seek(SeekFrom::Start(watermark))?;
    let reader = BufReader::new(&mut file);

    let ctx = Context::default();
    let mut new_offset = watermark;
    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        new_offset += line.len() as u64 + 1; // newline
        let parsed: Line = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let Some(msg) = parsed.message else { continue };
        let Some(usage) = msg.usage else { continue };
        let model = msg.model.unwrap_or_else(|| "unknown".into());
        store.append_llm_call(
            chrono::Utc::now().timestamp_millis(),
            ModelSource::External,
            Some("claude_code"),
            "anthropic",
            &model,
            LlmUsage {
                input: usage.input_tokens,
                output: usage.output_tokens,
                cache_read: usage.cache_read_input_tokens,
                cache_creation: usage.cache_creation_input_tokens,
            },
            &ctx,
        )?;
    }
    store.set_watermark(SOURCE, &path_s, new_offset)?;
    Ok(())
}
