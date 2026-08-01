# Eval Plan B — Cross-Org Pass-Rate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Push local eval pass/fail results to the org's Canon registry so every package card shows the org-wide pass-rate for that version.

**Architecture:** One new server table (`cdlc_evals`) keyed `(package_id, github_id, eval_id)` so re-runs upsert instead of accumulate; one member-gated `POST /cdlc/packages/:id/evals`; the aggregate rides the `PkgMeta` rows the existing registry search already returns, so there is no new read endpoint and no new client fetch. The desktop pushes automatically after `canon_run_evals`, but only for skills installed from that registry, and every failure is a silent `tracing::warn!`.

**Tech Stack:** Rust (axum 0.7, sqlx/Postgres, tokio, serde, reqwest), Tauri 2, TypeScript + vitest.

**Spec:** `docs/superpowers/specs/2026-08-01-cdlc-eval-plan-b-design.md`

**Two repositories.** Tasks 1–3 are `~/Sources/covenant-server`. Tasks 4–7 are `karlTerminal` (this worktree). The server must be deployed before the client ships; a client that runs early gets a 404 and warns.

## Global Constraints

- **`covenant-server` local checkout is stale.** The branch `feat/canon-personal-org` is 35 commits behind `origin/main` and 0 ahead. Before Task 1: `git checkout main && git pull`. Do not build on the stale branch.
- **No `unwrap()`** outside `#[cfg(test)]` and `main()`. Errors: `thiserror` in libraries, `String` at the Tauri command boundary (matches every existing `canon_*` command).
- **Never send the judge's `reason` to the server.** It is free text an LLM wrote about the user's repository. The wire payload is `eval_id`, `pass`, `baseline_pass`, `ran_at_ms` and nothing else.
- **The push can never fail a run.** Every error in the push path is `tracing::warn!(target: "canon", …)` and a `return`. No `?` that propagates to the caller, no progress event, no toast.
- **New `PkgMeta` fields must be `#[serde(default)]` on the client.** A desktop build talking to a not-yet-deployed server must still deserialize search results.
- **UI copy is English** (project rule). **No native tooltips** — use `attachTooltip` from `ui/src/tooltip/tooltip.ts`.
- **TypeScript** is `strict`; no `as any` without a justifying comment.
- **Test commands:** `cargo test -p karl-canon` and `cargo test -p covenant-server` for Rust; `npx vitest run` and `npx tsc --noEmit` from the **karlTerminal repo root** (not `ui/`). `npm run typecheck` does not exist.
- **`cargo test -p covenant-server` needs a running Postgres.** `#[sqlx::test]` creates a scratch database per test from `DATABASE_URL`. If it is unset the DB tests error out — that is an environment problem, not a code failure.
- **Commits:** Conventional Commits, one per task.

---

### Task 1: `cdlc_evals` table + the aggregate query

Server-side, database only. No handler yet — this task proves the two properties the whole design rests on (upsert-not-accumulate, correct aggregate) before any HTTP exists.

**Files:**
- Create: `migrations/0016_cdlc_evals.sql`
- Create: `src/cdlc_evals.rs` (module holds only the test module in this task)
- Modify: `src/main.rs` (add `mod cdlc_evals;` beside the other `mod` lines at the top)

**Interfaces:**
- Consumes: nothing.
- Produces: the table `cdlc_evals` and the aggregate SQL that Task 3 embeds in `cdlc::search`.

- [ ] **Step 1: Get onto current main**

```bash
cd ~/Sources/covenant-server
git checkout main
git pull
git log --oneline -1     # expect f2ee4fb or later
ls migrations | tail -3  # expect 0013, 0014, 0015 — confirms you are on main
```

- [ ] **Step 2: Write the migration**

Create `migrations/0016_cdlc_evals.sql`:

```sql
-- Cross-org eval results (Plan B). One row per (package version, person, eval):
-- re-running an eval REPLACES its row, so the aggregate can go down when a
-- skill regresses. There is deliberately no history.
CREATE TABLE cdlc_evals (
  package_id    BIGINT  NOT NULL REFERENCES cdlc_packages(id) ON DELETE CASCADE,
  github_id     BIGINT  NOT NULL REFERENCES users(github_id),
  eval_id       TEXT    NOT NULL,
  pass          BOOLEAN NOT NULL,
  baseline_pass BOOLEAN,
  ran_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (package_id, github_id, eval_id)
);
CREATE INDEX cdlc_evals_pkg ON cdlc_evals(package_id);
```

- [ ] **Step 3: Write the failing DB test**

Create `src/cdlc_evals.rs`:

