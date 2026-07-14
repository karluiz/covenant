# Canon Proactive Inscription with Review — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let org members author Canon skills and context in-app and submit them to the org registry, gated by a per-org review policy where owners approve or reject before the item becomes installable.

**Architecture:** A `status` column (`pending|published|rejected`) on `cdlc_packages` plus a `review_policy` column (`direct|review_required`) on `orgs`. The existing publish endpoint becomes policy-aware; search/resolve filter to `published` only. Two new server endpoints (pending queue, review decision) and a policy setter. Desktop gains an authoring form, a Review cockpit section, a policy toggle, and a passive count badge. Server-first because the client depends on the extended orgs payload and the `queued` publish response.

**Tech Stack:** covenant-server (Rust/axum 0.7 + sqlx 0.8 runtime queries + Postgres + JWT HS256); karlTerminal desktop (Tauri, Rust `crates/app` + `crates/canon`, TypeScript `ui/src`, Vitest).

## Global Constraints

- **Two repos.** Server = `/Users/carlosgallardoarenas/Sources/covenant-server` (branch `main` lives in the worktree `/Users/carlosgallardoarenas/Sources/covenant-server-org-rename` at `11ebec1`; confirm which checkout is `main` with `git -C <dir> branch --show-current` before editing). Desktop = `/Users/carlosgallardoarenas/Sources/karlTerminal`.
- **Migration number = `0010`.** Main has `0008_package_kinds`; an in-flight spec-review branch claims `0009_spec_reviews`. Verify the highest existing number in `covenant-server/migrations/` before naming the file; use the next free integer.
- **sqlx uses RUNTIME queries** (`sqlx::query`, `sqlx::query_as`) — never the `query!` macro (the project builds offline).
- **JWT claims:** `claims.sub` = github_id (i64), `claims.login` = github login. `orgs::require_member` / `orgs::require_owner` are the auth gates.
- **App crate package name is `covenant`, not `app`:** run `cargo test -p covenant`. Canon crate is `karl-canon` (import path `karl_canon`).
- **UI rules:** English-first copy; chrome glyphs are inline SVG via `Icons.*`, never emoji; new panels use sharp corners (border-radius 0); no native tooltips (`attachTooltip`, never `element.title`).
- **Worktree discipline (desktop):** the dev build runs from the MAIN checkout, so HMR needs edits on main — but per repo policy all agent-driven edits happen in a git worktree. Pin every subagent to the absolute worktree path and assert the branch before editing; never let a fixer stray into the main checkout. Stage files explicitly (`git add <path>`), never `git add -A` (a `node_modules` symlink gets committed and clobbers main's deps).
- **`npm run typecheck` does not exist** (silently no-ops). Use `npx tsc --noEmit` from `ui/`. Run Vitest from the repo ROOT with `npm test`.
- **v1 kinds = skill + context only.** MCP/subagent/command authoring forms, a dedicated reviewer role, push/Telegram notification, edit-in-review, and publishable memory/specs are all out of scope.

---

## File Structure

**Server (covenant-server):**
- `migrations/0010_review.sql` — CREATE: `status`, `reviewed_by`, `review_note`, `reviewed_at` on `cdlc_packages`; `review_policy` on `orgs`.
- `src/cdlc.rs` — MODIFY: policy-aware `publish`; `status='published'` filter on `search`/`resolve`; NEW `pending` + `review` handlers; `PendingPkg`/`ReviewReq` types.
- `src/orgs.rs` — MODIFY: `OrgRow` gains `review_policy` + `pending_count`; `list_mine` fills them; NEW `set_policy` handler + `SetPolicyReq`.
- `src/main.rs` — MODIFY: register `GET /cdlc/pending`, `POST /cdlc/review`, `POST /orgs/:slug/policy`.

**Desktop Rust (karlTerminal):**
- `crates/canon/src/authored.rs` — CREATE: `write_authored_skill`, `write_authored_context`.
- `crates/canon/src/lib.rs` — MODIFY: `pub mod authored;` + re-exports.
- `crates/app/src/canon_registry.rs` — MODIFY: `Org` gains `review_policy`+`pending_count`; NEW `PendingPkg` struct + `list_pending`/`review_decide`/`set_policy` client fns.
- `crates/app/src/lib.rs` — MODIFY: NEW commands `canon_write_skill`, `canon_write_context`, `canon_review_pending`, `canon_review_decide`, `canon_set_review_policy`; register in `invoke_handler`.

**Desktop UI (karlTerminal):**
- `ui/src/api.ts` — MODIFY: `Org` type + `CanonPkgKind`; NEW wrappers + `PendingPkg` type.
- `ui/src/canon/cockpit/authoring.ts` — CREATE: `openAuthoringForm(opts)` full-screen structured form + live preview.
- `ui/src/canon/cockpit/view.ts` — MODIFY: `SectionKey` gains `"review"`; NEW Review section, "New" header actions on Skills+Context, policy toggle in Org section.
- `ui/src/canon/cockpit/cockpit.css` — MODIFY: authoring form + review card + policy toggle styles (sharp).
- `ui/src/main.ts` — MODIFY: pending-count badge on the Canon rail button.

---

# PHASE 1 — Server (covenant-server)

> Work in the checkout whose branch is `main`. Confirm first: `git -C /Users/carlosgallardoarenas/Sources/covenant-server-org-rename branch --show-current` → expect `main`. All `cargo`/`sqlx` commands below run from that directory. Server tests use `#[sqlx::test(migrations = "./migrations")]`, which spins an ephemeral Postgres DB per test (requires a reachable `DATABASE_URL` for the test harness — the existing suite already relies on this).

### Task 1: Migration 0010 — status + policy columns

**Files:**
- Create: `migrations/0010_review.sql`

**Interfaces:**
- Produces: `cdlc_packages.status` (`'pending'|'published'|'rejected'`, default `'published'`), `cdlc_packages.reviewed_by BIGINT NULL`, `cdlc_packages.review_note TEXT NULL`, `cdlc_packages.reviewed_at TIMESTAMPTZ NULL`, `orgs.review_policy` (`'direct'|'review_required'`, default `'direct'`).

- [ ] **Step 1: Write the migration**

Create `migrations/0010_review.sql`:

```sql
-- Proactive inscription with review: packages carry a lifecycle status,
-- orgs carry a submission policy. Defaults preserve today's behavior:
-- every existing row is 'published', every existing org is 'direct'.
ALTER TABLE cdlc_packages
  ADD COLUMN status TEXT NOT NULL DEFAULT 'published'
  CHECK (status IN ('pending','published','rejected'));
ALTER TABLE cdlc_packages ADD COLUMN reviewed_by  BIGINT REFERENCES users(github_id);
ALTER TABLE cdlc_packages ADD COLUMN review_note  TEXT;
ALTER TABLE cdlc_packages ADD COLUMN reviewed_at  TIMESTAMPTZ;

-- Speeds the owner's pending queue and the pending_count aggregate.
CREATE INDEX cdlc_packages_org_status ON cdlc_packages(org_id, status);

ALTER TABLE orgs
  ADD COLUMN review_policy TEXT NOT NULL DEFAULT 'direct'
  CHECK (review_policy IN ('direct','review_required'));
```

- [ ] **Step 2: Verify it applies cleanly**

Run: `sqlx migrate run` (or start the server, which runs migrations on boot) against a scratch DB.
Expected: `0010_review` applied, no error. `\d cdlc_packages` shows `status` with default `'published'`.

- [ ] **Step 3: Commit**

```bash
git add migrations/0010_review.sql
git commit -m "feat(server): migration 0010 — package status + org review policy"
```

---

### Task 2: Policy-aware publish + published-only reads (the security invariant)

**Files:**
- Modify: `src/cdlc.rs` (the `publish`, `search`, `resolve` handlers)

**Interfaces:**
- Consumes: `orgs::require_member(pool, slug, github_id) -> Result<(i64 org_id, String role)>`.
- Produces: `publish` returns JSON `{ "id": i64, "sha": String, "queued": bool }` (`queued=true` when the org policy routed it to `pending`). `search`/`resolve` only ever return `status='published'` rows.

- [ ] **Step 1: Write failing tests**

Add to the `#[cfg(test)] mod tests` block in `src/cdlc.rs`. These call the SQL directly (mirroring the orgs.rs test style) to prove the status routing and the read filter. Add a small seed helper at the top of the test module if one doesn't already exist:

```rust
    async fn seed_org(pool: &sqlx::PgPool, slug: &str, policy: &str) -> i64 {
        sqlx::query("INSERT INTO users(github_id, login, avatar_url) VALUES (1,'owner','') ON CONFLICT DO NOTHING")
            .execute(pool).await.unwrap();
        let (org_id,): (i64,) = sqlx::query_as(
            "INSERT INTO orgs(slug, name, owner_github_id, review_policy) VALUES ($1,$2,1,$3) RETURNING id")
            .bind(slug).bind(slug).bind(policy).fetch_one(pool).await.unwrap();
        sqlx::query("INSERT INTO org_members(org_id, github_id, role) VALUES ($1,1,'owner')")
            .bind(org_id).execute(pool).await.unwrap();
        org_id
    }

    async fn insert_pkg(pool: &sqlx::PgPool, org_id: i64, name: &str, status: &str) {
        sqlx::query(
            "INSERT INTO cdlc_packages
               (org_id, kind, name, version, description, skill_toml, skill_md, sha,
                publisher_github_id, publisher_login, status)
             VALUES ($1,'skill',$2,'1.0.0','','t','m','sha',1,'owner',$3)")
            .bind(org_id).bind(name).bind(status).execute(pool).await.unwrap();
    }

    #[sqlx::test(migrations = "./migrations")]
    async fn pending_pkg_is_hidden_from_search(pool: sqlx::PgPool) {
        let org_id = seed_org(&pool, "acme", "review_required").await;
        insert_pkg(&pool, org_id, "published-one", "published").await;
        insert_pkg(&pool, org_id, "pending-one", "pending").await;
        let names: Vec<(String,)> = sqlx::query_as(
            "SELECT DISTINCT ON (name) name FROM cdlc_packages
              WHERE org_id=$1 AND kind='skill' AND status='published'
              ORDER BY name, created_at DESC")
            .bind(org_id).fetch_all(&pool).await.unwrap();
        let names: Vec<String> = names.into_iter().map(|r| r.0).collect();
        assert!(names.contains(&"published-one".to_string()));
        assert!(!names.contains(&"pending-one".to_string()), "pending must not surface in search");
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p covenant-server pending_pkg_is_hidden_from_search`
Expected: FAIL — the current `search` query has no `status` filter, and the migration column may not yet be referenced. (If the column exists from Task 1, the raw-SQL test proves the filter clause is what we must add to the handler.)

- [ ] **Step 3: Make `publish` policy-aware**

In `src/cdlc.rs`, `publish`: after resolving `(org_id, _role)`, read the org policy and route the insert. Replace the existing INSERT block:

```rust
    let (org_id, _role) = orgs::require_member(&state.pool, req.org.trim(), claims.sub).await?;
    // ... existing name/kind/version/size validation unchanged ...
    let sha = sha256_hex(&req.skill_md);

    let policy: (String,) = sqlx::query_as("SELECT review_policy FROM orgs WHERE id = $1")
        .bind(org_id)
        .fetch_one(&state.pool)
        .await
        .map_err(|e| AppError::Internal(e.into()))?;
    let status = if policy.0 == "review_required" { "pending" } else { "published" };
    let queued = status == "pending";

    // Resubmit-after-reject: if a rejected row occupies this tuple, revive it
    // to the new status with the new payload. Else insert fresh. Published or
    // pending collisions fall through to the ON CONFLICT DO NOTHING → 409.
    let revived: Option<(i64,)> = sqlx::query_as(
        "UPDATE cdlc_packages
            SET status=$5, skill_toml=$6, skill_md=$7, sha=$8, description=$9,
                publisher_github_id=$10, publisher_login=$11, created_at=now(),
                reviewed_by=NULL, review_note=NULL, reviewed_at=NULL
          WHERE org_id=$1 AND kind=$2 AND name=$3 AND version=$4 AND status='rejected'
          RETURNING id",
    )
    .bind(org_id).bind(&req.kind).bind(name).bind(req.version.trim())
    .bind(status).bind(&req.skill_toml).bind(&req.skill_md).bind(&sha)
    .bind(req.description.trim()).bind(claims.sub).bind(&claims.login)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| AppError::Internal(e.into()))?;

    let id = if let Some((id,)) = revived {
        id
    } else {
        let row: Option<(i64,)> = sqlx::query_as(
            "INSERT INTO cdlc_packages
                (org_id, kind, name, version, description, skill_toml, skill_md, sha,
                 publisher_github_id, publisher_login, status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
             ON CONFLICT (org_id, kind, name, version) DO NOTHING RETURNING id",
        )
        .bind(org_id).bind(&req.kind).bind(name).bind(req.version.trim())
        .bind(req.description.trim()).bind(&req.skill_toml).bind(&req.skill_md)
        .bind(&sha).bind(claims.sub).bind(&claims.login).bind(status)
        .fetch_optional(&state.pool)
        .await
        .map_err(|e| AppError::Internal(e.into()))?;
        row.ok_or(AppError::Conflict("version already published".into()))?.0
    };
    Ok(Json(json!({ "id": id, "sha": sha, "queued": queued })))
```

- [ ] **Step 4: Add the `status='published'` filter to reads**

In `search`, add `AND status = 'published'` to the WHERE clause:

```rust
        "SELECT DISTINCT ON (name) id, kind, name, version, description, publisher_login, installs, sha
           FROM cdlc_packages
          WHERE org_id = $1 AND kind = $2 AND status = 'published'
            AND ($3::text IS NULL OR lower(name) LIKE $3 OR lower(description) LIKE $3)
          ORDER BY name, created_at DESC
          LIMIT 200",
```

In `resolve`, add `AND status='published'` to BOTH branches (the `latest` and the pinned-version query):

```rust
    // latest branch:
    "SELECT {cols} FROM cdlc_packages WHERE org_id=$1 AND name=$2 AND kind=$3 AND status='published' \
     ORDER BY created_at DESC LIMIT 1"
    // pinned branch:
    "SELECT {cols} FROM cdlc_packages WHERE org_id=$1 AND name=$2 AND version=$3 AND kind=$4 AND status='published'"
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test -p covenant-server -- cdlc`
Expected: PASS — `pending_pkg_is_hidden_from_search` green; existing `pkg_name_rules`, `sha_is_deterministic_hex`, `kind_rules` still green.

- [ ] **Step 6: Commit**

```bash
git add src/cdlc.rs
git commit -m "feat(server): policy-aware publish + published-only search/resolve"
```

---

### Task 3: Pending queue + review decision endpoints

**Files:**
- Modify: `src/cdlc.rs` (new `pending` + `review` handlers, new types)
- Modify: `src/main.rs` (routes)

**Interfaces:**
- Consumes: `orgs::require_owner(pool, slug, github_id) -> Result<i64 org_id>`.
- Produces:
  - `GET /cdlc/pending?org=<slug>` → `Json<Vec<PendingPkg>>` where `PendingPkg { id: i64, kind: String, name: String, version: String, description: String, publisher_login: String, submitted_at: String }`.
  - `POST /cdlc/review` body `{ org: String, kind: String, name: String, version: String, decision: "approve"|"reject", note: Option<String> }` → `Json<{ "ok": true }>`. Owner-gated.

- [ ] **Step 1: Write failing test**

Add to `src/cdlc.rs` tests:

```rust
    #[sqlx::test(migrations = "./migrations")]
    async fn approve_publishes_reject_hides(pool: sqlx::PgPool) {
        let org_id = seed_org(&pool, "acme", "review_required").await;
        insert_pkg(&pool, org_id, "kyc", "pending").await;
        // Approve → status flips to published, reviewer sealed.
        sqlx::query(
            "UPDATE cdlc_packages SET status='published', reviewed_by=1, reviewed_at=now()
              WHERE org_id=$1 AND kind='skill' AND name='kyc' AND version='1.0.0' AND status='pending'")
            .bind(org_id).execute(&pool).await.unwrap();
        let (status, reviewer): (String, Option<i64>) = sqlx::query_as(
            "SELECT status, reviewed_by FROM cdlc_packages WHERE org_id=$1 AND name='kyc'")
            .bind(org_id).fetch_one(&pool).await.unwrap();
        assert_eq!(status, "published");
        assert_eq!(reviewer, Some(1));
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p covenant-server approve_publishes_reject_hides`
Expected: FAIL until the migration columns exist (they do after Task 1) — this test then passes at the SQL level and guards the handler's shape. Keep it; it documents the approve contract.

- [ ] **Step 3: Add types + handlers**

In `src/cdlc.rs`:

```rust
#[derive(Serialize, sqlx::FromRow)]
pub struct PendingPkg {
    pub id: i64,
    pub kind: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub publisher_login: String,
    pub submitted_at: String,
}

#[derive(Deserialize)]
pub struct PendingQ {
    pub org: String,
}

#[derive(Deserialize)]
pub struct ReviewReq {
    pub org: String,
    pub kind: String,
    pub name: String,
    pub version: String,
    pub decision: String, // "approve" | "reject"
    #[serde(default)]
    pub note: Option<String>,
}

pub async fn pending(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<PendingQ>,
) -> Result<Json<Vec<PendingPkg>>> {
    let claims = jwt::verify(&state.jwt_secret, bearer(&headers)?)?;
    let org_id = orgs::require_owner(&state.pool, q.org.trim(), claims.sub).await?;
    let rows = sqlx::query_as::<_, PendingPkg>(
        "SELECT id, kind, name, version, description, publisher_login,
                to_char(created_at, 'YYYY-MM-DD\"T\"HH24:MI:SSZ') AS submitted_at
           FROM cdlc_packages
          WHERE org_id = $1 AND status = 'pending'
          ORDER BY created_at ASC
          LIMIT 200",
    )
    .bind(org_id)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| AppError::Internal(e.into()))?;
    Ok(Json(rows))
}

pub async fn review(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<ReviewReq>,
) -> Result<Json<Value>> {
    let claims = jwt::verify(&state.jwt_secret, bearer(&headers)?)?;
    let org_id = orgs::require_owner(&state.pool, req.org.trim(), claims.sub).await?;
    if !valid_kind(&req.kind) {
        return Err(AppError::BadRequest("invalid package kind".into()));
    }
    let new_status = match req.decision.as_str() {
        "approve" => "published",
        "reject" => "rejected",
        _ => return Err(AppError::BadRequest("decision must be approve or reject".into())),
    };
    let updated: Option<(i64,)> = sqlx::query_as(
        "UPDATE cdlc_packages
            SET status=$1, reviewed_by=$2, review_note=$3, reviewed_at=now()
          WHERE org_id=$4 AND kind=$5 AND name=$6 AND version=$7 AND status='pending'
          RETURNING id",
    )
    .bind(new_status)
    .bind(claims.sub)
    .bind(req.note.as_deref())
    .bind(org_id)
    .bind(&req.kind)
    .bind(req.name.trim())
    .bind(req.version.trim())
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| AppError::Internal(e.into()))?;
    updated.ok_or(AppError::NotFound)?;
    Ok(Json(json!({ "ok": true })))
}
```

- [ ] **Step 4: Register the routes**

In `src/main.rs`, after the existing `/cdlc/packages/:id/install` route:

```rust
        .route("/cdlc/pending", axum::routing::get(cdlc::pending))
        .route("/cdlc/review", axum::routing::post(cdlc::review))
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test -p covenant-server -- cdlc` and `cargo build`
Expected: PASS + clean build.

- [ ] **Step 6: Commit**

```bash
git add src/cdlc.rs src/main.rs
git commit -m "feat(server): pending queue + approve/reject review endpoints"
```

---

### Task 4: Org payload gains policy + pending_count; policy setter

**Files:**
- Modify: `src/orgs.rs` (`OrgRow`, `list_mine`, new `set_policy` + `SetPolicyReq`)
- Modify: `src/main.rs` (route)

**Interfaces:**
- Produces:
  - `OrgRow` JSON now includes `review_policy: String` and `pending_count: i64` (`0` for non-owners; count of `status='pending'` for owners).
  - `POST /orgs/:slug/policy` body `{ policy: "direct"|"review_required" }` → `{ "ok": true }`. Owner-gated.

- [ ] **Step 1: Write failing test**

Add to `src/orgs.rs` tests:

```rust
    #[sqlx::test(migrations = "./migrations")]
    async fn set_policy_gate_and_effect(pool: sqlx::PgPool) {
        sqlx::query("INSERT INTO users(github_id, login, avatar_url) VALUES (1,'owner',''),(2,'member','')")
            .execute(&pool).await.unwrap();
        let (org_id,): (i64,) = sqlx::query_as(
            "INSERT INTO orgs(slug, name, owner_github_id) VALUES ('acme','Acme',1) RETURNING id")
            .fetch_one(&pool).await.unwrap();
        sqlx::query("INSERT INTO org_members(org_id, github_id, role) VALUES ($1,1,'owner'),($1,2,'member')")
            .bind(org_id).execute(&pool).await.unwrap();
        // Member cannot set policy.
        assert!(super::require_owner(&pool, "acme", 2).await.is_err());
        // Owner can; effect persists.
        let id = super::require_owner(&pool, "acme", 1).await.unwrap();
        sqlx::query("UPDATE orgs SET review_policy=$1 WHERE id=$2")
            .bind("review_required").bind(id).execute(&pool).await.unwrap();
        let p: String = sqlx::query_scalar("SELECT review_policy FROM orgs WHERE id=$1")
            .bind(org_id).fetch_one(&pool).await.unwrap();
        assert_eq!(p, "review_required");
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p covenant-server set_policy_gate_and_effect`
Expected: PASS at SQL level once Task 1 migration exists (the raw-SQL test documents the contract). If the `review_policy` column is absent it FAILS — proving the dependency on Task 1.

- [ ] **Step 3: Extend `OrgRow` and `list_mine`**

In `src/orgs.rs`, extend the struct (keep `#[sqlx(default)]` for the post-query fields):

```rust
#[derive(Serialize, sqlx::FromRow)]
pub struct OrgRow {
    pub id: i64,
    pub slug: String,
    pub name: String,
    pub role: String,
    #[sqlx(default)]
    pub personal: bool,
    #[sqlx(default)]
    pub review_policy: String,
    #[sqlx(default)]
    pub pending_count: i64,
}
```

In `list_mine`, select `o.review_policy` in the query and fill `pending_count` in the existing post-processing loop:

```rust
    let mut rows = sqlx::query_as::<_, OrgRow>(
        "SELECT o.id, o.slug, o.name, m.role, false AS personal,
                o.review_policy, 0::bigint AS pending_count
           FROM orgs o
           JOIN org_members m ON m.org_id = o.id
          WHERE m.github_id = $1 ORDER BY o.name",
    )
    .bind(claims.sub)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| AppError::Internal(e.into()))?;
    for r in &mut rows {
        r.personal = r.slug == personal;
        if r.role == "owner" {
            let c: (i64,) = sqlx::query_as(
                "SELECT count(*) FROM cdlc_packages WHERE org_id=$1 AND status='pending'")
                .bind(r.id)
                .fetch_one(&state.pool)
                .await
                .map_err(|e| AppError::Internal(e.into()))?;
            r.pending_count = c.0;
        }
    }
    Ok(Json(rows))
```

- [ ] **Step 4: Add the `set_policy` handler**

In `src/orgs.rs`:

```rust
#[derive(Deserialize)]
pub struct SetPolicyReq {
    pub policy: String,
}

pub async fn set_policy(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(slug): Path<String>,
    Json(req): Json<SetPolicyReq>,
) -> Result<Json<Value>> {
    let claims = jwt::verify(&state.jwt_secret, bearer(&headers)?)?;
    if req.policy != "direct" && req.policy != "review_required" {
        return Err(AppError::BadRequest("invalid policy".into()));
    }
    let org_id = require_owner(&state.pool, slug.trim(), claims.sub).await?;
    sqlx::query("UPDATE orgs SET review_policy = $1 WHERE id = $2")
        .bind(&req.policy)
        .bind(org_id)
        .execute(&state.pool)
        .await
        .map_err(|e| AppError::Internal(e.into()))?;
    Ok(Json(json!({ "ok": true })))
}
```

- [ ] **Step 5: Register the route**

In `src/main.rs`, after `/orgs/:slug`:

```rust
        .route("/orgs/:slug/policy", axum::routing::post(orgs::set_policy))
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cargo test -p covenant-server -- orgs` and `cargo build`
Expected: PASS — new test green, existing `slug_rules`, `list_mine_autocreates_personal_org`, `rename_gate_requires_owner`, `ensure_personal_org_ignores_non_owner_membership` still green.

- [ ] **Step 7: Commit**

```bash
git add src/orgs.rs src/main.rs
git commit -m "feat(server): org review_policy + pending_count in payload; policy setter"
```

> **Deploy note (not a code step):** pushing covenant-server `main` triggers the prod deploy + runs migration 0010 against prod Postgres. Deploy is gated on the user; do not push. The desktop client (Phase 2+) can be developed against a local server (`DATABASE_URL` local Postgres) until then.

---

# PHASE 2 — Desktop Rust (karlTerminal)

> Per repo policy, do this in a git worktree (see `superpowers:using-git-worktrees`). Confirm the branch before every edit. `cargo test -p covenant` / `-p karl-canon`.

### Task 5: Authored-source writers in karl-canon

**Files:**
- Create: `crates/canon/src/authored.rs`
- Modify: `crates/canon/src/lib.rs`
- Test: inline `#[cfg(test)]` in `authored.rs`

**Interfaces:**
- Consumes: `crate::install::valid_pkg_name`, `crate::manifest::canon_dir`, `crate::types::SkillManifest`, `crate::CanonError`.
- Produces:
  - `pub fn write_authored_skill(repo_root: &Path, name: &str, when_to_use: &str, body_md: &str, overwrite: bool) -> Result<PathBuf, CanonError>` — writes `.covenant/canon/skills/<name>/{SKILL.md,skill.toml}`.
  - `pub fn write_authored_context(repo_root: &Path, name: &str, summary: &str, body_md: &str, overwrite: bool) -> Result<PathBuf, CanonError>` — writes `.covenant/canon/context/<name>.md`.

- [ ] **Step 1: Write failing tests**

Create `crates/canon/src/authored.rs`:

```rust
//! Write member-authored skills and context to `.covenant/canon/` from the
//! in-app structured form. Distinct from `compile.rs` (miner findings): the
//! body is free-form markdown the author typed, not category-grouped findings.

use crate::install::valid_pkg_name;
use crate::manifest::canon_dir;
use crate::types::SkillManifest;
use crate::CanonError;
use std::path::{Path, PathBuf};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skill_writes_package_with_frontmatter() {
        let tmp = std::env::temp_dir().join(format!("canon-auth-skill-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let dir = write_authored_skill(&tmp, "kyc-peru", "Onboarding a Peru customer", "Mask PII.", false).unwrap();
        let md = std::fs::read_to_string(dir.join("SKILL.md")).unwrap();
        assert!(md.starts_with("---\n"));
        assert!(md.contains("name: kyc-peru"));
        assert!(md.contains("Onboarding a Peru customer"));
        assert!(md.contains("Mask PII."));
        assert!(dir.join("skill.toml").exists());
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn context_writes_summary_frontmatter() {
        let tmp = std::env::temp_dir().join(format!("canon-auth-ctx-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let path = write_authored_context(&tmp, "sbs-rules", "SBS reporting floor", "Report within 24h.", false).unwrap();
        let md = std::fs::read_to_string(&path).unwrap();
        assert!(md.contains("summary: SBS reporting floor"));
        assert!(md.contains("Report within 24h."));
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn rejects_bad_name_and_existing() {
        let tmp = std::env::temp_dir().join(format!("canon-auth-bad-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        assert!(write_authored_context(&tmp, "../escape", "s", "b", false).is_err());
        write_authored_context(&tmp, "dup", "s", "b", false).unwrap();
        assert!(write_authored_context(&tmp, "dup", "s", "b2", false).is_err(), "no overwrite by default");
        write_authored_context(&tmp, "dup", "s", "b2", true).unwrap(); // overwrite ok
        std::fs::remove_dir_all(&tmp).ok();
    }
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `cargo test -p karl-canon authored`
Expected: FAIL — `write_authored_skill` / `write_authored_context` not defined.

- [ ] **Step 3: Implement the writers**

Add above the test module in `authored.rs`:

```rust
pub fn write_authored_skill(
    repo_root: &Path,
    name: &str,
    when_to_use: &str,
    body_md: &str,
    overwrite: bool,
) -> Result<PathBuf, CanonError> {
    if !valid_pkg_name(name) {
        return Err(CanonError::InvalidPackage(format!("invalid skill name: {name:?}")));
    }
    let dir = canon_dir(repo_root).join("skills").join(name);
    if dir.exists() && !overwrite {
        return Err(CanonError::InvalidPackage(format!("skill '{name}' already exists")));
    }
    std::fs::create_dir_all(&dir)?;
    let desc = when_to_use.trim();
    let md = format!(
        "---\nname: {name}\ndescription: {desc}\nversion: 1.0.0\n---\n\n# {name}\n\n{}\n",
        body_md.trim()
    );
    std::fs::write(dir.join("SKILL.md"), md)?;
    let manifest = SkillManifest {
        name: name.to_string(),
        version: "1.0.0".to_string(),
        owner: None,
        deps: Vec::new(),
    };
    std::fs::write(dir.join("skill.toml"), toml::to_string_pretty(&manifest)?)?;
    Ok(dir)
}

pub fn write_authored_context(
    repo_root: &Path,
    name: &str,
    summary: &str,
    body_md: &str,
    overwrite: bool,
) -> Result<PathBuf, CanonError> {
    if !valid_pkg_name(name) {
        return Err(CanonError::InvalidPackage(format!("invalid name: {name:?}")));
    }
    let dir = canon_dir(repo_root).join("context");
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(format!("{name}.md"));
    if path.exists() && !overwrite {
        return Err(CanonError::InvalidPackage(format!("context '{name}' already exists")));
    }
    let md = format!("---\nsummary: {}\n---\n{}\n", summary.trim(), body_md.trim());
    std::fs::write(&path, md)?;
    Ok(path)
}
```

- [ ] **Step 4: Export the module**

In `crates/canon/src/lib.rs`, add after `pub mod compile;`:

```rust
pub mod authored;
```

and add to the re-export list:

```rust
pub use authored::{write_authored_context, write_authored_skill};
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test -p karl-canon authored`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add crates/canon/src/authored.rs crates/canon/src/lib.rs
git commit -m "feat(canon): authored skill + context writers"
```

---

### Task 6: Registry client — pending/review/policy + extended Org

**Files:**
- Modify: `crates/app/src/canon_registry.rs`

**Interfaces:**
- Consumes: `send_authed`, `client`, `auth::backend_url`, `urlencoding` (all existing in this file).
- Produces:
  - `Org` struct gains `review_policy: String` (default `"direct"`) and `pending_count: i64` (default `0`).
  - `pub struct PendingPkg { id: i64, kind: String, name: String, version: String, description: String, publisher_login: String, submitted_at: String }`.
  - `pub async fn list_pending(org: &str) -> Result<Vec<PendingPkg>, String>`.
  - `pub async fn review_decide(org, kind, name, version, decision, note: Option<&str>) -> Result<(), String>`.
  - `pub async fn set_policy(org: &str, policy: &str) -> Result<(), String>`.

- [ ] **Step 1: Extend the `Org` struct**

In `crates/app/src/canon_registry.rs`, add fields to `Org`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Org {
    pub id: i64,
    pub slug: String,
    pub name: String,
    pub role: String,
    #[serde(default)]
    pub personal: bool,
    #[serde(default = "default_policy")]
    pub review_policy: String,
    #[serde(default)]
    pub pending_count: i64,
}

fn default_policy() -> String {
    "direct".to_string()
}
```

- [ ] **Step 2: Add `PendingPkg` + client functions**

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingPkg {
    pub id: i64,
    #[serde(default = "default_kind")]
    pub kind: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub description: String,
    pub publisher_login: String,
    pub submitted_at: String,
}

pub async fn list_pending(org: &str) -> Result<Vec<PendingPkg>, String> {
    let url = format!("{}/cdlc/pending?org={}", auth::backend_url(), urlencoding(org));
    send_authed(|j| client().get(&url).bearer_auth(j))
        .await?
        .json()
        .await
        .map_err(|e| e.to_string())
}

pub async fn review_decide(
    org: &str,
    kind: &str,
    name: &str,
    version: &str,
    decision: &str,
    note: Option<&str>,
) -> Result<(), String> {
    let url = format!("{}/cdlc/review", auth::backend_url());
    let body = serde_json::json!({
        "org": org, "kind": kind, "name": name, "version": version,
        "decision": decision, "note": note,
    });
    send_authed(|j| client().post(&url).bearer_auth(j).json(&body)).await?;
    Ok(())
}

pub async fn set_policy(org: &str, policy: &str) -> Result<(), String> {
    let url = format!("{}/orgs/{}/policy", auth::backend_url(), urlencoding(org));
    let body = serde_json::json!({ "policy": policy });
    send_authed(|j| client().post(&url).bearer_auth(j).json(&body)).await?;
    Ok(())
}
```

- [ ] **Step 3: Verify it compiles**

Run: `cargo build -p covenant`
Expected: clean build (the existing `urlencoding_escapes_unsafe` test still passes; no new logic to unit-test here — these are thin HTTP wrappers like their neighbors).

- [ ] **Step 4: Commit**

```bash
git add crates/app/src/canon_registry.rs
git commit -m "feat(app): registry client — pending/review/policy + Org policy fields"
```

---

### Task 7: Tauri commands — write, review, policy

**Files:**
- Modify: `crates/app/src/lib.rs`

**Interfaces:**
- Consumes: `canon_registry::{list_pending, review_decide, set_policy, PendingPkg}`, `karl_canon::{write_authored_skill, write_authored_context}`.
- Produces (all `#[tauri::command]`, registered in `invoke_handler`):
  - `canon_write_skill(cwd: String, name: String, when_to_use: String, body: String) -> Result<(), String>`
  - `canon_write_context(cwd: String, name: String, summary: String, body: String) -> Result<(), String>`
  - `canon_review_pending(org: String) -> Result<Vec<canon_registry::PendingPkg>, String>`
  - `canon_review_decide(org, kind, name, version, decision, note: Option<String>) -> Result<(), String>`
  - `canon_set_review_policy(org: String, policy: String) -> Result<(), String>`

- [ ] **Step 1: Add the commands**

In `crates/app/src/lib.rs`, near the other `canon_*` commands (after `canon_publish`):

```rust
#[tauri::command]
async fn canon_write_skill(cwd: String, name: String, when_to_use: String, body: String) -> Result<(), String> {
    let repo = std::path::PathBuf::from(cwd);
    tokio::task::spawn_blocking(move || {
        karl_canon::write_authored_skill(&repo, &name, &when_to_use, &body, false).map(|_| ())
    })
    .await
    .map_err(|e| format!("canon_write_skill join: {e}"))?
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn canon_write_context(cwd: String, name: String, summary: String, body: String) -> Result<(), String> {
    let repo = std::path::PathBuf::from(cwd);
    tokio::task::spawn_blocking(move || {
        karl_canon::write_authored_context(&repo, &name, &summary, &body, false).map(|_| ())
    })
    .await
    .map_err(|e| format!("canon_write_context join: {e}"))?
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn canon_review_pending(org: String) -> Result<Vec<canon_registry::PendingPkg>, String> {
    canon_registry::list_pending(&org).await
}

#[tauri::command]
async fn canon_review_decide(
    org: String,
    kind: String,
    name: String,
    version: String,
    decision: String,
    note: Option<String>,
) -> Result<(), String> {
    canon_registry::review_decide(&org, &kind, &name, &version, &decision, note.as_deref()).await
}

#[tauri::command]
async fn canon_set_review_policy(org: String, policy: String) -> Result<(), String> {
    canon_registry::set_policy(&org, &policy).await
}
```

- [ ] **Step 2: Register in `invoke_handler`**

In the `tauri::generate_handler![...]` list (near `canon_publish` at ~line 4965), add:

```rust
            canon_write_skill,
            canon_write_context,
            canon_review_pending,
            canon_review_decide,
            canon_set_review_policy,
```

- [ ] **Step 3: Verify it compiles**

Run: `cargo build -p covenant`
Expected: clean build.

- [ ] **Step 4: Commit**

```bash
git add crates/app/src/lib.rs
git commit -m "feat(app): tauri commands for authored write, review, policy"
```

---

# PHASE 3 — Desktop UI (karlTerminal)

> `npx tsc --noEmit` from `ui/` for type-checks; `npm test` from repo ROOT for Vitest.

### Task 8: api.ts — types + wrappers

**Files:**
- Modify: `ui/src/api.ts`

**Interfaces:**
- Produces (TS):
  - `Org` type gains `review_policy: "direct" | "review_required"` and `pending_count: number`.
  - `PendingPkg` type `{ id: number; kind: CanonPkgKind; name: string; version: string; description: string; publisher_login: string; submitted_at: string }`.
  - `canonWriteSkill(cwd, name, whenToUse, body)`, `canonWriteContext(cwd, name, summary, body)`, `canonReviewPending(org)`, `canonReviewDecide(org, kind, name, version, decision, note)`, `canonSetReviewPolicy(org, policy)`.

- [ ] **Step 1: Extend the `Org` type**

Find the `Org` interface/type in `ui/src/api.ts` (returned by `canonMyOrgs`) and add:

```ts
  review_policy: "direct" | "review_required";
  pending_count: number;
```

- [ ] **Step 2: Add `PendingPkg` + wrappers**

Near the other `canon*` wrappers:

```ts
export interface PendingPkg {
  id: number;
  kind: CanonPkgKind;
  name: string;
  version: string;
  description: string;
  publisher_login: string;
  submitted_at: string;
}

export async function canonWriteSkill(cwd: string, name: string, whenToUse: string, body: string): Promise<void> {
  return invoke<void>("canon_write_skill", { cwd, name, whenToUse, body });
}
export async function canonWriteContext(cwd: string, name: string, summary: string, body: string): Promise<void> {
  return invoke<void>("canon_write_context", { cwd, name, summary, body });
}
export async function canonReviewPending(org: string): Promise<PendingPkg[]> {
  return invoke<PendingPkg[]>("canon_review_pending", { org });
}
export async function canonReviewDecide(
  org: string, kind: CanonPkgKind, name: string, version: string,
  decision: "approve" | "reject", note: string | null,
): Promise<void> {
  return invoke<void>("canon_review_decide", { org, kind, name, version, decision, note });
}
export async function canonSetReviewPolicy(org: string, policy: "direct" | "review_required"): Promise<void> {
  return invoke<void>("canon_set_review_policy", { org, policy });
}
```

> Note: the tauri command args are camelCase (`whenToUse`) — Tauri maps JS camelCase to Rust snake_case (`when_to_use`) automatically.

- [ ] **Step 3: Verify types**

Run: `cd ui && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add ui/src/api.ts
git commit -m "feat(ui): api wrappers + types for inscription/review"
```

---

### Task 9: Authoring form (skill + context) with live preview

**Files:**
- Create: `ui/src/canon/cockpit/authoring.ts`
- Modify: `ui/src/canon/cockpit/cockpit.css`
- Test: `ui/src/canon/cockpit/authoring.test.ts`

**Interfaces:**
- Consumes: `canonWriteSkill`, `canonWriteContext`, `canonPublish` (from api.ts), `Org`.
- Produces: `openAuthoringForm(opts: { kind: "skill" | "context"; cwd: string; org: Org | null; onDone: () => void }): void` — mounts a full-screen form; on submit writes the source then publishes, then calls `onDone`.
- Produces (pure, testable): `compilePreview(kind: "skill" | "context", name: string, field2: string, body: string): string` — returns the markdown that will be written (matches the Rust writer's format).

- [ ] **Step 1: Write the failing test (pure preview fn)**

Create `ui/src/canon/cockpit/authoring.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { compilePreview } from "./authoring";

describe("compilePreview", () => {
  it("renders skill frontmatter + when-to-use + body", () => {
    const md = compilePreview("skill", "kyc-peru", "Onboarding a Peru customer", "Mask PII.");
    expect(md).toContain("name: kyc-peru");
    expect(md).toContain("description: Onboarding a Peru customer");
    expect(md).toContain("Mask PII.");
  });
  it("renders context summary frontmatter", () => {
    const md = compilePreview("context", "sbs-rules", "SBS reporting floor", "Report within 24h.");
    expect(md).toContain("summary: SBS reporting floor");
    expect(md).toContain("Report within 24h.");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- authoring`
Expected: FAIL — module not found / `compilePreview` undefined.

- [ ] **Step 3: Implement `authoring.ts`**

Create `ui/src/canon/cockpit/authoring.ts`. The `compilePreview` MUST mirror the Rust format from Task 5 exactly:

```ts
import { canonWriteSkill, canonWriteContext, canonPublish, type Org } from "../../api";
import { pushInfoToast } from "../../notifications/toast";

/** Mirrors the markdown the Rust writers (crates/canon/authored.rs) produce,
 *  so the preview is byte-faithful to what lands on disk. */
export function compilePreview(
  kind: "skill" | "context",
  name: string,
  field2: string,
  body: string,
): string {
  const n = name.trim() || "unnamed";
  const b = body.trim();
  if (kind === "skill") {
    return `---\nname: ${n}\ndescription: ${field2.trim()}\nversion: 1.0.0\n---\n\n# ${n}\n\n${b}\n`;
  }
  return `---\nsummary: ${field2.trim()}\n---\n${b}\n`;
}

