//! Local embedding model for operator learning (spec 3.13).
//!
//! Wraps `fastembed` BGE-small-en-v1.5 (384 dim). Lazy-loaded; first
//! call downloads the model (~30 MB) into the platform cache dir under
//! `fastembed-rs/`. All subsequent runs hit the cache.
//!
//! `embed()` is synchronous; callers should run it on
//! `tokio::task::spawn_blocking`.

// ── Embeddings ENABLED (default; Apple Silicon, Windows) ────────────────────
//
// The real fastembed/ONNX-Runtime path. Gated behind the `embeddings` feature
// because `ort` ships no `x86_64-apple-darwin` prebuilt — the Intel macOS
// release builds with `--no-default-features`, selecting the stub below.
#[cfg(feature = "embeddings")]
mod imp {
    use std::sync::Mutex;

    use anyhow::{anyhow, Result};
    use fastembed::{EmbeddingModel, InitOptions, TextEmbedding};

    pub struct Embedder {
        /// `TextEmbedding::embed` requires `&mut self` (it owns ONNX session
        /// state). We wrap it in a `Mutex` so the public API stays `&self`
        /// and the embedder can be shared via `Arc` across tasks.
        model: Mutex<TextEmbedding>,
    }

    impl Embedder {
        /// Output dimensionality of BGE-small-en-v1.5. Used to size the
        /// `vec0` virtual table column.
        pub const DIM: usize = 384;

        /// Initialize the embedder. Downloads the model on first call.
        /// Blocking — run on `spawn_blocking`.
        pub fn new() -> Result<Self> {
            let model = TextEmbedding::try_new(
                InitOptions::new(EmbeddingModel::BGESmallENV15).with_show_download_progress(false),
            )
            .map_err(|e| anyhow!("fastembed init failed: {e}"))?;
            Ok(Self {
                model: Mutex::new(model),
            })
        }

        /// Embed a single string. Returns a 384-dim float32 vector.
        pub fn embed(&self, text: &str) -> Result<Vec<f32>> {
            let mut guard = self
                .model
                .lock()
                .map_err(|_| anyhow!("embedder mutex poisoned"))?;
            let mut vecs = guard
                .embed(vec![text.to_string()], None)
                .map_err(|e| anyhow!("fastembed embed failed: {e}"))?;
            vecs.pop()
                .ok_or_else(|| anyhow!("fastembed returned empty result"))
        }
    }
}

// ── Embeddings DISABLED (Intel macOS, --no-default-features) ─────────────────
//
// Same public surface (`Embedder`, `DIM`, `new`, `embed`) so no call site
// changes. `new()` errors; every caller already downgrades embedder failures
// to a warn + skip, so the build runs fully minus semantic search.
#[cfg(not(feature = "embeddings"))]
mod imp {
    use anyhow::{bail, Result};

    pub struct Embedder {
        _private: (),
    }

    impl Embedder {
        /// Kept identical to the real build so vector-table sizing and any
        /// `DIM` reference still compile when embeddings are off.
        pub const DIM: usize = 384;

        pub fn new() -> Result<Self> {
            bail!("embeddings are disabled in this build (no ONNX Runtime for x86_64-apple-darwin)")
        }

        pub fn embed(&self, _text: &str) -> Result<Vec<f32>> {
            bail!("embeddings are disabled in this build")
        }
    }
}

pub use imp::Embedder;

#[cfg(all(test, feature = "embeddings"))]
mod tests {
    use super::*;

    /// First run downloads ~30 MB; subsequent runs are cached.
    #[test]
    fn embed_returns_384_dims() {
        let e = Embedder::new().expect("embedder init");
        let v = e.embed("hello world").expect("embed");
        assert_eq!(v.len(), Embedder::DIM);
        assert!(v.iter().all(|f| f.is_finite()));
    }
}
