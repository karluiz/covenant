use crate::{Context, LlmUsage, ModelSource, ScoreStore};
use rusqlite::{Connection, OpenFlags};
use serde::Deserialize;
use std::path::{Path, PathBuf};

const SOURCE: &str = "opencode";

/// Shape of the JSON stored in OpenCode's `message.data` column. Only assistant
/// messages carry `tokens` + top-level `providerID`/`modelID`; user messages put
/// the model under a nested `model` object, which we ignore.
#[derive(Deserialize)]
struct Msg {
    role: String,
    #[serde(rename = "providerID")]
    provider_id: Option<String>,
    #[serde(rename = "modelID")]
    model_id: Option<String>,
    tokens: Option<Tokens>,
}
#[derive(Deserialize)]
struct Tokens {
    #[serde(default)]
    input: u64,
    #[serde(default)]
    output: u64,
    #[serde(default)]
    cache: Cache,
}
#[derive(Deserialize, Default)]
struct Cache {
    #[serde(default)]
    read: u64,
    #[serde(default)]
    write: u64,
}

/// OpenCode keeps a single SQLite DB at `~/.local/share/opencode/opencode.db`
/// (XDG path, used even on macOS). Honour `XDG_DATA_HOME` if set.
pub fn candidate_files() -> Vec<PathBuf> {
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|h| h.join(".local").join("share")));
    let Some(base) = base else { return vec![] };
    let db = base.join("opencode").join("opencode.db");
    if db.exists() {
        vec![db]
    } else {
        vec![]
    }
}

pub fn poll_one(store: &ScoreStore, path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let path_s = path.to_string_lossy().to_string();
    // Watermark holds the last `time_created` (ms) we ingested for this DB.
    let watermark = store.get_watermark(SOURCE, &path_s)?;

    // Open read-only so we never contend with a running OpenCode process.
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;

    let mut stmt = conn.prepare(
        "SELECT time_created, data FROM message
         WHERE time_created > ?1
         ORDER BY time_created ASC",
    )?;
    let rows = stmt.query_map([watermark as i64], |r| {
        Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
    })?;

    let ctx = Context::default();
    let mut new_watermark = watermark;
    for row in rows {
        let (time_created, data) = row?;
        new_watermark = new_watermark.max(time_created as u64);
        let msg: Msg = match serde_json::from_str(&data) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if msg.role != "assistant" {
            continue;
        }
        let Some(tokens) = msg.tokens else { continue };
        let provider = msg.provider_id.unwrap_or_else(|| "unknown".into());
        let model = msg.model_id.unwrap_or_else(|| "unknown".into());
        store.append_llm_call(
            time_created,
            ModelSource::External,
            Some("opencode"),
            &provider,
            &model,
            LlmUsage {
                input: tokens.input,
                output: tokens.output,
                cache_read: tokens.cache.read,
                cache_creation: tokens.cache.write,
            },
            &ctx,
        )?;
    }

    if new_watermark > watermark {
        store.set_watermark(SOURCE, &path_s, new_watermark)?;
    }
    Ok(())
}