const VALID_NAME = /^[a-z0-9][a-z0-9._-]*$/;

export function openAuthoringForm(opts: {
  kind: "skill" | "context";
  cwd: string;
  org: Org | null;
  onDone: () => void;
}): void {
  const { kind, cwd, org } = opts;
  const reviewMode = org?.review_policy === "review_required";
  const submitLabel = !org ? "Save" : reviewMode ? "Submit for review" : "Publish";
  const field2Label = kind === "skill" ? "When to use" : "Summary (always-on)";

  const root = document.createElement("div");
  root.className = "canon-authoring";
  root.innerHTML = `
    <div class="canon-authoring-scrim"></div>
    <div class="canon-authoring-stage">
      <div class="canon-authoring-eyebrow">New ${kind}</div>
      <input class="canon-authoring-name" placeholder="name (lowercase-with-dashes)" />
      <input class="canon-authoring-field2" placeholder="${field2Label}" />
      <textarea class="canon-authoring-body" placeholder="Write the ${kind} in markdown…"></textarea>
      <p class="canon-authoring-err" role="alert" hidden></p>
      <div class="canon-authoring-actions">
        <button class="canon-authoring-cancel" type="button">Cancel</button>
        <button class="canon-authoring-submit" type="button" disabled>${submitLabel}</button>
      </div>
    </div>
    <div class="canon-authoring-preview"><pre class="canon-authoring-pre"></pre></div>`;
  document.body.appendChild(root);

  const nameEl = root.querySelector<HTMLInputElement>(".canon-authoring-name")!;
  const f2El = root.querySelector<HTMLInputElement>(".canon-authoring-field2")!;
  const bodyEl = root.querySelector<HTMLTextAreaElement>(".canon-authoring-body")!;
  const preEl = root.querySelector<HTMLPreElement>(".canon-authoring-pre")!;
  const errEl = root.querySelector<HTMLParagraphElement>(".canon-authoring-err")!;
  const submitEl = root.querySelector<HTMLButtonElement>(".canon-authoring-submit")!;
  const cancelEl = root.querySelector<HTMLButtonElement>(".canon-authoring-cancel")!;

  const close = (): void => { root.remove(); };
  cancelEl.addEventListener("click", close);
  root.querySelector(".canon-authoring-scrim")!.addEventListener("click", close);

  const refresh = (): void => {
    preEl.textContent = compilePreview(kind, nameEl.value, f2El.value, bodyEl.value);
    const ok = VALID_NAME.test(nameEl.value.trim()) && bodyEl.value.trim().length > 0;
    submitEl.disabled = !ok;
  };
  nameEl.addEventListener("input", refresh);
  f2El.addEventListener("input", refresh);
  bodyEl.addEventListener("input", refresh);
  refresh();

  submitEl.addEventListener("click", () => {
    const name = nameEl.value.trim();
    submitEl.disabled = true;
    errEl.hidden = true;
    const write = kind === "skill"
      ? canonWriteSkill(cwd, name, f2El.value.trim(), bodyEl.value)
      : canonWriteContext(cwd, name, f2El.value.trim(), bodyEl.value);
    void write
      .then(() => (org ? canonPublish(cwd, org.slug, name, kind) : Promise.resolve(null)))
      .then(() => {
        pushInfoToast({ message: !org ? `Saved ${name}` : reviewMode ? `Submitted ${name} for review` : `Published ${name}` });
        close();
        opts.onDone();
      })
      .catch((e) => {
        errEl.hidden = false;
        errEl.textContent = String(e);
        submitEl.disabled = false;
      });
  });
}
```

- [ ] **Step 4: Add styles**

Append to `ui/src/canon/cockpit/cockpit.css` (sharp corners, theme tokens — mirror `.canon-createorg-*`):

```css
.canon-authoring { position: fixed; inset: 0; z-index: 9700; display: grid;
  grid-template-columns: 1fr 1fr; }