```rust
//! Cross-org eval results (Plan B): members POST the pass/fail outcome of a
//! local eval run, the registry search folds them into a per-version
//! pass-rate. The judge's reasoning never leaves the machine that ran it.

#[cfg(test)]
mod tests {
    /// Seed a user, an org they own, and one published package. Returns the
    /// package id.
    async fn seed(pool: &sqlx::PgPool) -> i64 {
        sqlx::query("INSERT INTO users(github_id, login, avatar_url) VALUES (1, 'owner', '')")
            .execute(pool)
            .await
            .unwrap();
        let (org_id,): (i64,) = sqlx::query_as(
            "INSERT INTO orgs(slug, name, owner_github_id) VALUES ('acme', 'Acme', 1) RETURNING id",
        )
        .fetch_one(pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO org_members(org_id, github_id, role) VALUES ($1, 1, 'owner')")
            .bind(org_id)
            .execute(pool)
            .await
            .unwrap();
        let (pkg_id,): (i64,) = sqlx::query_as(
            "INSERT INTO cdlc_packages(org_id, kind, name, version, description, skill_toml,
             skill_md, sha, publisher_github_id, publisher_login)
             VALUES ($1, 'skill', 'kyc-peru', '1.0.0', '', '', 'md', 'sha', 1, 'owner')
             RETURNING id",
        )
        .bind(org_id)
        .fetch_one(pool)
        .await
        .unwrap();
        pkg_id
    }

    const UPSERT: &str = "INSERT INTO cdlc_evals(package_id, github_id, eval_id, pass, baseline_pass, ran_at)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (package_id, github_id, eval_id) DO UPDATE
           SET pass = EXCLUDED.pass,
               baseline_pass = EXCLUDED.baseline_pass,
               ran_at = EXCLUDED.ran_at";

    const AGGREGATE: &str = "SELECT count(*) FILTER (WHERE pass) AS passed, count(*) AS total
         FROM cdlc_evals WHERE package_id = $1";

    /// The property the card depends on: fixing a skill and re-running must
    /// make the number go UP, not add a second row that keeps it down.
    #[sqlx::test(migrations = "./migrations")]
    async fn rerunning_an_eval_replaces_its_row(pool: sqlx::PgPool) {
        let pkg = seed(&pool).await;
        let t0 = chrono::Utc::now();

        // First run: fails.
        sqlx::query(UPSERT)
            .bind(pkg).bind(1i64).bind("flags-pep-match").bind(false).bind(None::<bool>).bind(t0)
            .execute(&pool).await.unwrap();
        let (passed, total): (i64, i64) =
            sqlx::query_as(AGGREGATE).bind(pkg).fetch_one(&pool).await.unwrap();
        assert_eq!((passed, total), (0, 1));

        // Same eval, same person, now passes.
        sqlx::query(UPSERT)
            .bind(pkg).bind(1i64).bind("flags-pep-match").bind(true).bind(Some(false)).bind(t0)
            .execute(&pool).await.unwrap();
        let (passed, total): (i64, i64) =
            sqlx::query_as(AGGREGATE).bind(pkg).fetch_one(&pool).await.unwrap();
        assert_eq!((passed, total), (1, 1), "re-run must replace, not accumulate");

        let baseline: Option<bool> =
            sqlx::query_scalar("SELECT baseline_pass FROM cdlc_evals WHERE package_id = $1")
                .bind(pkg).fetch_one(&pool).await.unwrap();
        assert_eq!(baseline, Some(false));
    }

    /// Two members running the same eval are two data points, not one.
    #[sqlx::test(migrations = "./migrations")]
    async fn results_from_different_members_both_count(pool: sqlx::PgPool) {
        let pkg = seed(&pool).await;
        sqlx::query("INSERT INTO users(github_id, login, avatar_url) VALUES (2, 'member', '')")
            .execute(&pool).await.unwrap();
        let t0 = chrono::Utc::now();

        sqlx::query(UPSERT)
            .bind(pkg).bind(1i64).bind("e1").bind(true).bind(None::<bool>).bind(t0)
            .execute(&pool).await.unwrap();
        sqlx::query(UPSERT)
            .bind(pkg).bind(2i64).bind("e1").bind(false).bind(None::<bool>).bind(t0)
            .execute(&pool).await.unwrap();

        let (passed, total): (i64, i64) =
            sqlx::query_as(AGGREGATE).bind(pkg).fetch_one(&pool).await.unwrap();
        assert_eq!((passed, total), (1, 2));
    }

    /// Unpublishing a package must not leave orphan results behind.
    #[sqlx::test(migrations = "./migrations")]
    async fn results_cascade_with_the_package(pool: sqlx::PgPool) {
        let pkg = seed(&pool).await;
        sqlx::query(UPSERT)
            .bind(pkg).bind(1i64).bind("e1").bind(true).bind(None::<bool>).bind(chrono::Utc::now())
            .execute(&pool).await.unwrap();
        sqlx::query("DELETE FROM cdlc_packages WHERE id = $1")
            .bind(pkg).execute(&pool).await.unwrap();
        let n: i64 = sqlx::query_scalar("SELECT count(*) FROM cdlc_evals WHERE package_id = $1")
            .bind(pkg).fetch_one(&pool).await.unwrap();
        assert_eq!(n, 0);
    }
}
```

- [ ] **Step 4: Register the module**

In `src/main.rs`, the `mod` declarations are alphabetical. Add between `mod cdlc;` and `mod cloud_state;`:

```rust
mod cdlc_evals;
```

- [ ] **Step 5: Run the tests to verify they fail**

```bash
cargo test -p covenant-server cdlc_evals
```

