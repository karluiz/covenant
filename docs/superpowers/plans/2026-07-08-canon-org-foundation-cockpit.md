# Canon: Org Foundation + Cockpit — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Canon a serious org model — every user always has a personal org, teams are created explicitly, the active org is chosen and remembered per group — and a full-screen cockpit that hosts the heavy flows while the rail stays a compact summary.

**Architecture:** The `covenant-server` org endpoints already exist and are mounted; the client only ever called `GET /orgs` and used `orgs[0]`. Phase 1 adds one server change (lazy auto personal org in `list_mine`), wires the remaining org endpoints on the client, persists the active org per group, and replaces the rail's hardcoded `orgs[0]` with a selector + create-org modal. Phase 2 builds `CanonCockpitView` (immersive overlay, same pattern as `ContextMinerView`) launched from a rail expand button.

**Tech Stack:** Rust (axum 0.7 + sqlx 0.8/Postgres) server; Rust (Tauri commands + reqwest) desktop backend; TypeScript + xterm.js frontend, Vitest tests.

## Global Constraints

- TypeScript `strict: true`; no `as any` without a justifying comment.
- All Tauri commands wrapped in `ui/src/api.ts` with typed returns; no component calls `invoke` for Canon directly.
- Rust: `thiserror` in libs, `anyhow`/`String` at the app boundary; no `unwrap()` outside tests/`main()`.
- Registry wire path stays `/cdlc/packages` (deployed backend serves it) — do NOT rename to `/canon/`.
- UI chrome is English; no native `element.title` (use `attachTooltip`); group names render uppercase via CSS.
- Run Vitest from repo ROOT: `npx vitest run <path>`. Rust server tests: `cargo test` in `covenant-server`.
- Server tests hit Postgres via `sqlx::test` — they need `DATABASE_URL` / a test DB; skip if unavailable and note it.

---

# PHASE 1 — Org Foundation

## File Structure (Phase 1)

- `covenant-server/src/orgs.rs` — add `personal` field to `OrgRow`, `personal_slug()` helper, ensure-personal logic in `list_mine`.
- `crates/app/src/canon_registry.rs` — add `Member` struct + `create_org`, `list_members`, `add_member`, `remove_member`; add `personal` to `Org`.
- `crates/app/src/canon_registry.rs` command wrappers live in `crates/app/src/lib.rs` — add `canon_create_org`, `canon_org_members`, `canon_add_member`, `canon_remove_member` + register in `generate_handler!`.
- `ui/src/api.ts` — typed wrappers + `Member` type + `personal` on `Org`.
- `ui/src/tabs/manager.ts` — `canonOrg` on `TabGroup`/`SerializedGroup` + `setGroupCanonOrg`/getter (mirror `rootDir`/`root_dir`).
- `ui/src/canon/panel.ts` — `activeOrg()` resolver, org selector chip, create-org modal; kill `orgs[0]`.
- Tests: `covenant-server/src/orgs.rs` (`#[sqlx::test]`), `ui/src/canon/panel.test.ts`, `ui/src/tabs/manager.test.ts` (or `ui/src/workspaces/manager.test.ts`).

---

### Task 1: Server — lazy auto personal org

**Files:**
- Modify: `covenant-server/src/orgs.rs` (`OrgRow` ~14-20, `list_mine` ~91-106, add helper near `valid_slug` ~178)
- Test: `covenant-server/src/orgs.rs` (`#[cfg(test)]` module ~185)

**Interfaces:**
- Produces: `OrgRow { id: i64, slug: String, name: String, role: String, personal: bool }`; `pub fn personal_slug(login: &str) -> String`; `list_mine` guarantees ≥1 org (a personal one) for any authenticated caller.

- [ ] **Step 1: Write the failing test**

Add to the `tests` module in `covenant-server/src/orgs.rs`:

```rust
    #[test]
    fn personal_slug_lowercases_login() {
        assert_eq!(super::personal_slug("Karluiz"), "karluiz");
        assert_eq!(super::personal_slug("banco-chile"), "banco-chile");
        // A GitHub login is already slug-shaped; lowercasing keeps it valid.
        assert!(super::valid_slug(&super::personal_slug("Karluiz")));
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd covenant-server && cargo test personal_slug_lowercases_login`
Expected: FAIL — `cannot find function personal_slug`.

- [ ] **Step 3: Add the `personal_slug` helper**

In `covenant-server/src/orgs.rs`, next to `valid_slug`:

```rust
/// The reserved slug for a user's personal org. A GitHub login is already
/// `[A-Za-z0-9-]`, starts alphanumeric, and is ≤39 chars, so lowercasing
/// yields a valid slug (see `valid_slug`).
pub fn personal_slug(login: &str) -> String {
    login.trim().to_lowercase()
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd covenant-server && cargo test personal_slug_lowercases_login`
Expected: PASS.

- [ ] **Step 5: Add `personal` to `OrgRow` and compute it in `list_mine`**

Change the struct (`OrgRow`):

```rust
#[derive(Serialize, sqlx::FromRow)]
pub struct OrgRow {
    pub id: i64,
    pub slug: String,
    pub name: String,
    pub role: String,
    #[sqlx(default)]
    pub personal: bool,
}
```

Replace the body of `list_mine` with an ensure-then-list. `claims.login` is available on the JWT — no `users` lookup needed:

```rust
pub async fn list_mine(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<OrgRow>>> {
    let claims = jwt::verify(&state.jwt_secret, bearer(&headers)?)?;
    ensure_personal_org(&state.pool, claims.sub, &claims.login).await?;
    let personal = personal_slug(&claims.login);
    let mut rows = sqlx::query_as::<_, OrgRow>(
        "SELECT o.id, o.slug, o.name, m.role, false AS personal FROM orgs o
           JOIN org_members m ON m.org_id = o.id
          WHERE m.github_id = $1 ORDER BY o.name",
    )
    .bind(claims.sub)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| AppError::Internal(e.into()))?;
    for r in &mut rows {
        r.personal = r.slug == personal;
    }
    Ok(Json(rows))
}
```

- [ ] **Step 6: Add the `ensure_personal_org` helper**

In `covenant-server/src/orgs.rs`:

```rust
/// Guarantee the caller owns a personal org so no user is ever orgless.
/// Idempotent: the slug is derived from the login, so a second call is a no-op.
/// On a slug collision with another user's org, suffix the github_id to stay unique.
async fn ensure_personal_org(pool: &PgPool, github_id: i64, login: &str) -> Result<()> {
    let already: Option<(i64,)> = sqlx::query_as(
        "SELECT o.id FROM orgs o JOIN org_members m ON m.org_id = o.id
          WHERE m.github_id = $1 LIMIT 1",
    )
    .bind(github_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| AppError::Internal(e.into()))?;
    if already.is_some() {
        return Ok(());
    }
    let base = personal_slug(login);
    let mut slug = base.clone();
    let mut tx = pool.begin().await.map_err(|e| AppError::Internal(e.into()))?;
    let org_id = loop {
        let row: Option<(i64,)> = sqlx::query_as(
            "INSERT INTO orgs(slug, name, owner_github_id) VALUES ($1,$2,$3)
             ON CONFLICT (slug) DO NOTHING RETURNING id",
        )
        .bind(&slug)
        .bind(login.trim())
        .bind(github_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|e| AppError::Internal(e.into()))?;
        if let Some((id,)) = row {
            break id;
        }
        slug = format!("{base}-{github_id}");
    };
    sqlx::query("INSERT INTO org_members(org_id, github_id, role) VALUES ($1,$2,'owner')")
        .bind(org_id)
        .bind(github_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| AppError::Internal(e.into()))?;
    tx.commit().await.map_err(|e| AppError::Internal(e.into()))?;
    Ok(())
}
```

- [ ] **Step 7: Write the DB integration test**

Add to the `tests` module (guarded — needs a Postgres test DB via `sqlx::test`):

```rust
    #[sqlx::test(migrations = "./migrations")]
    async fn list_mine_autocreates_personal_org(pool: sqlx::PgPool) {
        sqlx::query("INSERT INTO users(github_id, login) VALUES (7, 'karluiz')")
            .execute(&pool).await.unwrap();
        // First call: no orgs → one personal org created.
        super::ensure_personal_org(&pool, 7, "karluiz").await.unwrap();
        let n: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM org_members WHERE github_id = 7 AND role='owner'")
            .fetch_one(&pool).await.unwrap();
        assert_eq!(n, 1);
        // Second call: idempotent, still one.
        super::ensure_personal_org(&pool, 7, "karluiz").await.unwrap();
        let n2: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM org_members WHERE github_id = 7")
            .fetch_one(&pool).await.unwrap();
        assert_eq!(n2, 1);
        let slug: String = sqlx::query_scalar(
            "SELECT o.slug FROM orgs o JOIN org_members m ON m.org_id=o.id WHERE m.github_id=7")
            .fetch_one(&pool).await.unwrap();
        assert_eq!(slug, "karluiz");
    }
```

- [ ] **Step 8: Run the tests**

Run: `cd covenant-server && cargo test orgs::`
Expected: `personal_slug_lowercases_login` PASS; `slug_rules` PASS; `list_mine_autocreates_personal_org` PASS if a test DB is configured, else it is skipped/errors on connection — if no DB, note it and rely on the unit tests.

- [ ] **Step 9: Commit**

```bash
cd covenant-server
git add src/orgs.rs
git commit -m "feat(orgs): lazy auto personal org in list_mine + personal flag"
```

---

### Task 2: Client backend — wire org endpoints

**Files:**
- Modify: `crates/app/src/canon_registry.rs` (add `Member`, `personal` on `Org`, 4 fns)
- Modify: `crates/app/src/lib.rs` (4 command wrappers + register in `generate_handler!` ~4617)
- Test: none at this layer (thin HTTP wrappers); covered by client tests in later tasks.

**Interfaces:**
- Consumes: server routes `POST /orgs`, `GET/POST /orgs/:slug/members`, `DELETE /orgs/:slug/members/:login`.
- Produces (Rust): `Org { id, slug, name, role, personal }`, `Member { login, role }`; commands `canon_create_org(slug, name) -> Value`, `canon_org_members(slug) -> Vec<Member>`, `canon_add_member(slug, login) -> ()`, `canon_remove_member(slug, login) -> ()`.

- [ ] **Step 1: Add `personal` to `Org` and a `Member` struct**

In `crates/app/src/canon_registry.rs`, find the `Org` struct and add the field; add `Member`:

```rust
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Org {
    pub id: i64,
    pub slug: String,
    pub name: String,
    pub role: String,
    #[serde(default)]
    pub personal: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Member {
    pub login: String,
    pub role: String,
}
```