.canon-authoring-scrim { position: absolute; inset: 0; background: var(--overlay-scrim, rgba(0,0,0,.5)); }
.canon-authoring-stage, .canon-authoring-preview { position: relative; padding: 48px 40px;
  background: var(--bg-elevated, #1a1a1a); overflow: auto; }
.canon-authoring-preview { background: var(--bg-base, #0e0e0e); }
.canon-authoring-eyebrow { text-transform: uppercase; letter-spacing: .08em; font-size: 12px;
  color: var(--text-dim); margin-bottom: 20px; }
.canon-authoring-name, .canon-authoring-field2, .canon-authoring-body {
  display: block; width: 100%; margin-bottom: 14px; padding: 10px 12px; border-radius: 0;
  background: var(--input-bg, #111); border: 1px solid var(--border, #333); color: var(--text);
  font: inherit; appearance: none; }
.canon-authoring-body { min-height: 260px; font-family: var(--mono, monospace); resize: vertical; }
.canon-authoring-pre { white-space: pre-wrap; font-family: var(--mono, monospace); font-size: 13px;
  color: var(--text-dim); }
.canon-authoring-actions { display: flex; gap: 10px; margin-top: 8px; }
.canon-authoring-submit, .canon-authoring-cancel { padding: 8px 16px; border-radius: 0; cursor: pointer; }
.canon-authoring-err { color: var(--danger, #e66); margin: 6px 0; }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- authoring` and `cd ui && npx tsc --noEmit`
Expected: 2 tests PASS; no type errors.

- [ ] **Step 6: Commit**

```bash
git add ui/src/canon/cockpit/authoring.ts ui/src/canon/cockpit/authoring.test.ts ui/src/canon/cockpit/cockpit.css
git commit -m "feat(ui): structured authoring form for skill + context with live preview"
```

---

### Task 10: "New" header action on Skills + Context sections

**Files:**
- Modify: `ui/src/canon/cockpit/view.ts`

**Interfaces:**
- Consumes: `openAuthoringForm` (Task 9), existing `sectionHead(title, desc, action?)`, `this.activeOrg()`, `this.showSection()`.
- Produces: a "New" button in the Skills and Context section headers that opens the authoring form and refreshes the section on done.

- [ ] **Step 1: Import the form**

At the top of `view.ts`:

```ts
import { openAuthoringForm } from "./authoring";
```

- [ ] **Step 2: Add a header action for Skills**

In `renderSection`, the head action is computed before `sectionHead` is called (see the existing `headAction` for context at ~line 185). Extend that logic so `skills` and `context` also get a "New" action. Locate:

```ts
    let headAction: HTMLElement | undefined;
    if (key === "context" && this.opts.groupRootDir && this.opts.onNewContext) {
      // ... existing "New context" (miner) button ...
    }
```

Add, after that block, a shared authoring "New" action for skills (and augment context to offer authored context alongside the miner). For **skills**:

```ts
    if (key === "skills" && this.opts.groupRootDir) {
      const cwd = this.opts.groupRootDir;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "canon-sec-head-action";
      btn.textContent = "New";
      btn.addEventListener("click", () =>
        openAuthoringForm({ kind: "skill", cwd, org: this.activeOrg(), onDone: () => this.showSection("skills") }));
      headAction = btn;
    }
```

For **context**, the existing "New context" opens the miner. Add a second "New" (authored) button. Since `sectionHead` takes a single action element, wrap both in a small container when both exist:

```ts
    if (key === "context" && this.opts.groupRootDir) {
      const cwd = this.opts.groupRootDir;
      const authored = document.createElement("button");
      authored.type = "button";
      authored.className = "canon-sec-head-action";
      authored.textContent = "New";
      authored.addEventListener("click", () =>
        openAuthoringForm({ kind: "context", cwd, org: this.activeOrg(), onDone: () => this.showSection("context") }));
      if (headAction) {
        const wrap = document.createElement("div");
        wrap.className = "canon-sec-head-actions";
        wrap.append(headAction, authored); // keep miner's "New context" + authored "New"
        headAction = wrap;
      } else {
        headAction = authored;
      }
    }
```

> If the existing miner block already sets `headAction` to the "New context" button, this wrap composes them. If the miner button text is "New context", the authored one is "New" — distinct labels avoid confusion.

- [ ] **Step 3: Add flex style for the wrap**

Append to `cockpit.css`:

```css
.canon-sec-head-actions { display: flex; gap: 8px; align-items: center; }
```

- [ ] **Step 4: Type-check + smoke test the render**

Run: `cd ui && npx tsc --noEmit` and `npm test -- cockpit`
Expected: no type errors; existing `view.test.ts` still green.

- [ ] **Step 5: Commit**

```bash
git add ui/src/canon/cockpit/view.ts ui/src/canon/cockpit/cockpit.css
git commit -m "feat(ui): New authoring action on Skills + Context sections"
```

---

### Task 11: Review section (owner queue)

**Files:**
- Modify: `ui/src/canon/cockpit/view.ts`
- Test: `ui/src/canon/cockpit/view.test.ts`

**Interfaces:**
- Consumes: `canonReviewPending`, `canonReviewDecide`, `canonPreview` (for card preview), `skillCard`, `iconButton`, `Icons`, `this.activeOrg()`.
- Produces: a `"review"` `SectionKey` + nav entry (owner-only, shown when the active org has `pending_count > 0`), and a `renderReviewSection()` rendering the queue with Approve/Reject.

- [ ] **Step 1: Add the SectionKey + SECTIONS entry + head text**

```ts
export type SectionKey = "org" | "members" | "operators" | "agents" | "commands" | "mcp" | "spec" | "memory" | "skills" | "registry" | "review" | "context" | "loop";
```

In `SECTIONS`, insert after `registry`:

```ts
  { key: "review", label: "Review" },
```

In `SECTION_HEAD`:

```ts
  review: ["Review", "Approve or reject what your members submit before it enters the registry."],
```

- [ ] **Step 2: Gate the nav button (owner + pending only)**

In the constructor loop that builds nav buttons (`for (const s of SECTIONS)`), skip the `review` button unless the active org is owner-role with pending items. Since orgs are known at construction (`this.opts.orgs`), compute:

```ts
      if (s.key === "review") {
        const active = this.opts.orgs.find((o) => o.slug === this.opts.getActiveOrg());
        const show = !!active && active.role === "owner" && active.pending_count > 0;
        if (!show) continue;
      }
```

- [ ] **Step 3: Route the section**

In `renderSection`, add the branch:

```ts
      : key === "review" ? this.renderReviewSection()
```

- [ ] **Step 4: Write the failing test**

Add to `ui/src/canon/cockpit/view.test.ts` (follow the file's existing construction pattern for `CanonCockpitView`):

```ts
it("shows Review nav only for owner with pending items", () => {
  const ownerWithPending = [{ id: 1, slug: "acme", name: "Acme", role: "owner", personal: false, review_policy: "review_required", pending_count: 2 }];
  const view = new CanonCockpitView({
    groupId: "g", groupLabel: "G", groupRootDir: "/repo",
    orgs: ownerWithPending as any, orgsFetched: true,
    getActiveOrg: () => "acme", setActiveOrg: () => {},
  });
  view.open();
  const btn = view.element.querySelector('[data-section="review"]');
  expect(btn).not.toBeNull();
  view.close();
});

it("hides Review nav when no pending items", () => {
  const ownerNoPending = [{ id: 1, slug: "acme", name: "Acme", role: "owner", personal: false, review_policy: "direct", pending_count: 0 }];
  const view = new CanonCockpitView({
    groupId: "g", groupLabel: "G", groupRootDir: "/repo",
    orgs: ownerNoPending as any, orgsFetched: true,
    getActiveOrg: () => "acme", setActiveOrg: () => {},
  });
  view.open();
  expect(view.element.querySelector('[data-section="review"]')).toBeNull();
  view.close();
});
```

- [ ] **Step 5: Run to verify it fails**

Run: `npm test -- view`
Expected: FAIL — `renderReviewSection` undefined / nav button absent.

- [ ] **Step 6: Implement `renderReviewSection`**

Add the method (mirror `renderSkillsSection`'s load pattern):

```ts
  private renderReviewSection(): HTMLElement {
    const el = document.createElement("div");
    el.className = "canon-cockpit-section is-review";
    const active = this.activeOrg();
    if (!active) {
      el.appendChild(this.emptyNoOrg("Pick an organization you own to review submissions."));
      return el;
    }
    const list = document.createElement("div");
    list.className = "canon-cockpit-review-list";
    list.appendChild(this.note("Loading…"));
    el.appendChild(list);

    const load = (): void => {
      void canonReviewPending(active.slug)
        .then((pending) => {
          list.replaceChildren();
          if (pending.length === 0) {
            list.appendChild(this.emptyState({
              icon: Icons.check({ size: 28 }),
              title: "Nothing to review",
              hint: "Submissions from your members show up here.",
            }));
            return;
          }
          for (const p of pending) {
            const approve = iconButton(Icons.check({ size: 15 }), "Approve", () => {
              approve.disabled = true;
              void canonReviewDecide(active.slug, p.kind, p.name, p.version, "approve", null)
                .then(load)
                .catch((e) => { approve.disabled = false; pushInfoToast({ message: this.friendlyError(e) }); });
            });
            const reject = iconButton(Icons.x({ size: 15 }), "Reject", () => {
              const note = window.prompt("Reason (optional):") ?? null;
              reject.disabled = true;
              void canonReviewDecide(active.slug, p.kind, p.name, p.version, "reject", note)
                .then(load)
                .catch((e) => { reject.disabled = false; pushInfoToast({ message: this.friendlyError(e) }); });
            });
            list.appendChild(skillCard({
              name: p.name,
              meta: `${p.kind} · from ${p.publisher_login}`,
              className: "canon-skill-row",
              fetchPreview: () => canonPreview(active.slug, p.name, p.version, p.kind).then((r: any) => r.skill_md),
              actions: [approve, reject],
            }));
          }
        })
        .catch((e) => { list.replaceChildren(); list.appendChild(this.note(`Failed to load: ${this.friendlyError(e)}`)); });
    };
    load();
    return el;
  }
```

> `window.prompt` is a synchronous browser modal but does NOT trigger the blocked JS-alert path issue (it's user-initiated, not agent-initiated). If the repo forbids `prompt`, swap for an inline `<input>` revealed on reject — check `cockpit.css`/DESIGN.md; the inline variant is the same shape as `renderAddMemberRow`'s error input. Keep the ponytail default (`prompt`) unless review flags it.

Confirm `canonReviewPending`, `canonReviewDecide`, `canonPreview`, `skillCard`, `iconButton`, `Icons` are imported at the top of `view.ts` (add any missing).

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm test -- view` and `cd ui && npx tsc --noEmit`
Expected: both new tests PASS; no type errors.

- [ ] **Step 8: Commit**

```bash
git add ui/src/canon/cockpit/view.ts ui/src/canon/cockpit/view.test.ts
git commit -m "feat(ui): owner Review queue section with approve/reject"
```

---

### Task 12: Policy toggle in the Org section

**Files:**
- Modify: `ui/src/canon/cockpit/view.ts`
- Modify: `ui/src/canon/cockpit/cockpit.css`

**Interfaces:**
- Consumes: `canonSetReviewPolicy`, `this.activeOrg()`, `this.refreshOrgs(slug)` (existing).
- Produces: an owner-only control in `renderOrgSection` to switch `review_policy`.

- [ ] **Step 1: Add the toggle**

In `renderOrgSection`, where the active org is rendered for an owner (the same block that offers rename), append a policy control:

```ts
    if (active && active.role === "owner") {
      const row = document.createElement("div");
      row.className = "canon-policy-row";
      const label = document.createElement("span");
      label.className = "canon-policy-label";
      label.textContent = "Registry submissions";
      const sel = document.createElement("select");
      sel.className = "canon-policy-select";
      sel.innerHTML =
        `<option value="direct">Direct publish</option>` +
        `<option value="review_required">Requires review</option>`;
      sel.value = active.review_policy;
      sel.addEventListener("change", () => {
        const policy = sel.value as "direct" | "review_required";
        sel.disabled = true;
        void canonSetReviewPolicy(active.slug, policy)
          .then(() => this.refreshOrgs(active.slug))
          .catch((e) => { sel.disabled = false; pushInfoToast({ message: this.friendlyError(e) }); });
      });
      row.append(label, sel);
      el.appendChild(row);
    }
```

> `active` here is the org row from `this.opts.orgs` — it already carries `review_policy`. Confirm the variable name matches the existing `renderOrgSection` (it uses `active` for the active org).

- [ ] **Step 2: Add styles**

Append to `cockpit.css`:

```css
.canon-policy-row { display: flex; align-items: center; gap: 12px; margin-top: 16px; }
.canon-policy-label { color: var(--text-dim); font-size: 13px; }
.canon-policy-select { padding: 6px 10px; border-radius: 0; appearance: none;
  background: var(--input-bg, #111); border: 1px solid var(--border, #333); color: var(--text); }
```

- [ ] **Step 3: Type-check + smoke**

Run: `cd ui && npx tsc --noEmit` and `npm test -- view`
Expected: no errors; existing tests green.

- [ ] **Step 4: Commit**

```bash
git add ui/src/canon/cockpit/view.ts ui/src/canon/cockpit/cockpit.css
git commit -m "feat(ui): per-org review policy toggle in Org section"
```

---

### Task 13: Pending-count badge on the Canon rail button

**Files:**
- Modify: `ui/src/main.ts`
- Modify: `ui/src/canon/cockpit/cockpit.css` (badge style — or the rail stylesheet; keep it near the canon button styles)

**Interfaces:**
- Consumes: `canonMyOrgs()` (returns `Org[]` with `pending_count`), the existing `canonBtn` (rail button at ~line 1007).
- Produces: a small count badge on `canonBtn`; number = sum of `pending_count` across owner orgs; hidden at zero. Refreshed on Canon open and after review decisions.

- [ ] **Step 1: Add a badge element + updater near `canonBtn`**

Where `canonBtn` is created (~line 1007 in `main.ts`), append a badge span and a refresh function:

```ts
  const canonBadge = document.createElement("span");
  canonBadge.className = "canon-rail-badge hidden";
  canonBtn.appendChild(canonBadge);

  const refreshCanonBadge = (): void => {
    void canonMyOrgs()
      .then((orgs) => (orgs as Org[]).filter((o) => o.role === "owner").reduce((n, o) => n + (o.pending_count || 0), 0))
      .catch(() => 0)
      .then((total) => {
        canonBadge.textContent = total > 0 ? String(total) : "";
        canonBadge.classList.toggle("hidden", total === 0);
      });
  };
  refreshCanonBadge();
```

Expose `refreshCanonBadge` where the cockpit's `onClose` runs (so approving/rejecting then closing updates it) — call it inside the existing `onClose` handler for `CanonCockpitView` (~line 1611):

```ts
            onClose: () => { activeCanonPanel?.close(); refreshCanonBadge(); },
```

- [ ] **Step 2: Add the badge style**

Append to `cockpit.css` (or the rail CSS if canon button styles live there):

```css
.canon-rail-badge { display: inline-flex; min-width: 16px; height: 16px; padding: 0 4px;
  align-items: center; justify-content: center; margin-left: 6px; border-radius: 8px;
  background: var(--accent, #c8794a); color: #fff; font-size: 11px; line-height: 1; }
.canon-rail-badge.hidden { display: none; }
```

> The badge is a count pill (not a `50%` dot), so a small border-radius is acceptable per the "except 50% dots" sharp-corner exception. If review prefers a square, set `border-radius: 0`.

- [ ] **Step 3: Type-check**

Run: `cd ui && npx tsc --noEmit`
Expected: no errors. (`Org` must be imported in `main.ts` — it already is, per line 1599's `o as Org[]`.)

- [ ] **Step 4: Commit**

```bash
git add ui/src/main.ts ui/src/canon/cockpit/cockpit.css
git commit -m "feat(ui): pending-count badge on Canon rail entry"
```

---

## Self-Review

**Spec coverage:**
- Per-org policy (`direct`/`review_required`) → Task 1 (column), Task 4 (payload+setter), Task 12 (UI toggle). ✅
- Submit→pending / direct→published routing → Task 2 (`publish` policy-aware). ✅
- Approve/Reject by owners → Task 3 (endpoints), Task 11 (UI queue). ✅
- Security invariant (pending never installable) → Task 2 (Step 4 filter) + its test. ✅
- Resubmit-after-reject → Task 2 (revive UPDATE). ✅
- Structured form + live preview (skill+context) → Task 5 (writers), Task 9 (form+preview), Task 10 (entry). ✅
- Badge + label-from-policy → Task 4 (pending_count+review_policy on payload), Task 9 (submit label), Task 13 (badge). ✅
- Backward-compat (direct default) → Task 1 defaults + Task 2 (direct path unchanged). ✅
- Out-of-scope kinds (mcp/subagent/command authoring, memory publishable, reviewer role, push) → not implemented, per Global Constraints. ✅

**Placeholder scan:** No TBD/TODO left except the two intentional, explained deferrals (migration number confirmation; `window.prompt` vs inline input) — both name the exact resolution step. No "add error handling"-style vagueness; every code step is complete.

**Type consistency:** `PendingPkg` fields identical across Rust (`src/cdlc.rs`, `canon_registry.rs`) and TS (`api.ts`): `id, kind, name, version, description, publisher_login, submitted_at`. `review_policy`/`pending_count` names identical server→client→UI. `canonReviewDecide(decision: "approve"|"reject")` matches server `ReviewReq.decision` match arms. Command arg camelCase (`whenToUse`) ↔ Rust snake_case (`when_to_use`) via Tauri's mapping (noted in Task 8).

**Scope:** One plan, two repos, server-first ordering explicit. Focused on skill+context; no bleed into deferred kinds.
