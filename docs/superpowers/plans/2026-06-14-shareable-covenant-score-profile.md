# Shareable Covenant Score + Achievements Profile — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a signed-in user opt in to publish a shareable profile at `forge.covenant.uno/u/<login>` showing a real Covenant Score (0–10), their 6 reputation dimensions, and their achievement badges.

**Architecture:** Desktop (`karlTerminal`) computes a composite score + an aggregates-only snapshot and PUTs it (opt-in) to the backend; the backend (`covenant-server`) stores it, recomputes the score server-side (anti-spoof), and renders it into the existing `/u/:login` profile. Two repos, one contract (the snapshot schema + `/profile/publish` endpoints).

**Tech Stack:** Rust (`rusqlite` desktop store, `axum` 0.7 + `sqlx`/Postgres backend, `reqwest`, `minijinja` templates), TypeScript/Tauri UI.

**Spec:** `docs/superpowers/specs/2026-06-14-shareable-covenant-score-profile-design.md`

**Repos:**
- Desktop: `/Users/carlosgallardoarenas/Sources/karlTerminal` (score crate package `karl-score`, app package `covenant`).
- Backend: `/Users/carlosgallardoarenas/Sources/covenant-server` (single crate; run `cargo` from that dir, no `-p`).

**Execution note:** Use a **separate git worktree per repo**. Tasks 1–5 are desktop; Tasks 6–8 are backend; Task 9 is cross-repo verification.

---

## Conventions

- The score formula is **duplicated** in both repos (small pure fn) and tested on both sides to the same bands. Constants: `REP_SCALE=600.0`, `STREAK_SCALE=21.0`, `W_REP=0.70`, `W_ACT=0.30`.
- Score rounding: `headline = round1((W_REP*rep01 + W_ACT*act01) * 10.0)` where `round1(x) = (x*10.0).round()/10.0`.
- Snapshot is **aggregates only** — the builder constructs explicit fields; there is no passthrough of `AchievementAward.repo/branch` or any raw row.

---

## File Structure

**Desktop (`karlTerminal`):**
- `crates/score/src/profile_card.rs` (new) — score formula, snapshot types, snapshot builder (pure).
- `crates/score/src/lib.rs` — `pub mod profile_card;` + re-exports.
- `crates/score/src/store.rs` — v5 `kv` migration + `get_publish_profile()`/`set_publish_profile()`.
- `crates/score/src/sync.rs` — `publish_profile()` / `unpublish_profile()`.
- `crates/app/src/score_sync_commands.rs` — publish toggle/share/preview commands + re-publish hook.
- `crates/app/src/lib.rs` — register new commands.
- `ui/src/score/api.ts`, `ui/src/score/profile.ts` (new), `ui/src/settings/panel.ts` — Public Profile UI card.

**Backend (`covenant-server`):**
- `migrations/0003_profile.sql` (new).
- `src/score.rs` (new) — shared score formula.
- `src/publish.rs` (new) — `PUT`/`DELETE /profile/publish`.
- `src/profile.rs` — load + render published snapshot.
- `src/templates/profile.html` — score hero + dimension bars + badge grid + OG meta.
- `src/main.rs` — `mod score; mod publish;` + routes.

---

# DESKTOP (repo: karlTerminal)

## Task 1: Score formula + snapshot types + builder (pure)

**Files:**
- Create: `crates/score/src/profile_card.rs`
- Modify: `crates/score/src/lib.rs`

- [ ] **Step 1: Write failing tests**

