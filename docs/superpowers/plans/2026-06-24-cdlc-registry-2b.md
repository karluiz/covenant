# CDLC Registry — Plan 2b (desktop client) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Desktop registry client in karlTerminal — publish a local CDLC skill to an org registry and install one back, reusing the existing covenant-server JWT + Phase-1 `install_local` projection.

**Architecture:** A new `crates/app/src/cdlc_registry.rs` makes authed `reqwest` calls to covenant-server (mirroring `cloud_sync`), exposed as Tauri commands. `crates/cdlc` gains a source-labeled install + a local-package reader. The CDLC panel (`ui/src/cdlc/panel.ts`) gets an org picker, a per-skill Publish button, and an Install flow. Server endpoints are verified live (Plan 2a). Spec: `docs/superpowers/specs/2026-06-24-cdlc-registry-design.md` §D.

**Tech Stack:** Rust (reqwest `.bearer_auth`, tokio spawn_blocking), Tauri 2, TypeScript + vanilla DOM, vitest.

## Global Constraints

- Auth + base URL come from `karl_score::auth`: `auth::load_jwt() -> Result<Option<String>>` (keychain) and `auth::backend_url() -> String` (env `COVENANT_BACKEND_URL` or `https://forge.covenant.uno`). Never hard-code the URL or re-implement auth.
- HTTP calls are Rust-side (`reqwest::Client` + `.bearer_auth(&jwt)`), mirroring `crates/app/src/cloud_sync/mod.rs`. The frontend calls Tauri commands, never `fetch` to covenant-server.
- **Server JSON is snake_case** (`publisher_login`, `skill_toml`, `skill_md`) — the Rust response structs use plain snake_case field names (NO `rename_all`), so they both deserialize from the server AND serialize to TS as snake_case. The TS interfaces for `Org`/`PkgMeta` therefore use snake_case keys (`publisher_login`). This is a deliberate, contained exception to api.ts's camelCase convention — documenting it avoids a double-struct mapping for one field.
- `InstalledRef` (from `karl_cdlc`) keeps its existing camelCase (`installedAt`).
- No `unwrap()`/`expect()` outside `#[cfg(test)]`. Tauri commands return `Result<_, String>`.
- The score crate is referenced as `karl_score`; the cdlc crate as `karl_cdlc`. Both are already deps of `crates/app`.
- Run vitest/tsc from the **repo root**, not `ui/`.
- Test convention: TDD pure logic with unit tests (Rust `#[test]`, TS vitest). The reqwest HTTP handlers are verified by `cargo build` + the later live `/verify` against the running server — do NOT add an HTTP mock server.

---

### Task 1: `crates/cdlc` — source-labeled install + local-package reader

**Files:**
- Modify: `crates/cdlc/src/install.rs`
- Modify: `crates/cdlc/src/lib.rs` (re-exports)

**Interfaces:**
- Produces:
  - `karl_cdlc::install_from_dir(repo_root: &Path, source_dir: &Path, source_label: &str) -> Result<InstalledRef>` (the new core; `install_local` delegates to it with a `local:` label).
  - `karl_cdlc::read_skill_package(repo_root: &Path, name: &str) -> Result<(String /*skill_toml*/, String /*skill_md*/, SkillManifest)>`.

- [ ] **Step 1: Write the failing test**

In `crates/cdlc/src/install.rs`, add to the existing `#[cfg(test)] mod tests`:
```rust
    #[test]
    fn install_from_dir_uses_custom_source_label() {
        let base = std::env::temp_dir().join(format!("cdlc-srclabel-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let repo = base.join("repo");
        let src = base.join("src");
        std::fs::create_dir_all(&repo).unwrap();
        write_pkg(&src, "kyc-peru"); // existing test helper
        let r = install_from_dir(&repo, &src, "registry:mibanco/kyc-peru@1.0.0").unwrap();
        assert_eq!(r.source, "registry:mibanco/kyc-peru@1.0.0");
        // read it back
        let (toml_s, md_s, sm) = read_skill_package(&repo, "kyc-peru").unwrap();
        assert!(toml_s.contains("kyc-peru"));
        assert!(md_s.contains("KYC"));
        assert_eq!(sm.name, "kyc-peru");
        let _ = std::fs::remove_dir_all(&base);
    }
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cargo test -p karl-cdlc install_from_dir_uses_custom_source_label 2>&1 | tail -8`
Expected: FAIL — `install_from_dir` / `read_skill_package` not found.