Expected: FAIL — `relation "cdlc_evals" does not exist`, because `#[sqlx::test]` runs migrations from `./migrations` and you have not saved the file yet if you did Step 2 out of order. If Step 2 is done, this step instead **passes** immediately; that is fine and expected for a schema-only task — the tests are there to lock the behavior in, and the meaningful failure is the one you get if you drop the `ON CONFLICT` clause. Verify that: temporarily change `UPSERT` to a plain `INSERT`, re-run, watch `rerunning_an_eval_replaces_its_row` fail with a duplicate-key error, then restore it.

- [ ] **Step 6: Run the tests to verify they pass**

```bash
cargo test -p covenant-server cdlc_evals
```

Expected: 3 passed.

- [ ] **Step 7: Commit**

```bash
git add migrations/0016_cdlc_evals.sql src/cdlc_evals.rs src/main.rs
git commit -m "feat(evals): cdlc_evals table — one row per (package, person, eval)"
```

---

### Task 2: `POST /cdlc/packages/:id/evals`

**Files:**
- Modify: `src/cdlc_evals.rs` (add the handler and the request types above the existing `#[cfg(test)] mod tests`)
- Modify: `src/main.rs` (add the route)

**Interfaces:**
- Consumes: the `cdlc_evals` table from Task 1; `jwt::verify`, `sync::bearer`, `AppError`, `AppState` from the existing codebase.
- Produces: `POST /cdlc/packages/:id/evals`, request body `{"results": [{"eval_id": String, "pass": bool, "baseline_pass": Option<bool>, "ran_at_ms": i64}]}`, response `{"ok": true, "stored": <n>}`. Task 5's client calls this.

- [ ] **Step 1: Write the failing validation test**

Append these two tests inside the existing `mod tests` block in `src/cdlc_evals.rs`:

```rust
    use super::*;

    #[test]
    fn validate_rejects_empty_and_oversized_batches() {
        let one = || EvalRow {
            eval_id: "e1".into(), pass: true, baseline_pass: None, ran_at_ms: 0,
        };
        assert!(validate(&[]).is_err(), "empty batch is not a run");
        assert!(validate(&[one()]).is_ok());
        let max: Vec<EvalRow> = (0..200).map(|_| one()).collect();
        assert!(validate(&max).is_ok(), "200 is the cap, not one past it");
        let over: Vec<EvalRow> = (0..201).map(|_| one()).collect();
        assert!(validate(&over).is_err());
    }

    #[test]
    fn validate_rejects_bad_eval_ids() {
        let row = |id: &str| EvalRow {
            eval_id: id.into(), pass: true, baseline_pass: None, ran_at_ms: 0,
        };
        assert!(validate(&[row("")]).is_err(), "empty id");
        assert!(validate(&[row("   ")]).is_err(), "whitespace-only id");
        assert!(validate(&[row(&"x".repeat(128))]).is_ok(), "128 is the cap");
        assert!(validate(&[row(&"x".repeat(129))]).is_err());
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cargo test -p covenant-server cdlc_evals
```

Expected: FAIL to compile — `cannot find type EvalRow in this scope`, `cannot find function validate in this scope`.

- [ ] **Step 3: Write the types and the validator**

At the top of `src/cdlc_evals.rs`, under the module doc comment:

```rust
use axum::{
    extract::{Path, State},
    http::HeaderMap,
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::{
    error::{AppError, Result},
    jwt,
    sync::bearer,
    AppState,
};

const MAX_RESULTS: usize = 200;
const MAX_EVAL_ID: usize = 128;

#[derive(Deserialize)]
pub struct EvalRow {
    pub eval_id: String,
    pub pass: bool,
    #[serde(default)]
    pub baseline_pass: Option<bool>,
    /// Unix epoch milliseconds, as the desktop's `EvalResult.ran_at_ms`.
    pub ran_at_ms: i64,
}

#[derive(Deserialize)]
pub struct PushReq {
    pub results: Vec<EvalRow>,
}

fn validate(rows: &[EvalRow]) -> Result<()> {
    if rows.is_empty() {
        return Err(AppError::BadRequest("no results".into()));
    }
    if rows.len() > MAX_RESULTS {
        return Err(AppError::BadRequest("too many results".into()));
    }
    for r in rows {
        let id = r.eval_id.trim();
        if id.is_empty() || id.len() > MAX_EVAL_ID {
            return Err(AppError::BadRequest("invalid eval id".into()));
        }
    }
    Ok(())
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cargo test -p covenant-server cdlc_evals
```

Expected: 5 passed (3 from Task 1, 2 new).

- [ ] **Step 5: Write the handler**

Append to `src/cdlc_evals.rs`, after `validate` and before `#[cfg(test)]`:

```rust
/// POST /cdlc/packages/:id/evals — member-gated.
///
/// Not owner-gated on purpose: any member who runs evals contributes, which is
/// the entire point of a cross-org number. The gate that matters for the
/// roster (auto-propagation) does not apply here — an eval result changes a
/// number on a card and nothing else.
pub async fn push(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(req): Json<PushReq>,
) -> Result<Json<Value>> {
    let claims = jwt::verify(&state.jwt_secret, bearer(&headers)?)?;
    validate(&req.results)?;

    // Same allowed-CTE shape as cdlc::record_install: distinguish "no such
    // package" (404) from "not your org" (403) without leaking existence.
    let allowed: Option<(i64,)> = sqlx::query_as(
        "SELECT p.id FROM cdlc_packages p
           JOIN org_members m ON m.org_id = p.org_id
          WHERE p.id = $1 AND m.github_id = $2",
    )
    .bind(id)
    .bind(claims.sub)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| AppError::Internal(e.into()))?;

    let pkg_id = match allowed {
        Some((pid,)) => pid,
        None => {
            let exists: Option<(i32,)> = sqlx::query_as("SELECT 1 FROM cdlc_packages WHERE id = $1")
                .bind(id)
                .fetch_optional(&state.pool)
                .await
                .map_err(|e| AppError::Internal(e.into()))?;
            return Err(if exists.is_some() { AppError::Forbidden } else { AppError::NotFound });
        }
    };

    let now = chrono::Utc::now();
    let mut tx = state.pool.begin().await.map_err(|e| AppError::Internal(e.into()))?;
    for r in &req.results {
        // A client with a fast clock cannot claim a run in the future.
        let ran_at = chrono::DateTime::from_timestamp_millis(r.ran_at_ms)
            .unwrap_or(now)
            .min(now);
        sqlx::query(
            "INSERT INTO cdlc_evals(package_id, github_id, eval_id, pass, baseline_pass, ran_at)
             VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT (package_id, github_id, eval_id) DO UPDATE
               SET pass = EXCLUDED.pass,
                   baseline_pass = EXCLUDED.baseline_pass,
                   ran_at = EXCLUDED.ran_at",
        )
        .bind(pkg_id)
        .bind(claims.sub)
        .bind(r.eval_id.trim())
        .bind(r.pass)
        .bind(r.baseline_pass)
        .bind(ran_at)
        .execute(&mut *tx)
        .await
        .map_err(|e| AppError::Internal(e.into()))?;
    }
    tx.commit().await.map_err(|e| AppError::Internal(e.into()))?;

    Ok(Json(json!({ "ok": true, "stored": req.results.len() })))
}
```

- [ ] **Step 6: Register the route**

In `src/main.rs`, directly after the existing install route:

```rust
        .route("/cdlc/packages/:id/install", axum::routing::post(cdlc::record_install))
        .route("/cdlc/packages/:id/evals", axum::routing::post(cdlc_evals::push))
```

- [ ] **Step 7: Verify it compiles and the suite is green**

```bash
cargo test -p covenant-server cdlc_evals
cargo clippy --all-targets
```

Expected: 5 passed, no clippy warnings on the new file.

- [ ] **Step 8: Commit**

```bash
git add src/cdlc_evals.rs src/main.rs
git commit -m "feat(evals): POST /cdlc/packages/:id/evals, member-gated upsert"
```

---

### Task 3: Fold the aggregate into registry search

**Files:**
- Modify: `src/cdlc.rs` (the `PkgMeta` struct and the `search` query)
- Modify: `src/cdlc_evals.rs` (one more DB test)

**Interfaces:**
- Consumes: the `cdlc_evals` table from Task 1.
- Produces: `PkgMeta` gains `eval_passed: i64` and `eval_total: i64`, both always present in the JSON. Task 6's client reads them.

- [ ] **Step 1: Write the failing test**

Append inside `mod tests` in `src/cdlc_evals.rs`:

```rust
    /// The exact lateral join `cdlc::search` uses, asserted against a package
    /// with results and one without — a package nobody has evaluated must come
    /// back as 0/0, not as a missing row.
    #[sqlx::test(migrations = "./migrations")]
    async fn search_aggregate_reports_zero_for_unevaluated_packages(pool: sqlx::PgPool) {
        let pkg = seed(&pool).await;
        let org_id: i64 = sqlx::query_scalar("SELECT org_id FROM cdlc_packages WHERE id = $1")
            .bind(pkg).fetch_one(&pool).await.unwrap();
        sqlx::query(
            "INSERT INTO cdlc_packages(org_id, kind, name, version, description, skill_toml,
             skill_md, sha, publisher_github_id, publisher_login)
             VALUES ($1, 'skill', 'untested', '1.0.0', '', '', 'md', 'sha', 1, 'owner')",
        )
        .bind(org_id).execute(&pool).await.unwrap();

        let t0 = chrono::Utc::now();
        for (eval, pass) in [("e1", true), ("e2", true), ("e3", false)] {
            sqlx::query(UPSERT)
                .bind(pkg).bind(1i64).bind(eval).bind(pass).bind(None::<bool>).bind(t0)
                .execute(&pool).await.unwrap();
        }

        let rows: Vec<(String, i64, i64)> = sqlx::query_as(
            "SELECT DISTINCT ON (p.name) p.name, ev.eval_passed, ev.eval_total
               FROM cdlc_packages p
               LEFT JOIN LATERAL (
                 SELECT count(*) FILTER (WHERE pass) AS eval_passed,
                        count(*)                     AS eval_total
                   FROM cdlc_evals e WHERE e.package_id = p.id
               ) ev ON true
              WHERE p.org_id = $1 AND p.kind = 'skill'
              ORDER BY p.name, p.created_at DESC",
        )
        .bind(org_id)
        .fetch_all(&pool)
        .await
        .unwrap();

        assert_eq!(rows.len(), 2);
        let kyc = rows.iter().find(|r| r.0 == "kyc-peru").unwrap();
        assert_eq!((kyc.1, kyc.2), (2, 3));
        let untested = rows.iter().find(|r| r.0 == "untested").unwrap();
        assert_eq!((untested.1, untested.2), (0, 0), "no results is 0/0, not NULL");
    }
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cargo test -p covenant-server search_aggregate
```