- [ ] **Step 2: Add the four registry client fns**

Append to `crates/app/src/canon_registry.rs` (mirror the existing `list_orgs`/`publish` reqwest style; note `/orgs*` is NOT under `/cdlc`):

```rust
pub async fn create_org(slug: &str, name: &str) -> Result<Value, String> {
    let j = jwt()?;
    let url = format!("{}/orgs", auth::backend_url());
    client()
        .post(&url)
        .bearer_auth(&j)
        .json(&serde_json::json!({ "slug": slug, "name": name }))
        .send().await.map_err(|e| e.to_string())?
        .error_for_status().map_err(|e| e.to_string())?
        .json().await.map_err(|e| e.to_string())
}

pub async fn list_members(org: &str) -> Result<Vec<Member>, String> {
    let j = jwt()?;
    let url = format!("{}/orgs/{}/members", auth::backend_url(), urlencoding(org));
    client()
        .get(&url).bearer_auth(&j)
        .send().await.map_err(|e| e.to_string())?
        .error_for_status().map_err(|e| e.to_string())?
        .json().await.map_err(|e| e.to_string())
}

pub async fn add_member(org: &str, login: &str) -> Result<(), String> {
    let j = jwt()?;
    let url = format!("{}/orgs/{}/members", auth::backend_url(), urlencoding(org));
    client()
        .post(&url).bearer_auth(&j)
        .json(&serde_json::json!({ "login": login }))
        .send().await.map_err(|e| e.to_string())?
        .error_for_status().map_err(|e| e.to_string())?;
    Ok(())
}

pub async fn remove_member(org: &str, login: &str) -> Result<(), String> {
    let j = jwt()?;
    let url = format!("{}/orgs/{}/members/{}", auth::backend_url(),
        urlencoding(org), urlencoding(login));
    client()
        .delete(&url).bearer_auth(&j)
        .send().await.map_err(|e| e.to_string())?
        .error_for_status().map_err(|e| e.to_string())?;
    Ok(())
}
```