- [ ] **Step 3: Refactor `install_local` to delegate + add the reader**

In `crates/cdlc/src/install.rs`, replace the existing `install_local` body. Keep the validation/sha/copy/manifest/projection logic but move it into `install_from_dir`, parameterizing the source label:
```rust
/// Install a skill package from a local directory, recording `source_label` as provenance.
pub fn install_from_dir(
    repo_root: &Path,
    source_dir: &Path,
    source_label: &str,
) -> Result<InstalledRef, CdlcError> {
    let skill_toml = source_dir.join("skill.toml");
    let skill_md = source_dir.join("SKILL.md");
    if !skill_toml.exists() || !skill_md.exists() {
        return Err(CdlcError::InvalidPackage(
            "source must contain skill.toml and SKILL.md".into(),
        ));
    }
    let sm: SkillManifest = toml::from_str(&std::fs::read_to_string(&skill_toml)?)?;
    if !valid_pkg_name(&sm.name) {
        return Err(CdlcError::InvalidPackage(format!("invalid skill name: {:?}", sm.name)));
    }
    let payload = std::fs::read(&skill_md)?;
    let sha = format!("{:x}", Sha256::digest(&payload));
    let skills_root = cdlc_dir(repo_root).join("skills");
    let dest = skills_root.join(&sm.name);
    if !dest.starts_with(&skills_root) {
        return Err(CdlcError::InvalidPackage(format!("skill path escapes skills dir: {:?}", sm.name)));
    }
    std::fs::create_dir_all(&dest)?;
    std::fs::copy(&skill_toml, dest.join("skill.toml"))?;
    std::fs::write(dest.join("SKILL.md"), &payload)?;

    let mut manifest = read_manifest(repo_root)?;
    if manifest.version == 0 {
        manifest.version = 1;
    }
    let r = InstalledRef {
        name: sm.name.clone(),
        version: sm.version.clone(),
        source: source_label.to_string(),
        sha,
        signer: sm.owner.clone(),
        installed_at: chrono::Utc::now().to_rfc3339(),
    };
    manifest.installed.retain(|i| i.name != sm.name);
    manifest.installed.push(r.clone());
    write_manifest(repo_root, &manifest)?;
    write_lock(repo_root, &manifest)?;
    project(repo_root)?;
    Ok(r)
}

/// Install from a local directory, labeling provenance as `local:<canonical-path>`.
pub fn install_local(repo_root: &Path, source_dir: &Path) -> Result<InstalledRef, CdlcError> {
    let label = format!(
        "local:{}",
        source_dir.canonicalize().unwrap_or_else(|_| source_dir.to_path_buf()).display()
    );
    install_from_dir(repo_root, source_dir, &label)
}

/// Read an installed package's raw files + parsed manifest (for republish).
pub fn read_skill_package(
    repo_root: &Path,
    name: &str,
) -> Result<(String, String, SkillManifest), CdlcError> {
    if !valid_pkg_name(name) {
        return Err(CdlcError::InvalidPackage(format!("invalid skill name: {:?}", name)));
    }
    let dir = cdlc_dir(repo_root).join("skills").join(name);
    let toml_s = std::fs::read_to_string(dir.join("skill.toml"))?;
    let md_s = std::fs::read_to_string(dir.join("SKILL.md"))?;
    let sm: SkillManifest = toml::from_str(&toml_s)?;
    Ok((toml_s, md_s, sm))
}
```
(Confirm the existing imports — `Sha256`/`Digest`, `cdlc_dir`, `read_manifest`, `write_manifest`, `write_lock`, `project`, `valid_pkg_name`, `SkillManifest`, `InstalledRef` — are already in scope from the current file; they are, since `install_local` used them. Do not duplicate `write_lock`/`valid_pkg_name`.)

- [ ] **Step 4: Re-export in lib.rs**

In `crates/cdlc/src/lib.rs`, extend the install re-export line to include the new fns:
```rust
pub use install::{install_from_dir, install_local, read_skill_package, status, CdlcStatus};
```

- [ ] **Step 5: Run tests, verify pass**

Run: `cargo test -p karl-cdlc 2>&1 | tail -12`
Expected: all pass (existing + `install_from_dir_uses_custom_source_label`).

- [ ] **Step 6: Commit**

```bash
git add crates/cdlc/src/install.rs crates/cdlc/src/lib.rs
git commit -m "feat(cdlc): install_from_dir with source label + read_skill_package"
```