Expected: PASS — the query is self-contained, so this test locks in the SQL shape before you paste it into the handler. If it fails, the join is wrong and Step 3 would have shipped that bug into `search`.

- [ ] **Step 3: Add the fields to `PkgMeta`**

In `src/cdlc.rs`, the `PkgMeta` struct becomes:

```rust
#[derive(Serialize, sqlx::FromRow)]
pub struct PkgMeta {
    pub id: i64,
    pub kind: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub publisher_login: String,
    pub installs: i32,
    pub sha: String,
    /// Cross-org eval aggregate for THIS version (Plan B). 0/0 when nobody has
    /// run its evals — a new version starts blank on purpose.
    pub eval_passed: i64,
    pub eval_total: i64,
}
```

- [ ] **Step 4: Add the lateral join to `search`**

In `src/cdlc.rs`, replace the query inside `search` with:

```rust
    let rows = sqlx::query_as::<_, PkgMeta>(
        "SELECT DISTINCT ON (p.name) p.id, p.kind, p.name, p.version, p.description,
                p.publisher_login, p.installs, p.sha,
                ev.eval_passed, ev.eval_total
           FROM cdlc_packages p
           LEFT JOIN LATERAL (
             SELECT count(*) FILTER (WHERE pass) AS eval_passed,
                    count(*)                     AS eval_total
               FROM cdlc_evals e WHERE e.package_id = p.id
           ) ev ON true
          WHERE p.org_id = $1 AND p.kind = $2
            AND ($3::text IS NULL OR lower(p.name) LIKE $3 OR lower(p.description) LIKE $3)
          ORDER BY p.name, p.created_at DESC
          LIMIT 200",
    )
```

Note every column is now `p.`-qualified — the unqualified names would be ambiguous against the lateral subquery.

- [ ] **Step 5: Verify it compiles and passes**

```bash
cargo test -p covenant-server
cargo clippy --all-targets
```

Expected: whole suite green, no warnings.

- [ ] **Step 6: Commit**

```bash
git add src/cdlc.rs src/cdlc_evals.rs
git commit -m "feat(evals): registry search returns the per-version eval aggregate"
```

- [ ] **Step 7: Push and confirm the deploy**

```bash
git push
gh run watch    # deploy.yml
```

Then confirm the route exists (401, not 404 — unauthenticated is the correct rejection):

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  https://forge.covenant.uno/cdlc/packages/1/evals \
  -H 'content-type: application/json' -d '{"results":[]}'
```

Expected: `401`. A `404` means the route did not deploy — stop and fix before starting Task 4.

---

### Task 4: `parse_registry_source` in `crates/canon`

Back in **karlTerminal**. Pure function, no I/O — the only real logic on the client side.

**Files:**
- Modify: `crates/canon/src/install.rs` (add the function + tests at the end, before or beside the existing `#[cfg(test)]` module)
- Modify: `crates/canon/src/lib.rs` (re-export)

**Interfaces:**
- Consumes: nothing.
- Produces: `karl_canon::parse_registry_source(source: &str) -> Option<(String, String, String)>` returning `(org, name, version)`. Task 5 calls it.

- [ ] **Step 1: Write the failing test**

Add to the `#[cfg(test)] mod tests` block at the bottom of `crates/canon/src/install.rs`:

```rust
    #[test]
    fn parse_registry_source_reads_org_name_version() {
        assert_eq!(
            parse_registry_source("registry:mibanco/kyc-peru@1.0.0"),
            Some(("mibanco".into(), "kyc-peru".into(), "1.0.0".into()))
        );
        // Versions contain dots and dashes; only the LAST '@' separates.
        assert_eq!(
            parse_registry_source("registry:acme/skill@2.1.0-rc.1"),
            Some(("acme".into(), "skill".into(), "2.1.0-rc.1".into()))
        );
    }

    #[test]
    fn parse_registry_source_rejects_anything_else() {
        assert_eq!(parse_registry_source("local:/tmp/kyc"), None);
        assert_eq!(parse_registry_source("registry:kyc-peru@1.0.0"), None, "no org");
        assert_eq!(parse_registry_source("registry:acme/kyc-peru"), None, "no version");
        assert_eq!(parse_registry_source("registry:acme/@1.0.0"), None, "empty name");
        assert_eq!(parse_registry_source("registry:/kyc@1.0.0"), None, "empty org");
        assert_eq!(parse_registry_source("registry:acme/kyc@"), None, "empty version");
        assert_eq!(parse_registry_source(""), None);
    }
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cargo test -p karl-canon parse_registry_source
```

