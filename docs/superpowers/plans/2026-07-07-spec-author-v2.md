# Spec Author v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the bespoke spec-author agent: real tools (regex grep, glob, git history), code-enforced `ask_user` question chips, propose-first prompt with self-review, and image attachments that travel into the published spec.

**Architecture:** All backend work stays in `crates/agent/src/spec_author/` (tools + stream loop + prompt) plus the Tauri command layer in `crates/app/src/lib.rs`. Frontend work stays in `ui/src/spec-chat/`. The six-section AOM contract, draft persistence model, and publish flow are unchanged.

**Tech Stack:** Rust (`regex` — already a workspace dep, `std::process::Command` for git, `base64` for image upload), TypeScript + Vitest.

**Spec:** `docs/superpowers/specs/2026-07-06-spec-author-v2-design.md`

## Global Constraints

- Spec author stays **read-only**: no write tools, no command execution beyond fixed-arg `git log`/`git show`.
- All file access through `safe_join` jail; git subprocess gets `current_dir(repo_root)` and validated args only (rev: `^[A-Za-z0-9_./~^-]+$`, path via `safe_join`). Never a shell string.
- Output caps: grep 200 hits, git output 32KiB, read_file 32KiB (unchanged).
- Secret masking (`mask_secrets`) applies to all tool feedback (unchanged path).
- Commits: one per feature-area (user preference), not per TDD step. Conventional Commits.
- Tests: `cargo test -p karl-agent` for backend; `npm test` from repo ROOT for frontend; `npm run build` for tsc.
- Deviation from spec (accepted): no vision-capability probing — images are always sent in multimodal format; a non-vision model surfaces the provider's API error through the existing error event.

---

### Task 1: Real tools (`tools.rs`)

**Files:**
- Modify: `crates/agent/src/spec_author/tools.rs`

**Interfaces produced:**
- `grep(root, pattern, dir, glob) -> Result<Vec<String>, ToolError>` — `pattern` is now a regex (falls back to literal escape on invalid regex), optional `glob` filename filter (`*` and `?` wildcards), cap 200.
- `glob_files(root, pattern) -> Result<Vec<String>, ToolError>` — filename matching over the bounded walker, returns relative paths, cap 200.
- `git_log(root, path: Option<&str>, n: usize) -> Result<String, ToolError>` — `git log --oneline -n<n> [-- <path>]`, n clamped to 20.
- `git_show(root, rev, path: Option<&str>) -> Result<String, ToolError>` — `git show <rev>[:<path>]` capped 32KiB. Rev validated by `^[A-Za-z0-9_./~^-]+$` and must not start with `-`.
- `tool_specs()` / `tool_specs_openai()` list 7 tools: grep (pattern/dir/glob), read_file, list_dir, glob, git_log, git_show, ask_user.
- `run_tool` handles the new names; `ask_user` is NOT executed here (stream loop intercepts it before `run_tool`).

**Steps:**
- [ ] Tests first: regex grep (`fn \w+` matches), glob filter (`*.rs` excludes .txt), glob tool, git_log/git_show against a scratch `git init` repo, rev-validation rejections (`--upload-pack=x`, `$(rm)`), cap enforcement.
- [ ] Implement. Glob matching: convert `*`/`?` to regex (anchored, escape the rest) — no new dependency.
- [ ] `cargo test -p karl-agent spec_author` green.

### Task 2: `ask_user` enforcement + Question event (`stream.rs`)

**Files:**
- Modify: `crates/agent/src/spec_author/stream.rs`

**Interfaces produced:**
- `SpecStreamEvent::Question { question: String, options: Vec<QuestionOption> }` where `QuestionOption { label: String, detail: Option<String> }` (serde snake_case, kind = `question`).
- In `step_streaming`: partition tool calls; run repo tools first (feedback as today). If ≥1 `ask_user`: take the FIRST, emit `Question` + `TurnDone{awaiting_user:true}` and END the turn. Extra `ask_user` calls are dropped; a feedback line `[ask_user dropped — only one question per turn]` is appended to the synthetic user feedback so the model learns.
- Transcript persistence: before ending the turn, append an Assistant message containing `<!--question:{"question":"…","options":[…]}-->` (JSON-escaped) so resume can rebuild the card and the model sees its own question on replay.
- If the same turn had repo tools AND ask_user, tool feedback is persisted as the usual synthetic user message BEFORE the question assistant message.