---

### Task 2: `crates/app` — registry HTTP client + Tauri commands + api.ts

**Files:**
- Create: `crates/app/src/cdlc_registry.rs`
- Modify: `crates/app/src/lib.rs` (mod decl + 4 commands + handler registration)
- Modify: `ui/src/api.ts` (types + 4 wrappers)

**Interfaces:**
- Consumes: `karl_score::auth::{load_jwt, backend_url}`, `karl_cdlc::{read_skill_package, install_from_dir, InstalledRef}`, `karl_score::record_cdlc_install`.
- Produces (TS): `cdlcMyOrgs()`, `cdlcSearch(org, query)`, `cdlcPublish(cwd, org, name)`, `cdlcInstallRegistry(cwd, org, name, version, group, workspace)`; types `Org`, `PkgMeta`.

- [ ] **Step 1: Write the registry HTTP module**

Create `crates/app/src/cdlc_registry.rs`:
```rust
//! Authed HTTP client for the covenant-server CDLC package registry.
use karl_score::auth;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Org {
    pub id: i64,
    pub slug: String,
    pub name: String,
    pub role: String,
}

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
}

#[derive(Debug, Clone, Deserialize)]
pub struct PkgFull {
    pub id: i64,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub description: String,
    pub skill_toml: String,
    pub skill_md: String,
    pub sha: String,
    pub publisher_login: String,
}

fn jwt() -> Result<String, String> {
    auth::load_jwt()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "not signed in to Covenant".to_string())
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

pub async fn list_orgs() -> Result<Vec<Org>, String> {
    let j = jwt()?;
    let url = format!("{}/orgs", auth::backend_url());
    client()
        .get(&url)
        .bearer_auth(&j)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())
}

pub async fn search(org: &str, q: Option<&str>) -> Result<Vec<PkgMeta>, String> {
    let j = jwt()?;
    let mut url = format!("{}/cdlc/packages?org={}", auth::backend_url(), urlencoding(org));
    if let Some(q) = q.filter(|s| !s.is_empty()) {
        url.push_str(&format!("&q={}", urlencoding(q)));
    }
    client()
        .get(&url)
        .bearer_auth(&j)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())
}

pub async fn resolve(org: &str, name: &str, version: &str) -> Result<PkgFull, String> {
    let j = jwt()?;
    let url = format!(
        "{}/cdlc/packages/{}/{}/{}",
        auth::backend_url(),
        urlencoding(org),
        urlencoding(name),
        urlencoding(version)
    );
    client()
        .get(&url)
        .bearer_auth(&j)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())
}

#[allow(clippy::too_many_arguments)]
pub async fn publish(
    org: &str,
    name: &str,
    version: &str,
    description: &str,
    skill_toml: &str,
    skill_md: &str,
) -> Result<Value, String> {
    let j = jwt()?;
    let url = format!("{}/cdlc/packages", auth::backend_url());
    let body = serde_json::json!({
        "org": org, "name": name, "version": version,
        "description": description, "skill_toml": skill_toml, "skill_md": skill_md,
    });
    client()
        .post(&url)
        .bearer_auth(&j)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())
}

pub async fn record_install(id: i64) -> Result<(), String> {
    let j = jwt()?;
    let url = format!("{}/cdlc/packages/{}/install", auth::backend_url(), id);
    client()
        .post(&url)
        .bearer_auth(&j)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Minimal percent-encoding for path/query segments (slug/name/version are
/// already restricted to url-safe chars server-side, but encode defensively).
fn urlencoding(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::urlencoding;
    #[test]
    fn urlencoding_escapes_unsafe() {
        assert_eq!(urlencoding("kyc-peru"), "kyc-peru");
        assert_eq!(urlencoding("a b/c"), "a%20b%2Fc");
        assert_eq!(urlencoding("1.0.0"), "1.0.0");
    }
}
```

- [ ] **Step 2: Run the unit test**

Run: `cargo test -p covenant cdlc_registry 2>&1 | tail -8` (app package is `covenant`).
Expected: `urlencoding_escapes_unsafe` passes (after the module is declared in Step 3).

- [ ] **Step 3: Declare the module + add Tauri commands**