Expected: FAIL to compile — `cannot find function parse_registry_source in this scope`.

- [ ] **Step 3: Write the implementation**

Add to `crates/canon/src/install.rs` (module level, not inside `mod tests`):

```rust
/// Split an `InstalledRef.source` of the form `registry:<org>/<name>@<version>`
/// into its parts. `None` for any other source (`local:…`) or a malformed ref.
///
/// The version is taken from the LAST `@` so pre-release versions
/// (`2.1.0-rc.1`) survive; org and name never contain `@`.
pub fn parse_registry_source(source: &str) -> Option<(String, String, String)> {
    let rest = source.strip_prefix("registry:")?;
    let (path, version) = rest.rsplit_once('@')?;
    let (org, name) = path.split_once('/')?;
    if org.is_empty() || name.is_empty() || version.is_empty() {
        return None;
    }
    Some((org.to_string(), name.to_string(), version.to_string()))
}
```

- [ ] **Step 4: Run it to verify it passes**

```bash
cargo test -p karl-canon parse_registry_source
```

Expected: 2 passed.

- [ ] **Step 5: Re-export it**

In `crates/canon/src/lib.rs`, add `parse_registry_source` to the `pub use install::{…}` list, keeping alphabetical order — it goes between `install_unit` and `read_skill_package`:

```rust
pub use install::{
    adopt, adopt_new_skills, content_version, delete_unit, install_from_dir, install_local,
    install_unit, parse_registry_source, read_skill_package, read_source, source_path, status,
    uninstall_skill, CanonStatus,
};
```

- [ ] **Step 6: Commit**

```bash
git add crates/canon/src/install.rs crates/canon/src/lib.rs
git commit -m "feat(canon): parse_registry_source — org/name/version from an installed ref"
```

---

### Task 5: Push results after a run

**Files:**
- Modify: `crates/app/src/canon_registry.rs` (add `push_evals`)
- Modify: `crates/app/src/canon_eval.rs` (call it at the end of `canon_run_evals`)

**Interfaces:**
- Consumes: `karl_canon::parse_registry_source` (Task 4), `POST /cdlc/packages/:id/evals` (Task 2), the existing `canon_registry::resolve(org, name, version, kind) -> Result<PkgFull, String>` and `send_authed`.
- Produces: `canon_registry::push_evals(pkg_id: i64, results: &[karl_canon::EvalResult]) -> Result<(), String>` and the private `push_results_for(repo_root: &Path, skill: &str)` in `canon_eval.rs`.

- [ ] **Step 1: Add the HTTP call**

In `crates/app/src/canon_registry.rs`, after `record_install`:

```rust
/// Push a skill's eval outcomes to the registry (Plan B). Pass/fail only —
/// `EvalResult.reason` is free text an LLM wrote about the user's repo and
/// never leaves the machine.
pub async fn push_evals(pkg_id: i64, results: &[karl_canon::EvalResult]) -> Result<(), String> {
    let url = format!("{}/cdlc/packages/{}/evals", auth::backend_url(), pkg_id);
    let rows: Vec<Value> = results
        .iter()
        .map(|r| {
            serde_json::json!({
                "eval_id": r.eval_id,
                "pass": r.pass,
                "baseline_pass": r.baseline_pass,
                "ran_at_ms": r.ran_at_ms,
            })
        })
        .collect();
    let body = serde_json::json!({ "results": rows });
    send_authed(|j| client().post(&url).bearer_auth(j).json(&body)).await?;
    Ok(())
}
```

- [ ] **Step 2: Add the two new `PkgMeta` fields**