Create `crates/score/src/profile_card.rs` with this test module at the bottom (and the imports at top as shown in Step 3):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::achievements::{AchievementCategory, CategoryRollup};
    use crate::types::{Summary, User};
    use crate::achievements::AchievementAward;

    fn rollup(cat: AchievementCategory, points: u32) -> CategoryRollup {
        CategoryRollup { category: cat, points }
    }

    #[test]
    fn fresh_user_scores_near_zero() {
        let s = compute_score(&[], 0);
        assert!(s.headline < 0.1, "got {}", s.headline);
        assert_eq!(s.reputation01, 0.0);
        assert_eq!(s.activity01, 0.0);
    }

    #[test]
    fn solid_user_lands_in_mid_high_band() {
        // ~900 reputation points + a 14-day streak
        let dims = [rollup(AchievementCategory::Craft, 600), rollup(AchievementCategory::Reliability, 300)];
        let s = compute_score(&dims, 14);
        assert!(s.headline >= 6.0 && s.headline <= 9.0, "got {}", s.headline);
    }

    #[test]
    fn score_is_monotonic_in_reputation() {
        let a = compute_score(&[rollup(AchievementCategory::Craft, 200)], 5).headline;
        let b = compute_score(&[rollup(AchievementCategory::Craft, 800)], 5).headline;
        assert!(b > a);
    }

    #[test]
    fn headline_rounded_to_one_decimal_and_capped() {
        let dims = [rollup(AchievementCategory::Craft, 100_000)];
        let s = compute_score(&dims, 100_000);
        assert!(s.headline <= 10.0);
        assert_eq!((s.headline * 10.0).fract(), 0.0, "one decimal place");
    }

    #[test]
    fn snapshot_has_all_six_dimensions_even_when_missing() {
        let user = User { github_id: 1, login: "x".into(), avatar_url: "a".into(), connected_at_ms: 0 };
        let summary = Summary { total_prompts: 10, total_commits: 2, today_prompts: 0, today_commits: 0,
            current_streak: 3, longest_streak: 3, total_tokens: 0, total_specs: 0 };
        let snap = build_snapshot(&user, &summary, &[rollup(AchievementCategory::Craft, 50)], &[], 123);
        assert_eq!(snap.dimensions.len(), 6);
        assert_eq!(snap.schema_version, 1);
        assert_eq!(snap.totals.current_streak, 3);
    }

    #[test]
    fn snapshot_never_leaks_repo_or_branch() {
        // An award carries repo/branch internally; the snapshot must drop them.
        let award = AchievementAward {
            id: 1, achievement_id: "finisher".into(), tier: 2, title: "The Finisher".into(),
            subject_type: "operator".into(), subject_id: Some("op".into()),
            scope_type: "operator".into(), scope_id: Some("op".into()),
            repo: Some("SECRET-REPO".into()), branch: Some("SECRET-BRANCH".into()),
            earned_at_ms: 99, seen_at_ms: None,
        };
        let user = User { github_id: 1, login: "x".into(), avatar_url: "a".into(), connected_at_ms: 0 };
        let summary = Summary { total_prompts: 0, total_commits: 0, today_prompts: 0, today_commits: 0,
            current_streak: 0, longest_streak: 0, total_tokens: 0, total_specs: 0 };
        let snap = build_snapshot(&user, &summary, &[], &[award], 1);
        let json = serde_json::to_string(&snap).unwrap();
        assert!(!json.contains("SECRET-REPO"), "repo leaked into snapshot");
        assert!(!json.contains("SECRET-BRANCH"), "branch leaked into snapshot");
        assert_eq!(snap.awards.len(), 1);
        assert_eq!(snap.awards[0].achievement_id, "finisher");
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p karl-score profile_card`
Expected: FAIL — module/functions don't exist.

- [ ] **Step 3: Implement the module**

Put this at the **top** of `crates/score/src/profile_card.rs` (above the test module):

```rust
//! Pure, side-effect-free composite "Covenant Score" + the aggregates-only
//! public profile snapshot. No DB, no network. See the design doc for the
//! formula and the privacy contract.

use serde::{Deserialize, Serialize};

use crate::achievements::{
    find_definition, AchievementAward, AchievementCategory, AchievementRarity, CategoryRollup,
};
use crate::types::{Summary, User};

const REP_SCALE: f64 = 600.0;
const STREAK_SCALE: f64 = 21.0;
const W_REP: f64 = 0.70;
const W_ACT: f64 = 0.30;

const ALL_CATEGORIES: [AchievementCategory; 6] = [
    AchievementCategory::Craft,
    AchievementCategory::Safety,
    AchievementCategory::Reliability,
    AchievementCategory::Orchestration,
    AchievementCategory::Memory,
    AchievementCategory::Focus,
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ScoreBreakdown {
    pub headline: f64,     // 0.0..=10.0, one decimal
    pub reputation01: f64, // 0..1
    pub activity01: f64,   // 0..1
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotDimension {
    pub category: AchievementCategory,
    pub points: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotAward {
    pub achievement_id: String,
    pub tier: u32,
    pub rarity: AchievementRarity,
    pub title: String,
    pub earned_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotTotals {
    pub awards_count: u32,
    pub current_streak: u32,
    pub total_prompts: u64,
    pub total_commits: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PublicProfileSnapshot {
    pub schema_version: u32,
    pub github_id: i64,
    pub login: String,
    pub avatar_url: String,
    pub generated_at_ms: i64,
    pub score: ScoreBreakdown,
    pub dimensions: Vec<SnapshotDimension>,
    pub awards: Vec<SnapshotAward>,
    pub totals: SnapshotTotals,
}

fn round1(x: f64) -> f64 {
    (x * 10.0).round() / 10.0
}

/// The documented composite score. 70% saturating reputation, 30% saturating streak.
pub fn compute_score(dimensions: &[CategoryRollup], current_streak: u32) -> ScoreBreakdown {
    let rep_total: u32 = dimensions.iter().map(|d| d.points).sum();
    let rep01 = 1.0 - (-(rep_total as f64) / REP_SCALE).exp();
    let act01 = 1.0 - (-(current_streak as f64) / STREAK_SCALE).exp();
    let headline = round1((W_REP * rep01 + W_ACT * act01) * 10.0);
    ScoreBreakdown { headline, reputation01: rep01, activity01: act01 }
}

/// Build the aggregates-only public snapshot. Explicitly constructs each field;
/// never copies `AchievementAward.repo`/`branch`/scope ids.
pub fn build_snapshot(
    user: &User,
    summary: &Summary,
    by_category: &[CategoryRollup],
    awards: &[AchievementAward],
    generated_at_ms: i64,
) -> PublicProfileSnapshot {
    let score = compute_score(by_category, summary.current_streak);

    let dimensions = ALL_CATEGORIES
        .iter()
        .map(|c| SnapshotDimension {
            category: *c,
            points: by_category
                .iter()
                .find(|r| r.category == *c)
                .map(|r| r.points)
                .unwrap_or(0),
        })
        .collect();

    let snapshot_awards = awards
        .iter()
        .map(|a| SnapshotAward {
            achievement_id: a.achievement_id.clone(),
            tier: a.tier,
            rarity: find_definition(&a.achievement_id)
                .map(|d| d.rarity)
                .unwrap_or(AchievementRarity::Common),
            title: a.title.clone(),
            earned_at_ms: a.earned_at_ms,
        })
        .collect::<Vec<_>>();

    PublicProfileSnapshot {
        schema_version: 1,
        github_id: user.github_id,
        login: user.login.clone(),
        avatar_url: user.avatar_url.clone(),
        generated_at_ms,
        score,
        dimensions,
        awards: snapshot_awards,
        totals: SnapshotTotals {
            awards_count: awards.len() as u32,
            current_streak: summary.current_streak,
            total_prompts: summary.total_prompts,
            total_commits: summary.total_commits,
        },
    }
}
```

Add to `crates/score/src/lib.rs` (near the other `pub mod` lines):

```rust
pub mod profile_card;
pub use profile_card::{PublicProfileSnapshot, ScoreBreakdown};
```

(If `find_definition`/`AchievementRarity`/`AchievementCategory` aren't already `pub` in `achievements.rs`, they are — verified during planning. `AchievementRarity` and `AchievementCategory` derive `Serialize` with `#[serde(rename_all="snake_case")]`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p karl-score profile_card`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add crates/score/src/profile_card.rs crates/score/src/lib.rs
git commit -m "feat(score): composite Covenant Score + aggregates-only profile snapshot"
```

---

## Task 2: Publish-profile flag in the score store (v5 kv migration)

**Files:**
- Modify: `crates/score/src/store.rs`

- [ ] **Step 1: Write failing test**

Add to the `#[cfg(test)] mod` in `crates/score/src/store.rs` (use the existing tempdir pattern in that file):

```rust
#[test]
fn publish_profile_flag_defaults_false_and_persists() {
    let tmp = tempfile::tempdir().unwrap();
    let store = ScoreStore::open(tmp.path()).unwrap();
    assert!(!store.get_publish_profile().unwrap(), "default must be false");
    store.set_publish_profile(true).unwrap();
    assert!(store.get_publish_profile().unwrap());
    store.set_publish_profile(false).unwrap();
    assert!(!store.get_publish_profile().unwrap());
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p karl-score publish_profile_flag`
Expected: FAIL — methods don't exist.

- [ ] **Step 3: Add v5 migration + accessors**

In `ScoreStore::open`, after the `if v < 4 { … }` migration block (and before the struct is returned), add:

```rust
        let v: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap_or(0);
        if v < 5 {
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS kv (
                    key   TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                 );
                 PRAGMA user_version = 5;",
            )?;
        }
```

Add these methods in the `impl ScoreStore` block (near the sync_cursor accessors):

```rust
    pub fn get_publish_profile(&self) -> Result<bool> {
        let conn = self.connection();
        let conn = conn.lock().unwrap();
        let v: Option<String> = conn
            .query_row("SELECT value FROM kv WHERE key = 'publish_profile'", [], |r| r.get(0))
            .optional()?;
        Ok(v.as_deref() == Some("1"))
    }

    pub fn set_publish_profile(&self, enabled: bool) -> Result<()> {
        let conn = self.connection();
        let conn = conn.lock().unwrap();
        conn.execute(
            "INSERT INTO kv(key, value) VALUES ('publish_profile', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [if enabled { "1" } else { "0" }],
        )?;
        Ok(())
    }
```

(`optional()` comes from `rusqlite::OptionalExtension`, already imported in `store.rs`. `self.connection()` returns the shared `Arc<Mutex<Connection>>` — verified usage pattern in `status()` in `sync.rs`.)

- [ ] **Step 4: Run to verify pass**

Run: `cargo test -p karl-score publish_profile_flag`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/score/src/store.rs
git commit -m "feat(score): persist publish-profile opt-in flag (kv table, v5)"
```

---

## Task 3: publish/unpublish transport in sync.rs

**Files:**
- Modify: `crates/score/src/sync.rs`

- [ ] **Step 1: Implement publish/unpublish (transport — verified via Task 9 e2e + Task 4 commands)**

Add to `crates/score/src/sync.rs`:

```rust
use crate::profile_card::{build_snapshot, PublicProfileSnapshot};

#[derive(Debug, Deserialize)]
struct PublishResp {
    url: String,
    #[allow(dead_code)]
    covenant_score: f64,
}

/// Build the current public snapshot from local data. Returns None if not signed in.
pub fn current_snapshot(store: &ScoreStore) -> std::result::Result<Option<PublicProfileSnapshot>, SyncError> {
    let user = match crate::session::current(store)? {
        Some(u) => u,
        None => return Ok(None),
    };
    let summary = store.summary()?;
    let ach = store.achievement_summary()?;
    let awards = store.achievement_awards_recent(10_000)?;
    let now = chrono::Utc::now().timestamp_millis();
    Ok(Some(build_snapshot(&user, &summary, &ach.by_category, &awards, now)))
}

/// PUT the current snapshot to the backend. Returns the public profile URL.
pub async fn publish_profile(store: &ScoreStore) -> std::result::Result<String, SyncError> {
    let jwt = auth::load_jwt()?.ok_or(SyncError::NotSignedIn)?;
    let snap = current_snapshot(store)?.ok_or(SyncError::NotSignedIn)?;
    let backend = auth::backend_url();
    let url = format!("{backend}/profile/publish");
    let resp = reqwest::Client::new()
        .put(&url)
        .bearer_auth(&jwt)
        .json(&snap)
        .send()
        .await?;
    if !resp.status().is_success() {
        return Err(SyncError::Server(resp.text().await.unwrap_or_default()));
    }
    let body: PublishResp = resp.json().await?;
    Ok(body.url)
}

/// DELETE the published profile (unpublish). Idempotent on the server.
pub async fn unpublish_profile() -> std::result::Result<(), SyncError> {
    let jwt = auth::load_jwt()?.ok_or(SyncError::NotSignedIn)?;
    let backend = auth::backend_url();
    let url = format!("{backend}/profile/publish");
    let resp = reqwest::Client::new()
        .delete(&url)
        .bearer_auth(&jwt)
        .send()
        .await?;
    if !resp.status().is_success() {
        return Err(SyncError::Server(resp.text().await.unwrap_or_default()));
    }
    Ok(())
}
```

(`store.summary()`, `store.achievement_summary()`, `store.achievement_awards_recent(limit)`, and `crate::session::current(store)` all exist — verified during planning. `SyncError`, `auth::load_jwt`, `auth::backend_url` are already in this file.)

- [ ] **Step 2: Build to verify it compiles**

Run: `cargo build -p karl-score`
Expected: clean build.

- [ ] **Step 3: Commit**

```bash
git add crates/score/src/sync.rs
git commit -m "feat(score): publish/unpublish profile snapshot transport"
```

---

## Task 4: Tauri commands + re-publish on sync

**Files:**
- Modify: `crates/app/src/score_sync_commands.rs`, `crates/app/src/lib.rs`

- [ ] **Step 1: Add commands**

In `crates/app/src/score_sync_commands.rs`, add:

```rust
use karl_score::profile_card::PublicProfileSnapshot;

#[tauri::command]
pub fn score_profile_get_publish(state: State<'_, ScoreState>) -> Result<bool, String> {
    state.0.get_publish_profile().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn score_profile_set_publish(
    state: State<'_, ScoreState>,
    enabled: bool,
) -> Result<Option<String>, String> {
    state.0.set_publish_profile(enabled).map_err(|e| e.to_string())?;
    if enabled {
        let url = sync::publish_profile(&state.0).await.map_err(|e| e.to_string())?;
        Ok(Some(url))
    } else {
        sync::unpublish_profile().await.map_err(|e| e.to_string())?;
        Ok(None)
    }
}

#[tauri::command]
pub fn score_profile_preview(state: State<'_, ScoreState>) -> Result<Option<PublicProfileSnapshot>, String> {
    sync::current_snapshot(&state.0).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn score_profile_share_url(state: State<'_, ScoreState>) -> Result<Option<String>, String> {
    let user = karl_score::session::current(&state.0).map_err(|e| e.to_string())?;
    Ok(user.map(|u| format!("{}/u/{}", karl_score::auth::backend_url(), u.login)))
}
```

Then update the existing `score_sync_now` in the same file to re-publish when enabled — after the `push_drain` call succeeds, before returning:

```rust
    // re-publish the profile snapshot if the user opted in
    if store.get_publish_profile().unwrap_or(false) {
        let _ = sync::publish_profile(&store).await; // best-effort; sync result is the return value
    }
```

- [ ] **Step 2: Register the commands**

In `crates/app/src/lib.rs`, inside `tauri::generate_handler![ … ]` (near `score_sync_commands::score_sync_now`), add:

```rust
            score_sync_commands::score_profile_get_publish,
            score_sync_commands::score_profile_set_publish,
            score_sync_commands::score_profile_preview,
            score_sync_commands::score_profile_share_url,
```

- [ ] **Step 3: Build**

Run: `cargo build -p covenant`
Expected: clean build.

- [ ] **Step 4: Commit**

```bash
git add crates/app/src/score_sync_commands.rs crates/app/src/lib.rs
git commit -m "feat(app): publish-profile commands + re-publish on sync"
```

---

## Task 5: Public Profile UI card

**Files:**
- Modify: `ui/src/score/api.ts`
- Create: `ui/src/score/profile.ts`
- Modify: `ui/src/settings/panel.ts` (mount next to the achievements card)

- [ ] **Step 1: Add typed API wrappers**

In `ui/src/score/api.ts`, add (mirroring the existing `invoke`-wrapper style in that file):

```typescript
export interface PublicProfileSnapshot {
  schema_version: number;
  github_id: number;
  login: string;
  avatar_url: string;
  generated_at_ms: number;
  score: { headline: number; reputation01: number; activity01: number };
  dimensions: { category: string; points: number }[];
  awards: { achievement_id: string; tier: number; rarity: string; title: string; earned_at_ms: number }[];
  totals: { awards_count: number; current_streak: number; total_prompts: number; total_commits: number };
}

export async function scoreProfileGetPublish(): Promise<boolean> {
  return invoke("score_profile_get_publish");
}
export async function scoreProfileSetPublish(enabled: boolean): Promise<string | null> {
  return invoke("score_profile_set_publish", { enabled });
}
export async function scoreProfilePreview(): Promise<PublicProfileSnapshot | null> {
  return invoke("score_profile_preview");
}
export async function scoreProfileShareUrl(): Promise<string | null> {
  return invoke("score_profile_share_url");
}
```

(Match the existing import of `invoke` at the top of `api.ts`.)

- [ ] **Step 2: Create the card renderer**

Create `ui/src/score/profile.ts`:

```typescript
import {
  scoreProfileGetPublish, scoreProfileSetPublish,
  scoreProfilePreview, scoreProfileShareUrl,
  type PublicProfileSnapshot,
} from "./api";

const PRIVACY_LINE =
  "Only aggregates are published: your score, the 6 reputation dimensions, " +
  "earned badges, streak, and total prompt/commit counts. Never repo names, " +
  "branches, paths, commands, or code.";

export async function renderPublicProfileCard(host: HTMLElement): Promise<void> {
  const [enabled, snap, url] = await Promise.all([
    scoreProfileGetPublish().catch(() => false),
    scoreProfilePreview().catch(() => null),
    scoreProfileShareUrl().catch(() => null),
  ]);

  host.innerHTML = "";
  const card = document.createElement("div");
  card.className = "cov-card";

  if (!snap) {
    card.innerHTML = `<p class="eyebrow">Public profile</p>
      <p class="cov-muted">Sign in to Covenant to publish a shareable profile.</p>`;
    host.appendChild(card);
    return;
  }

  card.innerHTML = `
    <div class="cov-pubprofile-head">
      <p class="eyebrow">Public profile</p>
      <label class="cov-toggle">
        <input type="checkbox" data-pub-toggle ${enabled ? "checked" : ""} />
        <span>Publish my Covenant Score & achievements</span>
      </label>
    </div>
    <div class="cov-pubprofile-preview">
      <div class="cov-score-hero">${snap.score.headline.toFixed(1)}</div>
      <div class="cov-muted">Reputation ${(snap.score.reputation01 * 10).toFixed(1)}
        · Consistency ${(snap.score.activity01 * 10).toFixed(1)}</div>
      <div class="cov-pubprofile-badges">${snap.awards.length} badges · ${snap.totals.current_streak}-day streak</div>
    </div>
    <div class="cov-pubprofile-share ${enabled ? "" : "cov-hidden"}">
      <code data-share-url>${url ?? ""}</code>
      <button data-copy>Copy link</button>
      <button data-view>View profile</button>
    </div>
    <p class="cov-muted cov-tiny">${PRIVACY_LINE}</p>`;

  const toggle = card.querySelector<HTMLInputElement>("[data-pub-toggle]")!;
  const share = card.querySelector<HTMLElement>(".cov-pubprofile-share")!;
  toggle.addEventListener("change", async () => {
    toggle.disabled = true;
    try {
      const newUrl = await scoreProfileSetPublish(toggle.checked);
      share.classList.toggle("cov-hidden", !toggle.checked);
      if (newUrl) card.querySelector("[data-share-url]")!.textContent = newUrl;
    } catch (e) {
      toggle.checked = !toggle.checked; // revert on failure
    } finally {
      toggle.disabled = false;
    }
  });
  card.querySelector("[data-copy]")?.addEventListener("click", () => {
    const u = card.querySelector("[data-share-url]")?.textContent ?? "";
    if (u) navigator.clipboard.writeText(u);
  });
  card.querySelector("[data-view]")?.addEventListener("click", () => {
    const u = card.querySelector("[data-share-url]")?.textContent ?? "";
    if (u) window.open(u, "_blank");
  });

  host.appendChild(card);
}
```

- [ ] **Step 3: Mount it next to the achievements card**

In `ui/src/settings/panel.ts`, find where `renderAchievementsCard(host)` is called (the achievements area) and add, right after it, a mount for the new card:

```typescript
import { renderPublicProfileCard } from "../score/profile";
// … where the achievements card is mounted:
const pubHost = document.createElement("div");
achievementsContainer.appendChild(pubHost); // same container that holds the achievements card
void renderPublicProfileCard(pubHost);
```

(Use the same container variable the existing `renderAchievementsCard` call uses. Add any minimal CSS for `.cov-pubprofile-*`, `.cov-toggle`, `.cov-hidden`, `.cov-tiny` to the score styles file consistent with existing `.cov-card` styling.)

- [ ] **Step 4: Build the UI**

Run: `cd ui && npm run build` (or the repo's typecheck) — Expected: no TS errors.

- [ ] **Step 5: Commit**

```bash
git add ui/src/score/api.ts ui/src/score/profile.ts ui/src/settings/panel.ts ui/src/score/
git commit -m "feat(ui): Public profile card — opt-in toggle, preview, share link"
```

---

# BACKEND (repo: covenant-server)

## Task 6: Migration 0003 + shared score formula

**Files:**
- Create: `migrations/0003_profile.sql`
- Create: `src/score.rs`
- Modify: `src/main.rs` (`mod score;`)

- [ ] **Step 1: Write the migration**

Create `migrations/0003_profile.sql`:

```sql
ALTER TABLE users ADD COLUMN profile_public BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE published_profiles (
  github_id      BIGINT PRIMARY KEY REFERENCES users(github_id) ON DELETE CASCADE,
  snapshot       JSONB  NOT NULL,
  covenant_score REAL   NOT NULL,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

(Migrations auto-run via `sqlx::migrate!("./migrations")` in `src/db.rs` — no manual step.)

- [ ] **Step 2: Write the failing score test**

Create `src/score.rs` with the test module:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fresh_is_zero() {
        assert!(compute_score(0, 0) < 0.1);
    }
    #[test]
    fn solid_lands_mid_high() {
        let s = compute_score(900, 14);
        assert!(s >= 6.0 && s <= 9.0, "got {s}");
    }
    #[test]
    fn capped_and_one_decimal() {
        let s = compute_score(100_000, 100_000);
        assert!(s <= 10.0);
        assert_eq!((s * 10.0).fract(), 0.0);
    }
}
```

- [ ] **Step 3: Run to verify failure**

Run (from `~/Sources/covenant-server`): `cargo test score::`
Expected: FAIL — `compute_score` not defined.

- [ ] **Step 4: Implement the formula (mirror of desktop)**

Put at the top of `src/score.rs`:

```rust
//! Server-side mirror of the desktop Covenant Score formula. The headline
//! is recomputed here from the snapshot's reputation total + streak so a
//! tampered client cannot publish an inflated number. Keep in sync with
//! `karlTerminal/crates/score/src/profile_card.rs`.

const REP_SCALE: f64 = 600.0;
const STREAK_SCALE: f64 = 21.0;
const W_REP: f64 = 0.70;
const W_ACT: f64 = 0.30;

pub fn compute_score(rep_total: i64, current_streak: i64) -> f64 {
    let rep01 = 1.0 - (-(rep_total.max(0) as f64) / REP_SCALE).exp();
    let act01 = 1.0 - (-(current_streak.max(0) as f64) / STREAK_SCALE).exp();
    let s10 = (W_REP * rep01 + W_ACT * act01) * 10.0;
    (s10 * 10.0).round() / 10.0
}
```

Add `mod score;` to `src/main.rs` (with the other `mod` lines).

- [ ] **Step 5: Run to verify pass**

Run: `cargo test score::`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add migrations/0003_profile.sql src/score.rs src/main.rs
git commit -m "feat: published_profiles table + server-side Covenant Score formula"
```

---

## Task 7: PUT/DELETE /profile/publish endpoints

**Files:**
- Create: `src/publish.rs`
- Modify: `src/main.rs` (`mod publish;` + routes)

- [ ] **Step 1: Implement the endpoints**

Create `src/publish.rs`:

```rust
use axum::{extract::State, http::HeaderMap, Json};
use serde::{Deserialize, Serialize};
use serde_json::json;
use crate::{error::{AppError, Result}, jwt, sync::bearer, AppState};

#[derive(Debug, Deserialize)]
pub struct DimIn { pub category: String, pub points: i64 }

#[derive(Debug, Deserialize)]
pub struct AwardIn {
    pub achievement_id: String,
    pub tier: i64,
    pub rarity: String,
    pub title: String,
    pub earned_at_ms: i64,
}

#[derive(Debug, Deserialize)]
pub struct TotalsIn {
    pub awards_count: i64,
    pub current_streak: i64,
    pub total_prompts: i64,
    pub total_commits: i64,
}

#[derive(Debug, Deserialize)]
pub struct SnapshotIn {
    pub schema_version: u32,
    pub avatar_url: String,
    pub dimensions: Vec<DimIn>,
    pub awards: Vec<AwardIn>,
    pub totals: TotalsIn,
    #[serde(default)] pub generated_at_ms: i64,
    // client-sent github_id/login/score are intentionally ignored
}

#[derive(Debug, Serialize)]
pub struct PublishResp { pub url: String, pub covenant_score: f64 }

pub async fn publish(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(snap): Json<SnapshotIn>,
) -> Result<Json<PublishResp>> {
    let token = bearer(&headers)?;
    let claims = jwt::verify(&state.jwt_secret, token)?;

    if snap.schema_version != 1 {
        return Err(AppError::BadRequest("unsupported schema_version".into()));
    }
    if snap.awards.len() > 500 || snap.dimensions.len() > 12 {
        return Err(AppError::BadRequest("snapshot too large".into()));
    }

    let rep_total: i64 = snap.dimensions.iter().map(|d| d.points.max(0)).sum();
    let covenant_score = crate::score::compute_score(rep_total, snap.totals.current_streak.max(0));

    // Build the server-authoritative stored snapshot: identity from the token,
    // score recomputed, only whitelisted fields persisted.
    let stored = json!({
        "schema_version": 1,
        "github_id": claims.sub,
        "login": claims.login,
        "avatar_url": snap.avatar_url,
        "generated_at_ms": snap.generated_at_ms,
        "score": {
            "headline": covenant_score,
            "reputation01": 1.0 - (-(rep_total.max(0) as f64) / 600.0).exp(),
            "activity01": 1.0 - (-(snap.totals.current_streak.max(0) as f64) / 21.0).exp(),
        },
        "dimensions": snap.dimensions.iter()
            .map(|d| json!({"category": d.category, "points": d.points.max(0)}))
            .collect::<Vec<_>>(),
        "awards": snap.awards.iter()
            .map(|a| json!({"achievement_id": a.achievement_id, "tier": a.tier,
                            "rarity": a.rarity, "title": a.title, "earned_at_ms": a.earned_at_ms}))
            .collect::<Vec<_>>(),
        "totals": {
            "awards_count": snap.totals.awards_count,
            "current_streak": snap.totals.current_streak,
            "total_prompts": snap.totals.total_prompts,
            "total_commits": snap.totals.total_commits,
        },
    });

    let mut tx = state.pool.begin().await.map_err(|e| AppError::Internal(e.into()))?;
    sqlx::query(
        "INSERT INTO published_profiles(github_id, snapshot, covenant_score, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (github_id) DO UPDATE
           SET snapshot = excluded.snapshot,
               covenant_score = excluded.covenant_score,
               updated_at = NOW()"
    )
    .bind(claims.sub).bind(&stored).bind(covenant_score)
    .execute(&mut *tx).await.map_err(|e| AppError::Internal(e.into()))?;
    sqlx::query("UPDATE users SET profile_public = TRUE WHERE github_id = $1")
        .bind(claims.sub)
        .execute(&mut *tx).await.map_err(|e| AppError::Internal(e.into()))?;
    tx.commit().await.map_err(|e| AppError::Internal(e.into()))?;

    Ok(Json(PublishResp {
        url: format!("https://forge.covenant.uno/u/{}", claims.login),
        covenant_score,
    }))
}

pub async fn unpublish(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>> {
    let token = bearer(&headers)?;
    let claims = jwt::verify(&state.jwt_secret, token)?;
    sqlx::query("UPDATE users SET profile_public = FALSE WHERE github_id = $1")
        .bind(claims.sub)
        .execute(&state.pool).await.map_err(|e| AppError::Internal(e.into()))?;
    Ok(Json(json!({"ok": true})))
}
```

(`bearer` is `pub` in `sync.rs` — verified. `AppError`, `jwt::verify`, `AppState` patterns match `sync.rs`.)

- [ ] **Step 2: Wire routes**

In `src/main.rs`: add `mod publish;` with the other mods, and add to the router (after the `/sync/*` routes):

```rust
        .route("/profile/publish", axum::routing::put(publish::publish))
        .route("/profile/publish", axum::routing::delete(publish::unpublish))
```

(Two methods on one path: chain them, e.g. `.route("/profile/publish", axum::routing::put(publish::publish).delete(publish::unpublish))`.)

- [ ] **Step 3: Build**

Run: `cargo build`
Expected: clean build.

- [ ] **Step 4: Commit**

```bash
git add src/publish.rs src/main.rs
git commit -m "feat: PUT/DELETE /profile/publish (auth, server-recomputed score)"
```

---

## Task 8: Render score + achievements on the public profile

**Files:**
- Modify: `src/profile.rs`, `src/templates/profile.html`

- [ ] **Step 1: Load the published snapshot in `profile.rs`**

In `src/profile.rs`, add a helper to fetch the published view and extend both handlers. Add:

```rust
#[derive(Serialize, Clone)]
pub struct PublishedView {
    pub covenant_score: f64,
    pub snapshot: serde_json::Value, // the stored JSONB (score, dimensions, awards, totals)
}

async fn load_published(state: &AppState, github_id: i64) -> Option<PublishedView> {
    let public: Option<bool> = sqlx::query_scalar(
        "SELECT profile_public FROM users WHERE github_id = $1")
        .bind(github_id).fetch_optional(&state.pool).await.ok().flatten();
    if public != Some(true) {
        return None;
    }
    let row: Option<(serde_json::Value, f64)> = sqlx::query_as(
        "SELECT snapshot, covenant_score FROM published_profiles WHERE github_id = $1")
        .bind(github_id).fetch_optional(&state.pool).await.ok().flatten();
    row.map(|(snapshot, covenant_score)| PublishedView { covenant_score, snapshot })
}
```

**Prerequisite:** binding/reading a JSONB column as `serde_json::Value` requires the sqlx `json` feature. Check `Cargo.toml`: if `sqlx`'s feature list lacks `json`, add it (e.g. `sqlx = { version = "…", features = [ …, "json" ] }`) and `cargo build` once before proceeding. This also covers the `.bind(&stored)` in Task 7.

In `profile_json`, after computing the existing fields, fetch `let published = load_published(&state, _id).await;` and add a `published: Option<PublishedView>` field to `ProfileJson` (include it in the struct + the constructor). In `profile_html`, fetch the same and pass to the template context:

```rust
    let published = load_published(&state, _id).await;
    // … in context! { … }:
    //   published => published,   // None → template hides the score/badges block
    //   og_title => format!("{login} · Covenant Score {}",
    //       published.as_ref().map(|p| p.covenant_score).unwrap_or(0.0)),
```

(`_id` is the `github_id` returned by `load()`. Bind it to a name so it's usable — change `let (_id, …)` to `let (gid, login, avatar_url, cells_full) = load(...)` and use `gid`.)

- [ ] **Step 2: Render in the template**

In `src/templates/profile.html`:
- In `<head>`, add OpenGraph meta:
  ```html
  <meta property="og:title" content="{{ og_title }}" />
  <meta property="og:description" content="Covenant Score & achievements" />
  <meta property="og:type" content="profile" />
  ```
- Above the existing heatmap, add a conditional block:
  ```html
  {% if published %}
  <section class="score">
    <div class="score-hero">{{ published.snapshot.score.headline }}</div>
    <div class="score-sub">Reputation · Consistency · Verified</div>
    <div class="dims">
      {% for d in published.snapshot.dimensions %}
        <div class="dim"><span>{{ d.category }}</span><b>{{ d.points }}</b></div>
      {% endfor %}
    </div>
    <div class="badges">
      {% for a in published.snapshot.awards %}
        <div class="badge r-{{ a.rarity }}" title="{{ a.title }}">{{ a.title }} · T{{ a.tier }}</div>
      {% endfor %}
    </div>
  </section>
  {% endif %}
  ```
- Add minimal CSS in the template's `<style>` for `.score-hero` (large number), `.dims`, `.badge`, and `.r-common/.r-uncommon/.r-rare/.r-epic/.r-legendary` (rarity colors), consistent with the existing dark/teal styling.

- [ ] **Step 3: Build**

Run: `cargo build`
Expected: clean build.

- [ ] **Step 4: Manual render check (no DB required for compile; full check in Task 9)**

Confirm the template parses by running the existing profile test if present, else defer the live check to Task 9.

- [ ] **Step 5: Commit**

```bash
git add src/profile.rs src/templates/profile.html
git commit -m "feat: render Covenant Score + badges on public profile (+ OG tags)"
```

---

## Task 9: End-to-end verification

- [ ] **Step 1: Backend — migrate + run locally**

From `~/Sources/covenant-server`, with a local Postgres + `DATABASE_URL`/`JWT_SECRET` set:
```bash
cargo test            # all backend tests green (score::, jwt::, …)
cargo run             # boots, runs migrations 0001..0003
```
Expected: server listens; `published_profiles` table exists.

- [ ] **Step 2: Backend — endpoint smoke test**

Mint a dev JWT (reuse `jwt::mint` via a tiny test/script or an existing dev path), then:
```bash
# PUT a minimal snapshot
curl -sS -X PUT localhost:8080/profile/publish -H "Authorization: Bearer $JWT" \
  -H 'content-type: application/json' \
  -d '{"schema_version":1,"avatar_url":"a","dimensions":[{"category":"craft","points":600}],"awards":[],"totals":{"awards_count":0,"current_streak":14,"total_prompts":0,"total_commits":0},"generated_at_ms":1}'
# → {"url":"https://forge.covenant.uno/u/<login>","covenant_score":<~6-7>}
curl -sS localhost:8080/u/<login>/json | grep -o '"published":[^,]*'   # not null
curl -sS -X DELETE localhost:8080/profile/publish -H "Authorization: Bearer $JWT"
curl -sS localhost:8080/u/<login>/json    # published is null again
```
Expected: score recomputed server-side; profile shows/hides the block on publish/unpublish.

- [ ] **Step 3: Desktop — full test sweep + build**

From `karlTerminal`:
```bash
cargo test -p karl-score profile_card
cargo test -p karl-score publish_profile_flag
cargo build -p covenant
cd ui && npm run build
```
Expected: all green, clean build.

- [ ] **Step 4: Desktop — live publish (manual)**

Run the app (signed in, pointing `COVENANT_BACKEND_URL` at the local server), toggle "Publish my Covenant Score & achievements" on, confirm the share link appears, open `/u/<login>` and see the score + badges. Toggle off → profile block disappears.

- [ ] **Step 5: Commit any verification fixups**

```bash
git add -A && git commit -m "test: shareable profile e2e fixups"   # if needed
```

---

## Notes / risks

- **Two repos, one contract.** The snapshot JSON shape is the interface; the score formula constants must stay identical in `profile_card.rs` and `src/score.rs` (both carry a comment pointing at the other).
- **v1 trust limitation (documented, intentional):** the server recomputes the *score number* but trusts the client's reported `dimensions`/`awards`. Full anti-cheat (sync raw `achievement_facts`, recompute reputation server-side) is Phase 2.
- **OG image** (rendered PNG) is deferred — v1 ships OG *meta tags* only.
- **Privacy:** the snapshot builder (Task 1) drops `AchievementAward.repo/branch`; the `snapshot_never_leaks_repo_or_branch` test guards this. The backend persists only whitelisted fields (Task 7).
- **Backend deploy:** merging to `covenant-server` main triggers its own deploy (Pulzen/forge). Confirm the migration applies cleanly against the live `covenant-pg` before relying on production.