In `crates/app/src/lib.rs`, add `mod cdlc_registry;` near the other `mod` declarations. Add the four commands near the existing `cdlc_install_local` command:
```rust
#[tauri::command]
async fn cdlc_my_orgs() -> Result<Vec<cdlc_registry::Org>, String> {
    cdlc_registry::list_orgs().await
}

#[tauri::command]
async fn cdlc_search(org: String, query: Option<String>) -> Result<Vec<cdlc_registry::PkgMeta>, String> {
    cdlc_registry::search(&org, query.as_deref()).await
}

#[tauri::command]
async fn cdlc_publish(cwd: String, org: String, name: String) -> Result<serde_json::Value, String> {
    let repo = std::path::PathBuf::from(cwd);
    let (toml_s, md_s, sm) = tokio::task::spawn_blocking(move || karl_cdlc::read_skill_package(&repo, &name))
        .await
        .map_err(|e| format!("cdlc_publish join: {e}"))?
        .map_err(|e| e.to_string())?;
    cdlc_registry::publish(&org, &sm.name, &sm.version, "", &toml_s, &md_s).await
}

#[tauri::command]
async fn cdlc_install_registry(
    cwd: String,
    org: String,
    name: String,
    version: String,
    group: Option<String>,
    workspace: Option<String>,
) -> Result<karl_cdlc::InstalledRef, String> {
    let full = cdlc_registry::resolve(&org, &name, &version).await?;
    let pkg_id = full.id;
    let label = format!("registry:{}/{}@{}", org, full.name, full.version);
    let repo = std::path::PathBuf::from(cwd);
    let toml_s = full.skill_toml.clone();
    let md_s = full.skill_md.clone();
    let pkg_name = full.name.clone();
    let pkg_ver = full.version.clone();
    let r = tokio::task::spawn_blocking(move || {
        let tmp = std::env::temp_dir().join(format!("cdlc-reg-{pkg_name}-{pkg_ver}"));
        std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
        std::fs::write(tmp.join("skill.toml"), toml_s.as_bytes()).map_err(|e| e.to_string())?;
        std::fs::write(tmp.join("SKILL.md"), md_s.as_bytes()).map_err(|e| e.to_string())?;
        let res = karl_cdlc::install_from_dir(&repo, &tmp, &label).map_err(|e| e.to_string());
        let _ = std::fs::remove_dir_all(&tmp);
        res
    })
    .await
    .map_err(|e| format!("cdlc_install_registry join: {e}"))??;
    // best-effort adoption telemetry (don't fail the install if these error)
    let _ = cdlc_registry::record_install(pkg_id).await;
    karl_score::record_cdlc_install(&r.name, group, workspace);
    Ok(r)
}
```

- [ ] **Step 4: Register the commands**

In the `tauri::generate_handler![...]` list, add (next to `cdlc_install_local`):
```rust
        cdlc_my_orgs,
        cdlc_search,
        cdlc_publish,
        cdlc_install_registry,
```

- [ ] **Step 5: Add the TS wrappers**

In `ui/src/api.ts`, add (near the Phase-1 cdlc wrappers):
```typescript
export interface Org {
  id: number;
  slug: string;
  name: string;
  role: string;
}
export interface PkgMeta {
  id: number;
  name: string;
  version: string;
  description: string;
  publisher_login: string;
  installs: number;
  sha: string;
}
export async function cdlcMyOrgs(): Promise<Org[]> {
  return invoke<Org[]>("cdlc_my_orgs");
}
export async function cdlcSearch(org: string, query: string | null): Promise<PkgMeta[]> {
  return invoke<PkgMeta[]>("cdlc_search", { org, query });
}
export async function cdlcPublish(cwd: string, org: string, name: string): Promise<unknown> {
  return invoke<unknown>("cdlc_publish", { cwd, org, name });
}
export async function cdlcInstallRegistry(
  cwd: string,
  org: string,
  name: string,
  version: string,
  group: string | null,
  workspace: string | null,
): Promise<InstalledRef> {
  return invoke<InstalledRef>("cdlc_install_registry", { cwd, org, name, version, group, workspace });
}
```

- [ ] **Step 6: Verify build + unit test + typecheck**

