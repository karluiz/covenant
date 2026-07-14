# Canon Proactive Inscription with Review — design

**Date:** 2026-07-14
**Status:** approved for planning

## Problem

Today Canon only fills up two ways: content is **mined** from a repo (Context Miner) or authored by hand as files under `.covenant/canon/<kind>/` and then published to the org registry. There is no in-app "New" affordance, and any org member can publish straight to the org registry with no gate.

Two gaps follow:

1. **No proactive inscription.** A member who *knows* a convention, a rule, or a piece of context — and wants to share it with the org — has no in-product path. They must open a text editor outside Covenant and hand-write a markdown file with frontmatter. This shuts out the non-dev domain expert (compliance officer, architect, BA at an anchor company) entirely.
2. **No review.** An org that wants inscriptions vetted before they land in the shared registry cannot express that. Publish is direct, always.

The org use case Karluiz is imagining: *members contribute Canon kinds proactively, subject to review, before they enter the org registry.*

## Decisions (from brainstorming)

| Question | Decision |
|---|---|
| Who inscribes | Both dev and non-dev, day 1 → **in-app authoring is the path** (no repo required for non-devs). |
| Review gate | **Per-org policy.** Owner chooses `direct` (current behavior, default) or `review_required`. Backward-compatible. |
| Kinds in v1 | **Knowledge-first: skill + context** (pure markdown, serves the non-dev, is the anchor-company case). Subagents/commands/mcp = phase 2. Memory stays non-publishable. |
| Who reviews | **Owners** approve/reject with an optional note. No new role. |
| Authoring surface | **Structured form** per kind (fields, not frontmatter) + live preview of the compiled `SKILL.md`. Agent interview = phase 2. |
| Pending storage | **Server pending queue**: the submission lives on the server (`cdlc_packages.status='pending'`), so the non-dev needs no repo. Owner reviews from their app. |
| Owner awareness | **Passive badge** (reuse `spec-badge.ts`) on the Canon rail entry + a count on a new cockpit nav section. No toasts/push/Telegram in v1. |

## Rejected approaches

- **Git-native (PR-like) review** — submit writes to a branch and opens a GitHub PR. Reuses GitHub review, but forces repo + push on every member (breaks the non-dev case) and ties Canon to GitHub. Rejected.
- **Hybrid (server queue for non-devs, direct repo publish for devs)** — two paths to maintain and reconcile; more surface than v1 needs. Rejected — the single server-queue path already serves the dev (who still gets the repo file) and the non-dev.
- **Always-required review** — breaks the current direct-publish flow and adds friction to two-person teams. Rejected in favor of the per-org policy toggle.
- **Push/Telegram notification in v1** — the infra exists in the repo, but for "inscription with review" the owner already opens Canon; a passive badge suffices. Deferred to phase 2 (e.g. a pending item parked N days).
- **Raw markdown editor for authoring** — minimal, but exposes the non-dev to frontmatter/structure, contradicting "both, day 1". Rejected in favor of the structured form.

## The conceptual model

Today there is one verb: **publish** (member → registry, direct). We add an intermediate state and a second verb:

- **Submit** (member → *pending*): the member inscribes something. If the org is `review_required`, it enters the queue as `pending`. If `direct` (default), it publishes exactly as today.
- **Approve / Reject** (owner → *published* / *rejected*): the owner resolves a pending item. Approve → visible/installable in the registry. Reject → closed with an optional note.

An inscribed package therefore carries a **status**: `pending | published | rejected`. The Registry section (which already exists) shows only `published` — nothing changes for whoever installs. `pending` items live in a new **Review queue** visible only to owners.

Key design stance: **this is not a new system, it is a `status` column on `cdlc_packages` plus a `review_policy` column on `orgs`.** The pending package *is* the package — same payload (`skill_toml`/`skill_md`), same table, just `status='pending'` and invisible until approved. This keeps the diff small and avoids a parallel queue table to reconcile.

Product vocabulary (English-first, per repo rule): the member button reads **"Submit for review"** when the org is `review_required`, **"Publish"** when `direct`. The owner's queue is **"Review"**.

## Architecture — server (covenant-server)