Still in `crates/app/src/canon_registry.rs`, extend the client-side `PkgMeta`. `#[serde(default)]` is load-bearing: a desktop build talking to a server that has not deployed Task 3 must still parse search results.

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PkgMeta {
    pub id: i64,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub description: String,
    pub publisher_login: String,
    pub installs: i32,
    pub sha: String,
    #[serde(default = "default_kind")]
    pub kind: String,
    /// Cross-org eval aggregate. Absent on a pre-Plan-B server → 0/0 → hidden.
    #[serde(default)]
    pub eval_passed: i64,
    #[serde(default)]
    pub eval_total: i64,
}
```

- [ ] **Step 3: Write the push helper**

In `crates/app/src/canon_eval.rs`, above `canon_run_evals`:

```rust
/// Share this skill's results with the org registry, if it came from one.
///
/// Best-effort by construction: a locally-authored skill returns early with no
/// network call, and every failure past that point is a warn. The evals have
/// already run and are already on disk — a push problem must never surface as
/// an error for a side effect the user did not ask for.
async fn push_results_for(repo_root: &std::path::Path, skill: &str) {
    let Ok(manifest) = karl_canon::read_manifest(repo_root) else {
        return;
    };
    let Some(entry) = manifest.installed.iter().find(|i| i.name == skill) else {
        return; // authored here, not installed — nothing to attribute it to
    };
    let Some((org, name, version)) = karl_canon::parse_registry_source(&entry.source) else {
        return; // local: source — no registry to push to
    };
    let results = karl_canon::read_results(repo_root);
    let Some(inner) = results.get(skill) else {
        return;
    };
    let rows: Vec<karl_canon::EvalResult> = inner.values().cloned().collect();
    if rows.is_empty() {
        return;
    }
    // Resolve the PINNED version, never `latest` — results belong to the row
    // the user actually installed.
    let pkg = match crate::canon_registry::resolve(&org, &name, &version, "skill").await {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!(target: "canon", skill, error = %e, "eval push: resolve failed");
            return;
        }
    };
    if let Err(e) = crate::canon_registry::push_evals(pkg.id, &rows).await {
        tracing::warn!(target: "canon", skill, error = %e, "eval push failed");
    }
}
```

- [ ] **Step 4: Call it**

In `canon_run_evals`, the function currently ends with:

```rust
    emit_progress(&app, &skill, "", "done", "");
    Ok(())
}
```

Change it to push before signalling done, so the UI's `onDone` refresh sees the finished state:

```rust
    push_results_for(&repo_root, &skill).await;
    emit_progress(&app, &skill, "", "done", "");
    Ok(())
}
```

Leave the two **early** returns (`no evals found`, `claude CLI not found`) alone — nothing ran, so there is nothing to push.

- [ ] **Step 5: Verify it compiles**

```bash
cargo test -p covenant 2>&1 | tail -20
cargo clippy -p covenant --all-targets 2>&1 | tail -20
```

Expected: compiles clean. (The crate name is whatever `crates/app/Cargo.toml` declares — check with `head -3 crates/app/Cargo.toml` if `-p covenant` is rejected.)

- [ ] **Step 6: Commit**

```bash
git add crates/app/src/canon_registry.rs crates/app/src/canon_eval.rs
git commit -m "feat(evals): push pass/fail to the org registry after a run"
```

---

### Task 6: Show the aggregate on the registry card

**Files:**
- Modify: `ui/src/api.ts:1855-1864` (the `PkgMeta` interface)
- Modify: `ui/src/canon/cockpit/view.ts` (the `meta` line in `renderRegistrySection`, around line 2012)
- Test: `ui/src/canon/cockpit/view.test.ts`

**Interfaces:**
- Consumes: `PkgMeta.eval_passed` / `PkgMeta.eval_total` from Task 3.
- Produces: `evalChip(p: PkgMeta): string | null` exported from `ui/src/canon/cockpit/view.ts`.

- [ ] **Step 1: Extend the TS type**

`ui/src/api.ts`:

```ts
export interface PkgMeta {
  id: number;
  name: string;
  version: string;
  description: string;
  publisher_login: string;
  installs: number;
  sha: string;
  kind: string;
  /** Cross-org eval aggregate for this version. 0/0 when nobody has run them. */
  eval_passed: number;
  eval_total: number;
}
```

- [ ] **Step 2: Write the failing test**

Append to `ui/src/canon/cockpit/view.test.ts`:

```ts
describe("evalChip", () => {
  const pkg = (eval_passed: number, eval_total: number): PkgMeta => ({
    id: 1, name: "kyc-peru", version: "2.1.0", description: "",
    publisher_login: "karluiz", installs: 14, sha: "abc1234", kind: "skill",
    eval_passed, eval_total,
  });

  it("reads as a pass-rate when the org has run evals", () => {
    expect(evalChip(pkg(12, 14))).toBe("12/14 evals");
  });

  it("is absent when nobody has run any", () => {
    // 0/0 would read as a failing package rather than an unmeasured one.
    expect(evalChip(pkg(0, 0))).toBeNull();
  });

  it("shows a total wipeout rather than hiding it", () => {
    expect(evalChip(pkg(0, 3))).toBe("0/3 evals");
  });
});
```

Add `evalChip` to the existing import from `./view` at the top of the test file, and `PkgMeta` to the import from `../../api`.

- [ ] **Step 3: Run it to verify it fails**

```bash
npx vitest run ui/src/canon/cockpit/view.test.ts
```

Expected: FAIL — `evalChip is not a function`.

- [ ] **Step 4: Write the implementation**

In `ui/src/canon/cockpit/view.ts`, near the other module-level helpers (beside `loopSubhead`):

```ts
/** The org-wide pass-rate segment for a registry card, or null when nobody has
 *  run this version's evals — "0/0 evals" would read as a broken package
 *  rather than an unmeasured one. */
export function evalChip(p: PkgMeta): string | null {
  return p.eval_total > 0 ? `${p.eval_passed}/${p.eval_total} evals` : null;
}
```

- [ ] **Step 5: Run it to verify it passes**

```bash
npx vitest run ui/src/canon/cockpit/view.test.ts
```

Expected: 3 new tests passing, no regressions.

- [ ] **Step 6: Put it on the card**

In `renderRegistrySection`, the `meta` and `stats` construction currently reads:

```ts
            const installs = `${r.installs} ${r.installs === 1 ? "install" : "installs"}`;
            const meta = wire === "skill"
              ? `${r.version} · ${installs} · ${r.publisher_login}`
              : `${installs} · ${r.publisher_login}`;