Run: `cargo build -p covenant 2>&1 | tail -15 && cargo test -p covenant cdlc_registry 2>&1 | tail -6 && npm run -s typecheck 2>&1 | tail -10`
Expected: build OK, `urlencoding_escapes_unsafe` passes, typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add crates/app/src/cdlc_registry.rs crates/app/src/lib.rs ui/src/api.ts
git commit -m "feat(cdlc): registry HTTP client + cdlc_my_orgs/search/publish/install_registry commands"
```

---

### Task 3: CDLC panel — org picker + Publish + Install flow

**Files:**
- Modify: `ui/src/cdlc/panel.ts`
- Modify: `ui/src/cdlc/panel.test.ts`

**Interfaces:**
- Consumes (TS): `cdlcMyOrgs`, `cdlcSearch`, `cdlcPublish`, `cdlcInstallRegistry`, `Org`, `PkgMeta`, `cdlcLocalStatus` (Phase 1).

- [ ] **Step 1: Write the failing render test**

In `ui/src/cdlc/panel.test.ts`, add (the file already mocks `../api` — extend the mock to include the new fns):
```typescript
  it("shows a Publish button per installed skill when orgs exist", async () => {
    const host = document.createElement("div");
    const panel = new CdlcPanel({
      groupId: "g1", groupLabel: "Payments", groupColor: null, groupRootDir: "/repo",
    }).mount(host);
    // simulate orgs loaded + a status with one installed skill
    panel.setOrgs([{ id: 1, slug: "mibanco", name: "Mibanco", role: "owner" }]);
    panel.renderStatus({
      installed: [
        { name: "kyc-peru", version: "1.0.0", source: "local:/x", sha: "a", signer: null, installedAt: "t" },
      ],
      contextFiles: [],
    });
    expect(host.querySelector("button.cdlc-publish-btn")).not.toBeNull();
    expect(host.textContent).toContain("kyc-peru");
  });
```
(In the `vi.mock("../api", ...)` block at the top of the file, add stubs: `cdlcMyOrgs: vi.fn().mockResolvedValue([])`, `cdlcSearch: vi.fn().mockResolvedValue([])`, `cdlcPublish: vi.fn().mockResolvedValue({}), cdlcInstallRegistry: vi.fn().mockResolvedValue({})`.)

- [ ] **Step 2: Run it, verify it fails**

Run (repo root): `npm run -s test -- ui/src/cdlc/panel.test.ts 2>&1 | tail -20`
Expected: FAIL — `setOrgs` / `cdlc-publish-btn` not present.

- [ ] **Step 3: Add org loading + Publish button + Install flow to the panel**

In `ui/src/cdlc/panel.ts`:

(a) Import the new api fns + types at the top:
```typescript
import { cdlcLocalStatus, cdlcMyOrgs, cdlcSearch, cdlcPublish, cdlcInstallRegistry } from "../api";
import type { CdlcStatus, Org, PkgMeta } from "../api";
```

(b) Add an `orgs` field + a `setOrgs` setter + load orgs in `mount`:
```typescript
  private orgs: Org[] = [];

  setOrgs(orgs: Org[]): void {
    this.orgs = orgs;
  }
```
In `mount(...)`, after `void this.refresh();` add:
```typescript
    void cdlcMyOrgs().then((o) => { this.orgs = o; }).catch(() => { this.orgs = []; });
```

(c) In `renderStatus`, in the installed-skill row loop, append a Publish button (only when at least one org exists and the skill isn't already from the registry):
```typescript
      for (const i of s.installed) {
        const row = document.createElement("div");
        row.className = "cdlc-skill-row";
        const label = document.createElement("span");
        label.textContent = `${i.name}  ${i.version}  ${i.source}`;
        row.appendChild(label);
        if (this.orgs.length > 0) {
          const pub = document.createElement("button");
          pub.className = "cdlc-publish-btn";
          pub.textContent = "Publish";
          pub.addEventListener("click", () => void this.publish(i.name));
          row.appendChild(pub);
        }
        skills.appendChild(row);
      }
```

(d) Add the `publish` + `install` methods (use the group's root dir as `cwd`):
```typescript
  private async publish(name: string): Promise<void> {
    const cwd = this.opts.groupRootDir;
    if (!cwd || this.orgs.length === 0) return;
    const org = this.orgs[0].slug; // v1: publish to the caller's first org
    try {
      await cdlcPublish(cwd, org, name);
      await this.refresh();
    } catch (e) {
      this.body.appendChild(errorLine(`Publish failed: ${String(e)}`));
    }
  }

  private async install(org: string, name: string, version: string): Promise<void> {
    const cwd = this.opts.groupRootDir;
    if (!cwd) return;
    try {
      await cdlcInstallRegistry(cwd, org, name, version, this.opts.groupLabel ?? null, null);
      await this.refresh();
    } catch (e) {
      this.body.appendChild(errorLine(`Install failed: ${String(e)}`));
    }
  }