Mirror of `marketplace.rs` / `cdlc.rs`: axum + sqlx runtime queries (not `query!` macro → builds offline) + Postgres + JWT HS256 (`Claims.sub = github_id`).

### Migration

> **Migration number:** to be confirmed against server main. A *spec share & review* plan already claimed `0009`, so this is likely `0010`. Do not hardcode until the working tree of covenant-server is checked.

- `cdlc_packages` gains:
  - `status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('pending','published','rejected'))` — the `published` default keeps **every existing row visible**: backward-compatible, no backfill.
  - `reviewed_by BIGINT NULL`, `review_note TEXT NULL`, `reviewed_at TIMESTAMPTZ NULL` — decision attribution. The submitter identity is already carried by the existing `publisher_login`.
- `orgs` gains `review_policy TEXT NOT NULL DEFAULT 'direct' CHECK (review_policy IN ('direct','review_required'))` — the `direct` default = today's behavior.

The existing `UNIQUE(org_id, kind, name, version)` constraint is retained.

### Endpoints (all JWT + membership-gated, as today)

1. **Existing publish, now policy-aware.** No separate `submit` endpoint. Today's `canon_publish` reads the org's policy: `direct` → insert `status='published'` (identical to today); `review_required` → insert `status='pending'`. The **response** reports which happened (`{queued: true}` vs published), so the client toast switches between "Published" and "Submitted for review". One code path, minimal diff.

2. **`GET /cdlc/pending?org=`** — lists an org's `pending` packages, **owner-gated** (`require_owner`). Returns submitter, kind, name, version, description, submitted_at. This is the Review queue.