**Steps:**
- [ ] Tests: scripted dispatcher calls ask_user → Question event emitted, turn ends awaiting user; two ask_user in one turn → one Question + drop feedback; tools+ask_user ordering; question marker persisted in draft messages.
- [ ] Implement; keep `max_tokens` 8192, thinking config unchanged.
- [ ] `cargo test -p karl-agent` green.

### Task 3: Images — wire format + dispatchers + attach path

**Files:**
- Modify: `crates/agent/src/spec_author.rs` (DraftMessage), `stream.rs` (dispatchers), `crates/app/src/lib.rs` (`spec_author_stream_step` signature)

**Interfaces produced:**
- `ImageRef { path: String, media_type: String }`; `DraftMessage.images: Vec<ImageRef>` with `#[serde(default)]` (legacy drafts load fine).
- `spec_author_stream_step(app, state, draft_id, user_msg, cwd, images: Option<Vec<AttachedImage>>)` where `AttachedImage { data_b64: String, media_type: String }`. Backend decodes, writes `~/.covenant/spec-drafts/<draft-id>/img-<N>.<ext>` (N = count of existing), attaches ImageRefs to the user DraftMessage, and appends a text line per image to the user message: `\n[imagen adjunta #N — al publicar: docs/specs/assets/<draft-id>/img-N.<ext>]` so the model knows the canonical repo path for references.
- Anthropic dispatcher: when a message has images, content becomes an array: image blocks (`{type:"image",source:{type:"base64",media_type,data}}`) + text block. OpenAI dispatcher: content array with `image_url` data-URI parts + text part. Bytes loaded lazily from the stored path at request-build time; missing file → skip image, keep text.
- Caps: ≤5 images per message, ≤5MB each (reject oversized with command error).

**Steps:**
- [ ] Tests: DraftMessage serde round-trip with/without images (legacy JSON), Anthropic body builder includes image block, OpenAI body builder includes image_url part. Extract body-building into testable helpers `anthropic_messages_json(&[DraftMessage]) -> Vec<Value>` / `openai_messages_json(system, &[DraftMessage]) -> Vec<Value>`.
- [ ] Implement backend + command signature (`images` optional → old callers compile).
- [ ] `cargo test -p karl-agent && cargo check -p covenant` green.

### Task 4: Publish — materialize assets into the repo

**Files:**
- Modify: `crates/app/src/lib.rs` (new command `spec_author_materialize_assets`), `ui/src/api.ts`, `ui/src/spec-chat/index.ts`

**Interfaces produced:**
- Command `spec_author_materialize_assets(draft_id: String, repo_root: String) -> Vec<String>`: collects all ImageRefs across the draft's messages, copies files to `<repo_root>/docs/specs/assets/<draft-id>/img-N.<ext>` (create dirs), returns repo-relative paths. No-op empty vec when draft has no images. Rejects if `repo_root` is not a directory.
- `ui/src/api.ts`: `specAuthorMaterializeAssets(draftId, repoRoot): Promise<string[]>`; `specAuthorStreamStep` gains optional `images` param.
- `index.ts` onPublish: before `openWizardWithBody`, `await specAuthorMaterializeAssets(id, repoRoot).catch(() => [])` using the draft's repo root (available via loaded draft `repo_root` or `deps.getCwd()`).

**Steps:**
- [ ] Rust test for the copy helper (pure fn in spec_author.rs: `materialize_assets(base_dir, id, repo_root) -> Result<Vec<String>>`).
- [ ] Wire command + UI call.
- [ ] `cargo test -p karl-agent` green.

### Task 5: Prompt v2 (`prompt.md` rewrite)

**Files:**
- Modify: `crates/agent/src/spec_author/prompt.md`