```
Add a tiny module-level helper near the top of the file:
```typescript
function errorLine(text: string): HTMLElement {
  const p = document.createElement("p");
  p.className = "cdlc-error";
  p.textContent = text;
  return p;
}
```

(e) Add an Install search box to the Skills section header (after the `Skills` `<h3>`): an input + button that calls `cdlcSearch(this.orgs[0].slug, q)` and renders results, each with an Install button calling `this.install(...)`:
```typescript
    if (this.orgs.length > 0) {
      const searchRow = document.createElement("div");
      searchRow.className = "cdlc-search-row";
      const input = document.createElement("input");
      input.placeholder = `Search ${this.orgs[0].slug} registry…`;
      const go = document.createElement("button");
      go.textContent = "Search";
      const results = document.createElement("div");
      results.className = "cdlc-search-results";
      go.addEventListener("click", () => {
        void cdlcSearch(this.orgs[0].slug, input.value || null).then((rows: PkgMeta[]) => {
          results.replaceChildren();
          for (const r of rows) {
            const rr = document.createElement("div");
            rr.className = "cdlc-search-result";
            rr.textContent = `${r.name} ${r.version} (${r.installs} installs) — ${r.publisher_login}`;
            const inst = document.createElement("button");
            inst.textContent = "Install";
            inst.addEventListener("click", () => void this.install(this.orgs[0].slug, r.name, r.version));
            rr.appendChild(inst);
            results.appendChild(rr);
          }
        }).catch((e) => { results.replaceChildren(errorLine(String(e))); });
      });
      searchRow.append(input, go);
      skills.append(searchRow, results);
    }
```

- [ ] **Step 4: Run the test, verify pass**

Run (repo root): `npm run -s test -- ui/src/cdlc/panel.test.ts 2>&1 | tail -20`
Expected: the new test + existing panel tests pass.

- [ ] **Step 5: Typecheck**

Run (repo root): `npm run -s typecheck 2>&1 | tail -10`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add ui/src/cdlc/panel.ts ui/src/cdlc/panel.test.ts
git commit -m "feat(cdlc): panel org-aware Publish + registry search/Install flow"
```

---

## Self-Review

**Spec coverage (§D):**
- `cdlc_my_orgs` → Task 2 ✓; `cdlc_publish` (reads local skill, POSTs) → Tasks 1+2 ✓; `cdlc_search` → Task 2 ✓; `cdlc_install_registry` (resolve → tempdir → `install_from_dir` → record_install + score telemetry) → Tasks 1+2 ✓.
- `registry:<org>/<name>@<version>` source label → Task 1 (`install_from_dir`) + Task 2 (label construction) ✓.
- Reuse existing JWT + backend_url → Task 2 (`karl_score::auth`) ✓.
- Panel Publish + Install → Task 3 ✓.

**Out of scope (correctly absent):** eval runner, Observe/Adapt, invite flows, public packages, an org-management UI beyond "publish to my first org" (v1 picks `orgs[0]`; a full org picker dropdown is a fast follow if multiple orgs are common).

**Placeholder scan:** none. The one v1 simplification (publish/search target `orgs[0]` rather than a dropdown) is explicit and noted; acceptable because most users will have one org initially.

**Type consistency:** `install_from_dir`/`read_skill_package` defined in Task 1, consumed in Task 2. `Org`/`PkgMeta`/`PkgFull` snake_case (server JSON) consistent across Rust + TS. `cdlcInstallRegistry` returns `InstalledRef` (existing camelCase type). Command arg names (`cwd, org, name, version, group, workspace`) match the TS invoke keys.

**Test-strategy honesty:** Rust unit tests cover the source-label install (Task 1) and `urlencoding` (Task 2); the panel render test covers the Publish-button wiring (Task 3). The reqwest handlers are build-verified; their live behavior was already proven against the running server in Plan 2a's verification and will be re-checked end-to-end via `/verify` once the desktop is signed in.

## Notes for execution
- App package name is `covenant`; cdlc crate `karl-cdlc`; score crate `karl_score`.
- `cdlc_publish` sends `description: ""` (the local `SkillManifest` has no description field) — the server defaults it. A description field on packages is a later add.
- v1 publishes/searches against `orgs[0]`; if the user belongs to multiple orgs, add a `<select>` populated from `this.orgs` — flagged, not built.