3. **`POST /cdlc/review`** — body `{org, kind, name, version, decision: "approve"|"reject", note?}`, owner-gated. `approve` → `status='published'` + `reviewed_by`/`reviewed_at`. `reject` → `status='rejected'` + `review_note`. Approve does **not** re-validate the payload (validated at submit time, same validation as today's publish); it only flips the state.

4. **`POST /orgs/:slug/policy`** (or `PATCH /orgs/:slug`) — owner sets `review_policy`. Owner-gated.

### The security invariant (the one that matters)

`search` and `resolve`/`install` gain `AND status='published'`. A `pending` package is **never** searchable or installable. If this filter fails, a member smuggles unreviewed content into the org registry — the only failure with real consequence. It must be tested.

### Badge + label in one call

Extend the payload that `cdlc_my_orgs` already returns so each org carries:
- `review_policy` → the member button knows whether it says "Publish" or "Submit for review".
- `pending_count` → the owner's badge number (computed for owners; `0` for members).

One fetch the client already makes on Canon open yields both. No separate count endpoint, no polling.

### Resubmit after rejection

The `UNIQUE(org_id, kind, name, version)` still holds. On submit, if a row with that tuple exists: `rejected` → UPDATE it back to `pending` with the new payload (legitimate resubmission); `published` or `pending` → 409 (`already published` / `already pending`). Clean, no forced version bump.

## Architecture — client (karlTerminal)

### Rust (`crates/app/src/cdlc_registry.rs`, reuses the score-sync JWT)

- `canon_publish` — unchanged except it reads `{queued}` from the response and returns it to the UI.
- `canon_review_pending(org) -> Vec<PendingPkg>` — new tauri command, mirror of the existing `cdlc_*` clients.
- `canon_review_decide(org, kind, name, version, decision, note?)` — new tauri command.
- `canon_set_review_policy(org, policy)` — new tauri command.
- The orgs payload struct in `api.ts` (`cdlc_my_orgs`) gains `review_policy` + `pending_count`.

### UI — four surfaces, all inside the existing cockpit

**1. Authoring — the structured form (the "New" door that doesn't exist today).** In the cockpit's Skills and Context sections, a header action **"New"** (the same slot "New context" already uses, `view.ts:185`). Opens a full-screen form (create-org/operator pattern) with fields per kind:
- *Skill*: name · "when to use" (one line) · body (light markdown, textarea) → compiles to `SKILL.md` + `skill.toml`.
- *Context*: name · summary (always-on block) · body → same compile the miner uses.
- Right panel: **live preview of the compiled `SKILL.md`** (reuses `render_skill_md` in `crates/cdlc/compile.rs`). The non-dev fills fields, never sees frontmatter.
- Submit button label: **"Publish"** or **"Submit for review"** per the active org's `review_policy`. On submit it writes the file to `.covenant/canon/<kind>/` **and** calls publish in one step (the dev still gets the repo file; the non-dev needn't know it exists).

**2. Review queue — a new "Review" section in the cockpit nav.** Owner-only, and only rendered when `pending_count > 0`. Lists `PendingPkg` as cards (reuse `skillCard`): submitter · kind · name · content preview (the `fetchPreview` cards already support). Each card: **Approve** / **Reject** (Reject reveals an inline note input). On resolve, refetch → card leaves the queue and the badge drops.

**3. The badge.** Reuses `spec-badge.ts` (icon + count, auto-hides at zero). Hangs off the Canon rail entry; number = sum of `pending_count` across orgs where the user is owner. Refetch on rail-open and after each decision. No polling.

**4. Policy toggle — in the Org section.** Owner-only control "Registry submissions: **Direct publish** / **Requires review**" (a `CustomSelect` or two radios) → `canon_set_review_policy`. The Org section already renders for owners (inline rename exists), so this needs no new surface.

## Data flow (member non-dev, org `review_required`)

1. Owner enabled "Requires review" in Org → `orgs.review_policy='review_required'`.
2. Member opens cockpit → Context → **"New"** → fills name/summary/body → sees the compiled preview.
3. Submit → writes `.covenant/canon/context/<name>.md` + calls `canon_publish` → server sees policy → inserts `status='pending'` → responds `{queued:true}` → toast **"Submitted for review"**.
4. Owner opens Canon → **badge `● 1`** on the rail (arrived in `cdlc_my_orgs.pending_count`).
5. Owner → cockpit → **Review** → card with preview → **Approve** → `canon_review_decide(...,approve)` → `status='published'`, `reviewed_by` sealed → card leaves, badge → 0.
6. The package appears in **Registry**, installable by any member. Loop closed.

**Dev / `direct` org:** step 3 responds published, toast "Published", no queue. **Identical to today** — the backward-compat guarantee.

## Error handling (reuses `friendlyError`, which already maps 403/404 to member-flow copy)

- Submit of something already `published` → 409 → toast "already published (unchanged)".
- Submit over own `pending` → 409 "already pending review".
- Submit over a `rejected` → UPDATE to `pending` (resubmit), toast "Resubmitted for review".
- Member tries to open Review / approve → 403 (owner-gated server-side; the Review section also doesn't render client-side, but the server is the authority).
- Reject with no note → allowed (note optional); the card just confirms.
- Preview of a pending item fails to load → inline note, does not break the queue.

## Testing

- **Server** (mirror `cdlc.rs`): happy path submit→pending→approve→published→installable; reject→note→not-installable→resubmit→pending; `policy=direct` publishes directly (regression); member cannot approve (403); **pending absent from search/resolve** (the invariant); `pending_count` correct per owner and `0` for member.
- **Client Rust**: `canon_review_decide` seals `reviewed_by`; `canon_publish` propagates `{queued}`.
- **UI** (vitest, `view.test.ts` pattern): "New" opens the form; submit-label reflects policy; Review section only with `pending_count>0` and owner role; badge sums orgs; Approve/Reject refetch.

## Scope & build order

One implementation plan, two repos (covenant-server + karlTerminal). **Server-first** (migration + endpoints + tests), because the client depends on the `{queued}` response and the extended orgs payload.

### Explicitly out of scope (v1)

- MCP / subagent / command authoring editors (phase 2 — v1 is skill + context).
- Dedicated `reviewer` role (v1 = owners review).
- Push / Telegram notification (v1 = passive badge).
- Edit-in-review / editorial merge by the owner.
- Making memory or specs publishable to the registry.

### Related work

- `docs/superpowers/specs/2026-07-14-spec-share-review-design.md` — a *distinct* system (public-link review of specs by external reviewers, `shared_specs` table). No migration/column collision with this design; shares only the word "review".
- Context Miner (`crates/agent/context_miner.rs`) — the repo-mining authoring path this complements. The phase-2 "agent interview" authoring mode would build on it.