Content requirements (full rewrite, keep: six-section template verbatim, section markers, `<spec>` emit contract, language rule):
- Phases EXPLORE → APPROACHES → CLARIFY → DRAFT → SELF-REVIEW → EMIT with hard rules:
  - APPROACHES mandatory: 2–3 concrete approaches w/ trade-offs + recommendation, delivered via `ask_user` (options = the approaches, recommended first with "(recomendado)").
  - Questions ONLY via `ask_user` tool (2–4 options; free text always available to the user). Open enumeration questions forbidden — propose a concrete default read from the code and ask to confirm/adjust.
  - SELF-REVIEW before emit: placeholders, contradictions, ambiguity, and re-verify every File-boundaries path exists via tools; fix silently, then emit.
- New tools documented: grep(regex+glob), glob, git_log, git_show.
- Images: attached images may arrive; wireframes must be translated into observable acceptance criteria; reference the announced `docs/specs/assets/<draft-id>/…` path in a `### Referencias visuales` subsection under Acceptance criteria when images informed the spec.

**Steps:**
- [ ] Rewrite prompt.
- [ ] `cargo test -p karl-agent` still green (prompt is include_str!, no code change).

### Task 6: Frontend — question chips, attachments, resume

**Files:**
- Modify: `ui/src/spec-chat/events.ts`, `stream-state.ts`, `activity-stream.ts`, `transcript.ts`, `immersive.ts`, `immersive.css`, `ui/src/api.ts`
- Tests: co-located `*.test.ts`

**Interfaces produced:**
- `events.ts`: `question` event `{ kind: 'question'; question: string; options: { label: string; detail?: string }[] }`; `tool` field widened to `string`; `SpecEventSource.send` gains `images?: { dataB64: string; mediaType: string }[]`.
- `stream-state.ts`: `question(): { question, options } | null` (set on `question` event, cleared on `addUserMessage`); question is also pushed into `messages()` timeline as `{ role: 'question', question, options, answered?: boolean }` so it survives scrollback; `turn_done` keeps it live.
- `activity-stream.ts`: renders a `.question-card` with option chip buttons (`label` + optional `detail`); host wires `onAnswer(label)` → same submit path as composer. Answered cards render inert (chips disabled).
- `transcript.ts`: parse `<!--question:{json}-->` assistant messages into question timeline items (answered = a later user message exists).
- `immersive.ts`: composer attachments — paste handler (`paste` event, clipboardData.items image blobs), drag-drop on the composer box (in-page `dragover`/`drop` won't fire for OS files in WKWebView — use Tauri `onDragDropEvent` if available, else file picker; picker button `+` always present), thumbnail chips with remove ×; canvas downscale to ≤1568px longest edge, JPEG/PNG preserved (canvas re-encode to original type, webp → png); cap 5; submit passes images and clears chips. User bubbles show thumbnail(s).
- Question card answer → `state.addUserMessage(label)` + `source.send(...)` (same as composer submit).

**Steps:**
- [ ] Vitest: stream-state question lifecycle (event → visible; answer → cleared+timeline), activity-stream renders chips and click fires callback, transcript question-marker parse (answered/unanswered), events mock passthrough.
- [ ] Implement + CSS (question card follows existing `.bubble`/`.tool` chip look; True-Dark rule: neutral lifts, no accent tints).
- [ ] `npm test` (root) green for spec-chat suites; `npm run build` green.

### Task 7: Verify + finish

- [ ] `cargo test -p karl-agent && cargo check --workspace` green; `cargo fmt --all && cargo clippy -p karl-agent --all-targets`.
- [ ] `npm test` from root green (15 pre-existing failures on main are known — compare against baseline).
- [ ] `npm run build` green.
- [ ] Commits (feature-grained): tools+stream (backend agent core), images backend + publish assets, prompt v2, frontend.
- [ ] Update memory + offer merge per finishing-a-development-branch.

## Self-review notes

- Spec coverage: tools (T1), ask_user code-enforced (T2), prompt phases/propose-first/self-review (T5), images composer→wire→dispatchers (T3, T6), publish copy + references (T4, T5), thinking (no-op, documented). ✔
- Deviation logged in Global Constraints: no vision-probing fallback note (send-always).
- Type consistency: `QuestionOption {label, detail}` used across stream.rs event, events.ts, activity-stream; `ImageRef {path, media_type}` backend-only; frontend sends `{dataB64, mediaType}` → command arg `AttachedImage {data_b64, media_type}` (serde rename handled by Tauri camelCase convention — verify at wiring time). ✔
