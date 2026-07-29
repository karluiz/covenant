---
description: Run the full gate — TS build, Vitest, cargo test, fmt and clippy — and report only what failed.
---

# green

Run, in order, stopping at the first failure:

```
npm run build          # TS type-check + Vite bundle
npm test               # Vitest — from the repo ROOT, not ui/
cargo test --workspace
cargo fmt --all
cargo clippy --workspace --all-targets
```

Report only failures, with the actual output. Do not summarize passes. Do not
fix anything unless asked.

Known gotchas: the Telegram tests hang under a broad `cargo test`; macOS has no
`timeout`. `main` carries pre-existing failures — name them as pre-existing
rather than attributing them to the branch.