```

Becomes:

```ts
            const installs = `${r.installs} ${r.installs === 1 ? "install" : "installs"}`;
            const evals = evalChip(r);
            const meta = wire === "skill"
              ? [r.version, installs, evals, r.publisher_login].filter(Boolean).join(" · ")
              : `${installs} · ${r.publisher_login}`;
```

Only skills get the segment — `canon_run_evals` is skill-scoped, so `eval_total` is structurally 0 for every other kind.

- [ ] **Step 7: Typecheck and run the full suite**

```bash
npx tsc --noEmit
npx vitest run
```

Expected: no type errors, suite green. Note `main` has pre-existing failures unrelated to this work — compare against `git stash && npx vitest run` if anything looks suspicious.

- [ ] **Step 8: Commit**

```bash
git add ui/src/api.ts ui/src/canon/cockpit/view.ts ui/src/canon/cockpit/view.test.ts
git commit -m "feat(evals): registry cards show the org-wide pass-rate"
```

---

### Task 7: Disclose the push in the confirm card

The run is already gated on cost. It now also shares data, and the user must read that before the first push, not after.

**Files:**
- Modify: `ui/src/canon/evals.ts:20-24`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing — copy only.

- [ ] **Step 1: Change the message**

In `ui/src/canon/evals.ts`, the `openConfirmPrompt` call:

```ts
  openConfirmPrompt({
    label: "Run evals",
    message:
      `Run evals for "${skill}"? Each eval is a full agent run plus a judge call — this can take minutes and costs tokens. ` +
      `Pass/fail results are shared with your org's registry — never the judge's reasoning.`,
    confirmText: "Run",
    onConfirm: () => { void execute(cwd, skill, btn, onDone); },
  });
```

- [ ] **Step 2: Verify nothing broke**

```bash
npx tsc --noEmit
npx vitest run ui/src/canon
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add ui/src/canon/evals.ts
git commit -m "feat(evals): disclose the registry push in the run confirmation"
```

---

### Task 8: End-to-end verification

No code. Do not skip — Tasks 1–7 never once proved the two repos agree.

- [ ] **Step 1: Confirm the server is live**

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  https://forge.covenant.uno/cdlc/packages/1/evals \
  -H 'content-type: application/json' -d '{"results":[]}'
```

Expected: `401`.

- [ ] **Step 2: Run the app**

```bash
npm run tauri:dev
```

Remember the dev build is a separate app (`com.karluiz.covenant.dev`) with its own config — it must be signed in to Covenant and have an org selected, or the push has no JWT and warns.

- [ ] **Step 3: Install a skill from the registry, then evaluate it**

In the Canon cockpit: Registry → install any skill into a repo → Skills → Run evals on it. Accept the confirm card and read it: the sharing sentence must be there.

- [ ] **Step 4: Confirm the push happened**

Watch the `tauri:dev` console. Success is **silence** — no `eval push` warn line. A warn tells you which step failed (`resolve failed` = wrong org/version, anything else = the POST).

- [ ] **Step 5: Confirm the number surfaces**

Go back to Registry and find the same package. Its meta line must now read `<version> · N installs · X/Y evals · <publisher>`, with `Y` equal to the number of evals that ran.

- [ ] **Step 6: Confirm the upsert**

Re-run the evals on the same skill. `Y` must stay the same. If it doubled, the `ON CONFLICT` clause is not firing and Task 2 is wrong.

- [ ] **Step 7: Confirm a local skill pushes nothing**

Author a skill locally (Canon → Skills → New), give it an eval, run it. The console must show no push attempt at all — `parse_registry_source` returns `None` for a `local:` source before any network call.

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| `cdlc_evals` schema, upsert-not-history, version scoping | 1 |
| `POST /cdlc/packages/:id/evals`, member gate, validation caps, `ran_at` clamp | 2 |
| `reason` never sent | 2 (payload), 5 (client mapping) |
| Lateral-join aggregate on `PkgMeta`, no new read endpoint | 3 |
| `parse_registry_source` | 4 |
| Client push, registry-source-only, warn-never-fail, pinned version | 5 |
| Registry card meta line, hidden at 0/0 | 6 |
| Consent copy | 7 |
| Deploy order (server first) | 3 step 7, 8 step 1 |
| Testing table | 1, 2, 3 (server), 4 (canon), 6 (ui) |

No gaps.

**Type consistency:** `EvalRow` / `PushReq` / `validate` are defined in Task 2 step 3 and used in Task 2 steps 1 and 5. `PkgMeta.eval_passed` / `eval_total` are named identically in the server struct (Task 3), the SQL aliases (Tasks 1, 3), the Rust client (Task 5), and the TS interface (Task 6). `parse_registry_source` returns `Option<(String, String, String)>` in Task 4 and is destructured as `(org, name, version)` in Task 5. `push_evals(pkg_id: i64, results: &[EvalResult])` is defined in Task 5 step 1 and called in step 3. `evalChip` is defined in Task 6 step 4 and used in steps 2 and 6.

**Known deviation from the spec:** the spec's testing table lists server body-validation tests and DB tests separately; Task 2 and Tasks 1/3 respectively cover them, with the DB tests split across the two tasks that introduce the SQL they assert.