(If `Value` isn't already imported here, add `use serde_json::Value;` — the file already uses `serde_json::json!` in `publish`, confirm the import.)

- [ ] **Step 3: Add the Tauri command wrappers in `lib.rs`**

Near the other `canon_*` commands in `crates/app/src/lib.rs`:

```rust
#[tauri::command]
async fn canon_create_org(slug: String, name: String) -> Result<serde_json::Value, String> {
    canon_registry::create_org(&slug, &name).await
}

#[tauri::command]
async fn canon_org_members(org: String) -> Result<Vec<canon_registry::Member>, String> {
    canon_registry::list_members(&org).await
}

#[tauri::command]
async fn canon_add_member(org: String, login: String) -> Result<(), String> {
    canon_registry::add_member(&org, &login).await
}

#[tauri::command]
async fn canon_remove_member(org: String, login: String) -> Result<(), String> {
    canon_registry::remove_member(&org, &login).await
}
```

- [ ] **Step 4: Register the commands in `generate_handler!`**

In the `tauri::generate_handler![ ... ]` list (around `canon_my_orgs`, `canon_search`), add:

```rust
            canon_create_org,
            canon_org_members,
            canon_add_member,
            canon_remove_member,
```

- [ ] **Step 5: Verify it compiles**

Run: `cargo check -p covenant`
Expected: Finished with no errors (pre-existing warnings OK).

- [ ] **Step 6: Commit**

```bash
git add crates/app/src/canon_registry.rs crates/app/src/lib.rs
git commit -m "feat(canon): wire org create/members Tauri commands"
```

---

### Task 3: Client — typed api + per-group active-org persistence

**Files:**
- Modify: `ui/src/api.ts` (`Org` + `personal`, `Member`, 4 wrappers)
- Modify: `ui/src/tabs/manager.ts` (`TabGroup.canonOrg`, `SerializedGroup.canon_org`, serialize/restore, `setGroupCanonOrg`, `groupCanonOrg`)
- Test: `ui/src/tabs/manager.test.ts`

**Interfaces:**
- Produces (TS): `interface Member { login: string; role: string }`; `Org` gains `personal: boolean`; `canonCreateOrg(slug,name)`, `canonOrgMembers(org)`, `canonAddMember(org,login)`, `canonRemoveMember(org,login)`; `TabManager.setGroupCanonOrg(groupId, slug|null)` and `TabManager.groupCanonOrg(groupId): string | null`.

- [ ] **Step 1: Add types + wrappers in `api.ts`**

Update `Org` and add `Member` + wrappers (near `canonMyOrgs`):

```ts
export interface Org {
  id: number;
  slug: string;
  name: string;
  role: string;
  personal: boolean;
}
export interface Member {
  login: string;
  role: string;
}
export async function canonCreateOrg(slug: string, name: string): Promise<unknown> {
  return invoke("canon_create_org", { slug, name });
}
export async function canonOrgMembers(org: string): Promise<Member[]> {
  return invoke<Member[]>("canon_org_members", { org });
}
export async function canonAddMember(org: string, login: string): Promise<void> {
  return invoke("canon_add_member", { org, login });
}
export async function canonRemoveMember(org: string, login: string): Promise<void> {
  return invoke("canon_remove_member", { org, login });
}
```

- [ ] **Step 2: Write the failing persistence test**

In `ui/src/tabs/manager.test.ts`, add (adapt the harness the file already uses to construct a `TabManager` with a group):

```ts
it("persists and restores a group's active canon org", () => {
  const m = makeManagerWithGroup("g1"); // existing helper / inline setup in this file
  expect(m.groupCanonOrg("g1")).toBeNull();
  m.setGroupCanonOrg("g1", "cleverit");
  expect(m.groupCanonOrg("g1")).toBe("cleverit");
  const restored = restoreFromManifest(m.serialize()); // mirror existing round-trip test
  expect(restored.groupCanonOrg("g1")).toBe("cleverit");
});
```

If the file has no such helpers, follow the exact construction/round-trip pattern already used by the `root_dir` group tests in this file.

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run ui/src/tabs/manager.test.ts -t "active canon org"`
Expected: FAIL — `groupCanonOrg is not a function`.

- [ ] **Step 4: Add the field + accessors (mirror `rootDir`/`root_dir`)**

`TabGroup`:

```ts
interface TabGroup {
  id: string;
  name: string;
  color: string | null;
  collapsed: boolean;
  rootDir: string | null;
  /// Active Canon org slug for this group. Null = resolve to the user's
  /// personal org. Persisted like rootDir.
  canonOrg: string | null;
}
```

`SerializedGroup`:

```ts
interface SerializedGroup {
  id: string;
  name: string;
  color: string | null;
  collapsed: boolean;
  root_dir?: string | null;
  canon_org?: string | null;
}
```

In the serialize map (where `root_dir: g.rootDir` is produced) add `canon_org: g.canonOrg`. In the restore path (where `rootDir: s.root_dir ?? null` is set) add `canonOrg: s.canon_org ?? null`. In every place a `TabGroup` literal is constructed (group creation), add `canonOrg: null`.

Add the accessors near `setGroupRootDir` (or wherever group mutators live):

```ts
groupCanonOrg(groupId: string): string | null {
  return this.groups.get(groupId)?.canonOrg ?? null;
}
setGroupCanonOrg(groupId: string, slug: string | null): void {
  const g = this.groups.get(groupId);
  if (!g) return;
  g.canonOrg = slug;
  this.persist(); // use whatever this file calls to save the manifest
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run ui/src/tabs/manager.test.ts -t "active canon org"`
Expected: PASS.

- [ ] **Step 6: Type-check + commit**

```bash
npm run build   # tsc must pass
git add ui/src/api.ts ui/src/tabs/manager.ts ui/src/tabs/manager.test.ts
git commit -m "feat(canon): typed org api + per-group active-org persistence"
```

---

### Task 4: Rail — org selector chip + create-org modal, kill orgs[0]

**Files:**
- Modify: `ui/src/canon/panel.ts` (add `activeOrg()`, selector chip, create-org modal; replace 3 `orgs[0]` reads)
- Modify: `ui/src/canon/styles.css` (chip + modal styles — sharp corners, `--canon-accent`)
- Modify: `ui/src/main.ts:1491` (`new CanonPanel({...})` — pass group get/set org callbacks)
- Test: `ui/src/canon/panel.test.ts`

**Interfaces:**
- Consumes: `canonMyOrgs()`, `canonCreateOrg()`, `TabManager.groupCanonOrg/setGroupCanonOrg` (via callbacks passed in `CanonPanelOpts`).
- Produces: `CanonPanelOpts` gains `getActiveOrg?: () => string | null` and `setActiveOrg?: (slug: string | null) => void`; a private `activeOrg(): Org | null` on `CanonPanel`.

- [ ] **Step 1: Extend `CanonPanelOpts` and add the resolver (failing test first)**

Add to `ui/src/canon/panel.test.ts` (reuse the file's existing `new CanonPanel({...})` construction + mocked api):

```ts
it("resolves active org from the group callback, else the personal org", () => {
  const orgs = [
    { id: 1, slug: "cleverit", name: "Cleverit", role: "member", personal: false },
    { id: 2, slug: "karluiz", name: "karluiz", role: "owner", personal: true },
  ];
  const p = new CanonPanel({ groupId: "g1", groupLabel: "G1", groupRootDir: "/x",
    getActiveOrg: () => null, setActiveOrg: () => {} });
  p.setOrgs(orgs);
  expect(p.activeOrg()?.slug).toBe("karluiz"); // personal wins when group unset
  const p2 = new CanonPanel({ groupId: "g1", groupLabel: "G1", groupRootDir: "/x",
    getActiveOrg: () => "cleverit", setActiveOrg: () => {} });
  p2.setOrgs(orgs);
  expect(p2.activeOrg()?.slug).toBe("cleverit"); // group choice wins
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run ui/src/canon/panel.test.ts -t "resolves active org"`
Expected: FAIL — `activeOrg is not a function`.

- [ ] **Step 3: Add opts fields + `activeOrg()` resolver**

In `CanonPanelOpts`:

```ts
  /** Active Canon org slug for this group (from the tab manifest), or null. */
  getActiveOrg?: () => string | null;
  /** Persist the chosen org slug on the group. */
  setActiveOrg?: (slug: string | null) => void;
```

On `CanonPanel`, replace scattered `this.orgs[0]` with a single resolver:

```ts
/** The org whose registry this group works against: the group's saved
 *  choice, else the personal org, else the first org, else null. */
activeOrg(): Org | null {
  if (this.orgs.length === 0) return null;
  const saved = this.opts.getActiveOrg?.() ?? null;
  if (saved) {
    const hit = this.orgs.find((o) => o.slug === saved);
    if (hit) return hit;
  }
  return this.orgs.find((o) => o.personal) ?? this.orgs[0];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run ui/src/canon/panel.test.ts -t "resolves active org"`
Expected: PASS.

- [ ] **Step 5: Replace every `orgs[0]` usage with `activeOrg()`**

In `renderStatus`: the search placeholder, the `canonSearch(...)` call, the publish path (`publish()`), and the adoption fetch in `refresh()` all currently read `this.orgs[0].slug`. Replace each with:

```ts
const org = this.activeOrg();
if (!org) { /* skip registry UI — show sign-in / no-org note */ }
// ...use org.slug
```

In `refresh()` adoption block:

```ts
const active = this.activeOrg();
if (active) {
  const pkgs = await canonSearch(active.slug, null).catch(() => [] as PkgMeta[]);
  for (const p of pkgs) this.adoption.set(p.name, p.installs);
}
```

- [ ] **Step 6: Add the org selector chip to the panel head**

Add a private `renderOrgChip()` that builds a `<button class="canon-org-chip">` showing `activeOrg()?.name` with a caret; clicking opens a small menu listing `this.orgs` (checkmark on active) plus a `+ Create organization…` item. Selecting an org calls `this.opts.setActiveOrg?.(slug)` then `void this.refresh()`. Insert the chip into `head` (near the title). Menu is a lightweight absolutely-positioned `<div class="canon-org-menu">` appended to the panel, dismissed on outside-click/Esc.

```ts
private renderOrgChip(): HTMLElement {
  const chip = document.createElement("button");
  chip.className = "canon-org-chip";
  const active = this.activeOrg();
  chip.textContent = active ? active.name : "No org";
  attachTooltip(chip, "Active organization");
  chip.addEventListener("click", () => this.openOrgMenu(chip));
  return chip;
}
```

`openOrgMenu(anchor)` renders one row per org (calls `setActiveOrg` + `refresh` + closes) and a final "＋ Create organization…" row that calls `this.openCreateOrgModal()`.

- [ ] **Step 7: Add the create-org modal**

```ts
private openCreateOrgModal(): void {
  const overlay = document.createElement("div");
  overlay.className = "canon-modal";
  overlay.innerHTML = `
    <div class="canon-modal-card">
      <h3>Create organization</h3>
      <label>Name<input class="canon-modal-name" placeholder="Cleverit" /></label>
      <label>Slug<input class="canon-modal-slug" placeholder="cleverit" /></label>
      <p class="canon-modal-err" hidden></p>
      <div class="canon-modal-actions">
        <button class="canon-modal-cancel">Cancel</button>
        <button class="canon-modal-create">Create</button>
      </div>
    </div>`;
  const nameEl = overlay.querySelector(".canon-modal-name") as HTMLInputElement;
  const slugEl = overlay.querySelector(".canon-modal-slug") as HTMLInputElement;
  const err = overlay.querySelector(".canon-modal-err") as HTMLElement;
  let slugEdited = false;
  slugEl.addEventListener("input", () => { slugEdited = true; });
  nameEl.addEventListener("input", () => {
    if (!slugEdited) slugEl.value = slugify(nameEl.value);
  });
  const close = () => overlay.remove();
  overlay.querySelector(".canon-modal-cancel")?.addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  overlay.querySelector(".canon-modal-create")?.addEventListener("click", async () => {
    const slug = slugEl.value.trim(); const name = nameEl.value.trim();
    if (!name || !slug) { err.hidden = false; err.textContent = "Name and slug required."; return; }
    try {
      await canonCreateOrg(slug, name);
      this.opts.setActiveOrg?.(slug);
      close();
      await this.refresh();
      pushInfoToast({ message: `Created organization ${name}` });
    } catch (e) { err.hidden = false; err.textContent = String(e); }
  });
  document.body.appendChild(overlay);
  nameEl.focus();
}
```

Add a module-level `slugify` (mirrors server `valid_slug`):

```ts
/** Derive a valid org slug from a display name: lowercase, [a-z0-9-] only,
 *  collapse runs of dashes, trim leading/trailing dashes, cap at 40. */
function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "").slice(0, 40);
}
```

- [ ] **Step 8: Write a test for slugify + create-org flow**

```ts
it("slugifies a display name to a valid slug", () => {
  expect(slugify("Cleverit SpA")).toBe("cleverit-spa");
  expect(slugify("  Banco de Chile ")).toBe("banco-de-chile");
  expect(slugify("--weird__name--")).toBe("weird-name");
});
```

(Export `slugify` from `panel.ts` for the test, or test it via a re-export in a small `panel.slug.ts` if you prefer to keep `panel.ts`'s surface minimal — exporting the function is fine.)

- [ ] **Step 9: Run panel tests**

Run: `npx vitest run ui/src/canon/panel.test.ts`
Expected: all PASS (existing + new).

- [ ] **Step 10: Wire the callbacks in `main.ts`**

At `ui/src/main.ts:1491` (`new CanonPanel({...})`), pass:

```ts
      getActiveOrg: () => tabManager.groupCanonOrg(args.groupId),
      setActiveOrg: (slug) => tabManager.setGroupCanonOrg(args.groupId, slug),
```

(Use the actual tab-manager variable in scope and the group id already passed as `groupId`.)

- [ ] **Step 11: Style the chip + modal**

In `ui/src/canon/styles.css` add `.canon-org-chip`, `.canon-org-menu`, `.canon-modal`, `.canon-modal-card` — border-radius 0 (sharp corners), accent via `--canon-accent`, `appearance:none` reset on inputs/buttons. Follow the rail panel conventions already in the file.

- [ ] **Step 12: Full build + commit**

```bash
npm run build && npx vitest run ui/src/canon
git add ui/src/canon/panel.ts ui/src/canon/panel.test.ts ui/src/canon/styles.css ui/src/main.ts
git commit -m "feat(canon): rail org selector + create-org modal, remove orgs[0]"
```

- [ ] **Step 13: Manual verify (respawn)**

Rust changed in earlier tasks → `/respawn`. In-app: open Canon on a group → org chip shows personal org; create an org → becomes active and persists across a group switch; search targets the active org (no more 404 to a stale org).

---

# PHASE 2 — Cockpit (full-screen)

Phase 2 is shippable only after Phase 1. It reuses `activeOrg()`, the org api wrappers, and the members endpoints.

## File Structure (Phase 2)

- `ui/src/canon/cockpit/view.ts` — `CanonCockpitView` (overlay, nav, section router).
- `ui/src/canon/cockpit/cockpit.css` — cockpit layout (nav + content), theme-aware, sharp corners.
- `ui/src/canon/panel.ts` — add an **expand** button to the head that launches the cockpit.
- `ui/src/main.ts` — construct `CanonCockpitView` with the same group + org callbacks.
- Test: `ui/src/canon/cockpit/view.test.ts`.

---

### Task 5: Cockpit shell — overlay, nav, launch from rail

**Files:**
- Create: `ui/src/canon/cockpit/view.ts`, `ui/src/canon/cockpit/cockpit.css`
- Modify: `ui/src/canon/panel.ts` (expand button in head), `ui/src/main.ts`
- Test: `ui/src/canon/cockpit/view.test.ts`

**Interfaces:**
- Produces: `class CanonCockpitView { constructor(opts: CanonCockpitOpts); open(): void; close(): void; get element(): HTMLElement; showSection(key: SectionKey): void }` where `SectionKey = "org" | "members" | "skills" | "registry" | "context" | "loop"`; `CanonCockpitOpts = { groupId, groupLabel, groupRootDir, orgs: Org[], getActiveOrg, setActiveOrg }`.

- [ ] **Step 1: Write the failing shell test**

Create `ui/src/canon/cockpit/view.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { CanonCockpitView } from "./view";

const opts = {
  groupId: "g1", groupLabel: "G1", groupRootDir: "/x",
  orgs: [{ id: 1, slug: "karluiz", name: "karluiz", role: "owner", personal: true }],
  getActiveOrg: () => "karluiz", setActiveOrg: vi.fn(),
};

describe("CanonCockpitView shell", () => {
  it("opens with the org section active and switches sections", () => {
    const v = new CanonCockpitView(opts);
    v.open();
    expect(v.element.querySelector(".canon-cockpit-nav")).toBeTruthy();
    expect(v.element.querySelector('[data-section="org"].is-active')).toBeTruthy();
    v.showSection("members");
    expect(v.element.querySelector('[data-section="members"].is-active')).toBeTruthy();
    v.close();
    expect(document.querySelector(".canon-cockpit")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run ui/src/canon/cockpit/view.test.ts`
Expected: FAIL — cannot resolve `./view`.

- [ ] **Step 3: Implement the shell**

Create `ui/src/canon/cockpit/view.ts` with the overlay + left nav + content host, mirroring `ContextMinerView`'s mount/close/Esc handling:

```ts
import "./cockpit.css";
import type { Org } from "../../api";

export type SectionKey = "org" | "members" | "skills" | "registry" | "context" | "loop";
export interface CanonCockpitOpts {
  groupId: string;
  groupLabel: string;
  groupRootDir: string | null;
  orgs: Org[];
  getActiveOrg: () => string | null;
  setActiveOrg: (slug: string | null) => void;
}
const SECTIONS: { key: SectionKey; label: string }[] = [
  { key: "org", label: "Org" }, { key: "members", label: "Members" },
  { key: "skills", label: "Skills" }, { key: "registry", label: "Registry" },
  { key: "context", label: "Context" }, { key: "loop", label: "Loop" },
];

export class CanonCockpitView {
  private root: HTMLElement;
  private nav: HTMLElement;
  private content: HTMLElement;
  private current: SectionKey = "org";
  get element(): HTMLElement { return this.root; }

  constructor(private opts: CanonCockpitOpts) {
    this.root = document.createElement("div");
    this.root.className = "canon-cockpit";
    this.nav = document.createElement("nav");
    this.nav.className = "canon-cockpit-nav";
    for (const s of SECTIONS) {
      const b = document.createElement("button");
      b.dataset.section = s.key;
      b.textContent = s.label;
      b.addEventListener("click", () => this.showSection(s.key));
      this.nav.appendChild(b);
    }
    this.content = document.createElement("section");
    this.content.className = "canon-cockpit-content";
    const close = document.createElement("button");
    close.className = "canon-cockpit-close";
    close.setAttribute("aria-label", "Close (Esc)");
    close.innerHTML = `<kbd class="settings-esc">esc</kbd>`;
    close.addEventListener("click", () => this.close());
    this.root.append(this.nav, this.content, close);
  }

  private onKey = (e: KeyboardEvent): void => { if (e.key === "Escape") this.close(); };

  open(): void {
    document.body.appendChild(this.root);
    document.addEventListener("keydown", this.onKey);
    this.showSection(this.current);
  }
  close(): void {
    this.root.remove();
    document.removeEventListener("keydown", this.onKey);
  }
  showSection(key: SectionKey): void {
    this.current = key;
    for (const b of this.nav.querySelectorAll("button")) {
      b.classList.toggle("is-active", (b as HTMLElement).dataset.section === key);
    }
    this.content.replaceChildren(this.renderSection(key));
  }
  private renderSection(key: SectionKey): HTMLElement {
    const el = document.createElement("div");
    el.className = `canon-cockpit-section is-${key}`;
    el.textContent = key; // replaced per-section in Tasks 6-8
    return el;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run ui/src/canon/cockpit/view.test.ts`
Expected: PASS.

- [ ] **Step 5: Add cockpit CSS**

Create `ui/src/canon/cockpit/cockpit.css`: full-screen fixed overlay (opaque bg, `z-index` above rail), CSS grid `nav | content`, theme-aware (`prefers-color-scheme` + `:root[data-theme]`), sharp corners, `.canon-cockpit-nav button.is-active` accent. Follow `miner.css` header conventions.

- [ ] **Step 6: Launch from the rail**

In `ui/src/canon/panel.ts` head, add an expand `iconButton(Icons.maximize(...), "Open Canon full screen", ...)` that constructs and `open()`s a `CanonCockpitView` with the panel's group + org info. Pass the cockpit opts from `main.ts` the same way as the panel (a `onExpand?: () => void` callback on `CanonPanelOpts`, wired in `main.ts` to build the cockpit). Keep construction in `main.ts` so the panel doesn't import manager internals.

- [ ] **Step 7: Build + commit**

```bash
npm run build && npx vitest run ui/src/canon/cockpit
git add ui/src/canon/cockpit ui/src/canon/panel.ts ui/src/main.ts
git commit -m "feat(canon): full-screen cockpit shell + rail launch"
```

---

### Task 6: Cockpit — Org + Members sections

**Files:**
- Modify: `ui/src/canon/cockpit/view.ts` (Org + Members section renderers)
- Test: `ui/src/canon/cockpit/view.test.ts`

**Interfaces:**
- Consumes: `canonOrgMembers`, `canonAddMember`, `canonRemoveMember`, `canonCreateOrg`, `opts.orgs`, `opts.getActiveOrg/setActiveOrg`.
- Produces: Members add/remove UI gated on the active org's `role === "owner"`.

- [ ] **Step 1: Write the failing owner-gating test**

```ts
it("gates member add/remove on owner role", async () => {
  const memberOpts = { ...opts,
    orgs: [{ id: 1, slug: "cleverit", name: "Cleverit", role: "member", personal: false }],
    getActiveOrg: () => "cleverit" };
  const v = new CanonCockpitView(memberOpts);
  v.open(); v.showSection("members");
  expect(v.element.querySelector(".canon-cockpit-add-member")).toBeNull(); // member: no add UI
  const ownerV = new CanonCockpitView(opts); // opts active org is owner
  ownerV.open(); ownerV.showSection("members");
  expect(ownerV.element.querySelector(".canon-cockpit-add-member")).toBeTruthy();
});
```

(Mock `../../api`'s `canonOrgMembers` to resolve `[]` in this test file via `vi.mock`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run ui/src/canon/cockpit/view.test.ts -t "gates member"`
Expected: FAIL (no add-member element / member section not implemented).

- [ ] **Step 3: Implement Org + Members renderers**

Replace the `org` and `members` branches of `renderSection`. Org: show active org name/slug/role, an org switcher (reuse the slug list), and a Create-org button (reuse `canonCreateOrg` + `slugify` — import the shared `slugify` from `panel.ts`). Members: fetch `canonOrgMembers(active.slug)`, render `{login, role}` rows; if the active org's `role === "owner"`, render a `.canon-cockpit-add-member` row (GitHub-login input + Add → `canonAddMember`) and a remove button per non-owner row (→ `canonRemoveMember`), each followed by a re-fetch. Surface errors inline (Forbidden/NotFound → readable line).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run ui/src/canon/cockpit/view.test.ts -t "gates member"`
Expected: PASS.

- [ ] **Step 5: Build + commit**

```bash
npm run build && npx vitest run ui/src/canon/cockpit
git add ui/src/canon/cockpit/view.ts ui/src/canon/cockpit/view.test.ts
git commit -m "feat(canon): cockpit Org + Members sections (owner-gated)"
```

---

### Task 7: Cockpit — Skills + Registry sections

**Files:**
- Modify: `ui/src/canon/cockpit/view.ts` (Skills + Registry renderers)
- Test: `ui/src/canon/cockpit/view.test.ts`

**Interfaces:**
- Consumes: `canonLocalStatus`, `canonReadLocal`, `canonPublish`, `canonSearch`, `canonPreview`, `canonInstallRegistry`, `openMarkdownReader` (export it from `panel.ts`).

- [ ] **Step 1: Write the failing registry-search test**

```ts
it("renders registry search results for the active org", async () => {
  // vi.mock ../../api: canonSearch → [{id:1,name:"kyc",version:"1.0.0",
  //   description:"", publisher_login:"karluiz", installs:3, sha:"abc1234"}]
  const v = new CanonCockpitView(opts);
  v.open(); v.showSection("registry");
  const input = v.element.querySelector(".canon-cockpit-search-input") as HTMLInputElement;
  const go = v.element.querySelector(".canon-cockpit-search-go") as HTMLButtonElement;
  input.value = "kyc"; go.click();
  await Promise.resolve(); await Promise.resolve();
  expect(v.element.textContent).toContain("kyc");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run ui/src/canon/cockpit/view.test.ts -t "registry search"`
Expected: FAIL.

- [ ] **Step 3: Implement Skills + Registry**

Skills: `canonLocalStatus(groupRootDir)` → installed cards (name, version, source) with Preview (reuse `openMarkdownReader`) and Publish (`canonPublish`, gated on non-`registry:` source + membership). Registry: search input + button (`.canon-cockpit-search-input` / `.canon-cockpit-search-go`) → `canonSearch(active.slug, q)` → result cards with Install (`canonInstallRegistry`) and full-screen preview (`canonPreview`). Reuse the rail's card structure; factor the shared card builder into a small exported helper in `panel.ts` if it reduces duplication, otherwise inline.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run ui/src/canon/cockpit/view.test.ts -t "registry search"`
Expected: PASS.

- [ ] **Step 5: Build + commit**

```bash
npm run build && npx vitest run ui/src/canon/cockpit
git add ui/src/canon/cockpit/view.ts ui/src/canon/cockpit/view.test.ts ui/src/canon/panel.ts
git commit -m "feat(canon): cockpit Skills + Registry sections"
```

---

### Task 8: Cockpit — Context + Loop sections; slim the rail

**Files:**
- Modify: `ui/src/canon/cockpit/view.ts` (Context + Loop renderers)
- Modify: `ui/src/canon/panel.ts` (rail = compact summary)
- Test: `ui/src/canon/cockpit/view.test.ts`, `ui/src/canon/panel.test.ts`

**Interfaces:**
- Consumes: `canonLocalStatus` (contextFiles), the miner launch (`opts.onNewContext`-equivalent — pass an `onNewContext` callback into cockpit opts), `scoreSummaryFiltered`, `canonEvalSummary`, `statCell`/`meterRow` (export from `panel.ts`).

- [ ] **Step 1: Write the failing Loop test**

```ts
it("renders inference stats in the Loop section", async () => {
  // vi.mock ../../api: scoreSummaryFiltered → { total_tokens: 1500,
  //   total_prompts: 10, total_specs: 2, total_commits: 4 }
  const v = new CanonCockpitView(opts);
  v.open(); v.showSection("loop");
  await Promise.resolve(); await Promise.resolve();
  expect(v.element.textContent).toContain("1.5k"); // fmtTokens
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run ui/src/canon/cockpit/view.test.ts -t "Loop section"`
Expected: FAIL.

- [ ] **Step 3: Implement Context + Loop**

Context: list `contextFiles`, a **New context** button that invokes `opts.onNewContext` (wired in `main.ts` to the existing miner launch). Loop: adoption meters + inference `statCell`s + eval `meterRow`s, reusing the exported building blocks from `panel.ts` (export `statCell`, `meterRow`, `fmtTokens`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run ui/src/canon/cockpit/view.test.ts -t "Loop section"`
Expected: PASS.

- [ ] **Step 5: Slim the rail to a summary**

In `ui/src/canon/panel.ts` `renderStatus`, keep: org chip, installed-skill **count** (+ compact list), **Project** button, **expand** button. Move the registry search UI, adoption/inference/eval detail, and members entirely to the cockpit (delete those blocks from the rail, or guard them behind "open cockpit for more"). Update `panel.test.ts` expectations that referenced the removed rail blocks.

- [ ] **Step 6: Run all canon tests**

Run: `npx vitest run ui/src/canon`
Expected: all PASS.

- [ ] **Step 7: Build + commit**

```bash
npm run build && npx vitest run ui/src/canon
git add ui/src/canon
git commit -m "feat(canon): cockpit Context + Loop; slim rail to summary"
```

- [ ] **Step 8: Manual verify (respawn)**

`/respawn`. In-app: rail shows compact summary + expand; expand opens the cockpit; nav switches sections; Members add/remove gated on owner; Registry search/install works against the active org; New context launches the miner; Loop shows dashboards.

---

## Self-Review (completed)

- **Spec coverage:** auto personal org (Task 1) ✓; wire create/members endpoints (Tasks 2-3) ✓; per-group active org (Task 3) ✓; rail selector + create-org, kill `orgs[0]` (Task 4) ✓; cockpit shell + Org/Members/Skills/Registry/Context/Loop (Tasks 5-8) ✓; rail-as-summary (Task 8) ✓; sign-in/Forbidden/network error handling (Tasks 4,6) ✓; server + client tests present ✓.
- **Placeholder scan:** no TBD/TODO; every code step shows code.
- **Type consistency:** `Org` (+`personal`) and `Member` defined identically in `canon_registry.rs` and `api.ts`; `activeOrg()`, `groupCanonOrg`/`setGroupCanonOrg`, `SectionKey`, `CanonCockpitOpts` referenced consistently across tasks. `slugify` (client) mirrors `valid_slug`/`personal_slug` (server).
- **Note:** Task 1's DB test needs a Postgres test DB; if unavailable, the unit tests (`personal_slug`, `slug_rules`) still gate the logic — call it out at execution time.
