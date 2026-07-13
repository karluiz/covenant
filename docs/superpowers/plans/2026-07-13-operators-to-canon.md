# Operators → Canon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Operators become org-scoped citizens of the Canon (rail fold + cockpit section + registry fold for the marketplace); Settings keeps only AOM; the canon "Agents" kind is relabeled "Subagents".

**Architecture:** Local-first org scoping — a nullable `org_slug` column on the operators table where **NULL = personal org** (no data migration). Filtering is client-side (`operatorsForOrg` helper) so existing `operatorList()` callers (AOM, chips, spawn) keep seeing all operators. The immersive creator relocates from `ui/src/settings/` to `ui/src/operator/` and is driven from the cockpit. Marketplace server APIs (`marketplace_*`) are untouched; only the UI folds into the cockpit registry section.

**Tech Stack:** Rust (rusqlite, Tauri 2 commands), TypeScript strict (no frameworks), vitest (run from repo ROOT), cargo test.

**Spec:** `docs/superpowers/specs/2026-07-13-operators-to-canon-design.md`

## Global Constraints

- Worktree: all work in `/Users/carlosgallardoarenas/Sources/karlTerminal/.claude/worktrees/operators-to-canon`. Stage files explicitly — NEVER `git add -A` (node_modules symlink gotcha).
- `npm test` from repo ROOT, never from `ui/`.
- No emoji in chrome — inline SVG via `Icons.*` only. No native tooltips — `attachTooltip`, never `element.title`. New panels: `border-radius: 0`.
- Conventional Commits; one commit per task (user preference: per feature, not per TDD step).
- TS strict, no `as any` without a justifying comment.
- Column name is `org_slug` (spec-locked), not `org_id`.
- Deviations from spec (approved intent, lazier mechanics): (a) org filtering is client-side, `operator_list` command unchanged; (b) rail row click opens the SOUL in the markdown reader (consistent with every other rail kind) instead of jumping to the cockpit.

---

### Task 1: Backend — `org_slug` column + `operator_set_org` command

**Files:**
- Modify: `crates/app/src/storage.rs` (ALTER block ~:757, `operator_insert` :1832, `operator_update` :1876, `operator_list` :2032, tests ~:4680)
- Modify: `crates/app/src/operator_registry.rs` (`Operator` struct :28-71, commands mod ~:805+)
- Modify: the Tauri `invoke_handler` registration (find via grep, see Step 5)

**Interfaces:**
- Produces: `Operator.org_slug: Option<String>` (serde default, registry-only — NOT SOUL frontmatter); Tauri command `operator_set_org(id: String, org_slug: Option<String>)`; storage methods `operator_set_org(id, org_slug)`.

- [ ] **Step 1: Write failing storage tests** (in the storage.rs test mod, near `operator_github_access_roundtrip_and_set` ~:4680)

```rust
#[tokio::test]
async fn operator_org_slug_roundtrip_and_set() {
    let (s, _dir) = fresh();
    let mut op = test_operator(); // build the same full Operator literal the neighboring tests use
    op.org_slug = Some("acme".into());
    s.operator_insert(op.clone()).await.unwrap();
    let listed = s.operator_list().await.unwrap();
    let got = listed.iter().find(|o| o.id == op.id).unwrap();
    assert_eq!(got.org_slug.as_deref(), Some("acme"));

    s.operator_set_org(op.id.to_string(), None).await.unwrap();
    let listed = s.operator_list().await.unwrap();
    let got = listed.iter().find(|o| o.id == op.id).unwrap();
    assert_eq!(got.org_slug, None);
}
```

Also mirror the legacy-row pattern from `operator_voice_*` (~:4640): raw-INSERT a row omitting `org_slug`, assert the mapper yields `None` (personal).

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p covenant-app operator_org_slug -- --nocapture` (adjust crate name to what `crates/app/Cargo.toml` declares).
Expected: FAIL — no field `org_slug`, no method `operator_set_org`.

- [ ] **Step 3: Implement**

1. `operator_registry.rs` `Operator` struct — add after `perception_enabled`:
```rust
/// Org this operator belongs to; None = personal org. Registry-only (NOT SOUL frontmatter).
#[serde(default)]
pub org_slug: Option<String>,
```
Fix every `Operator { ... }` literal the compiler flags (`create_from_soul` :449-469, `operator_create` command :935-955, `operator_update` command :970-990 — in update, preserve `org_slug: existing.org_slug.clone()` like `github_access` — plus all test literals) with `org_slug: None`.

2. `storage.rs` ALTER block (after :752, same idempotent pattern):
```rust
let _ = conn.execute("ALTER TABLE operators ADD COLUMN org_slug TEXT", []);
```

3. `operator_insert`: add `org_slug` as column 19 (`?19`, `op.org_slug`).
4. `operator_update`: add `org_slug=?16` to the SET list, `op.org_slug` param.
5. `operator_list`: add `org_slug` to SELECT (index 18), mapper: `org_slug: row.get(18)?,`.
6. New storage method, mirroring `operator_set_default`'s shape:
```rust
pub async fn operator_set_org(&self, id: String, org_slug: Option<String>) -> Result<(), StorageError> {
    let conn = self.inner.clone();
    tokio::task::spawn_blocking(move || -> Result<(), StorageError> {
        let c = conn.blocking_lock();
        c.execute("UPDATE operators SET org_slug=?2 WHERE id=?1", params![id, org_slug])?;
        Ok(())
    })
    .await
    .map_err(|e| StorageError::Join(e.to_string()))?
}
```

- [ ] **Step 4: Registry method + Tauri command** (mirror `operator_set_github_access` end-to-end: registry method updates the in-memory `by_id` map AND calls storage)

```rust
#[tauri::command]
pub async fn operator_set_org(
    id: String,
    org_slug: Option<String>,
    registry: State<'_, Arc<OperatorRegistry>>,
    storage: State<'_, Arc<Storage>>,
) -> Result<(), String> {
    registry.set_org(&storage, &id, org_slug).await.map_err(map_err)
}
```

- [ ] **Step 5: Register the command**

Run: `grep -rn "operator_set_github_access" crates/app/src --include="*.rs" | grep -v operator_registry` to find the `invoke_handler` list; add `operator_set_org` beside it.

- [ ] **Step 6: Run tests**

Run: `cargo test -p covenant-app operator_ -- --nocapture`
Expected: PASS (all operator tests, old and new).

- [ ] **Step 7: Commit**

```bash
git add crates/app/src/storage.rs crates/app/src/operator_registry.rs <invoke_handler file>
git commit -m "feat(operators): org_slug column + operator_set_org command (NULL = personal org)"
```

---

### Task 2: Frontend API + org-filter helper

**Files:**
- Modify: `ui/src/api.ts` (`Operator` :320-344, wrappers ~:481)
- Create: `ui/src/operator/org-filter.ts`
- Test: `ui/src/operator/org-filter.test.ts`

**Interfaces:**
- Consumes: Task 1's `operator_set_org` command.
- Produces: `Operator.org_slug?: string | null`; `operatorSetOrg(id: string, orgSlug: string | null): Promise<void>`; `operatorsForOrg(ops: Operator[], org: Org | null, knownSlugs: Set<string>): Operator[]`; `isStaleOrg(op: Operator, knownSlugs: Set<string>): boolean`.

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it } from "vitest";
import { operatorsForOrg, isStaleOrg } from "./org-filter";
import type { Operator, Org } from "../api";

const op = (name: string, org_slug: string | null): Operator =>
  ({ name, org_slug } as unknown as Operator); // test double: only the filtered fields matter

const acme: Org = { id: "1", slug: "acme", name: "Acme", role: "owner", personal: false };
const personal: Org = { id: "2", slug: "me", name: "Me", role: "owner", personal: true };

describe("operatorsForOrg", () => {
  const ops = [op("a", null), op("b", "acme"), op("c", "ghost-org")];
  const known = new Set(["acme", "me"]);

  it("personal bucket = null org_slug plus stale slugs", () => {
    expect(operatorsForOrg(ops, personal, known).map((o) => o.name)).toEqual(["a", "c"]);
    expect(operatorsForOrg(ops, null, known).map((o) => o.name)).toEqual(["a", "c"]);
  });

  it("non-personal org filters by slug", () => {
    expect(operatorsForOrg(ops, acme, known).map((o) => o.name)).toEqual(["b"]);
  });

  it("isStaleOrg flags unknown slugs only", () => {
    expect(isStaleOrg(op("c", "ghost-org"), known)).toBe(true);
    expect(isStaleOrg(op("a", null), known)).toBe(false);
    expect(isStaleOrg(op("b", "acme"), known)).toBe(false);
  });
});
```

- [ ] **Step 2: Run** `npm test -- org-filter` (repo root). Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`ui/src/api.ts`: add to `Operator`: `org_slug?: string | null;` and next to the other operator wrappers (match their exact invoke-arg style — check how `operatorSetGithubAccess` passes args and mirror it):
```ts
/** Assign an operator to an org; null returns it to the personal roster. */
export function operatorSetOrg(id: string, orgSlug: string | null): Promise<void> {
  return invoke("operator_set_org", { id, orgSlug });
}
```

`ui/src/operator/org-filter.ts`:
```ts
import type { Operator, Org } from "../api";

/** True when the operator points at an org we no longer know (deleted server-side). */
export function isStaleOrg(op: Operator, knownSlugs: Set<string>): boolean {
  return !!op.org_slug && !knownSlugs.has(op.org_slug);
}

/**
 * Bucket operators by active org. Personal (or no org) shows NULL-org operators
 * plus any whose org no longer exists, so nothing silently disappears.
 */
export function operatorsForOrg(ops: Operator[], org: Org | null, knownSlugs: Set<string>): Operator[] {
  if (!org || org.personal) return ops.filter((o) => !o.org_slug || isStaleOrg(o, knownSlugs));
  return ops.filter((o) => o.org_slug === org.slug);
}
```

- [ ] **Step 4: Run** `npm test -- org-filter`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/api.ts ui/src/operator/org-filter.ts ui/src/operator/org-filter.test.ts
git commit -m "feat(operators): org_slug on Operator + operatorSetOrg + org bucket filter"
```

---

### Task 3: Relocate the immersive creator to `ui/src/operator/`

**Files:**
- Create: `ui/src/operator/creator.ts` (moved code)
- Create: `ui/src/operator/operator-creator.css` (moved from `ui/src/settings/operator-creator.css`)
- Modify: `ui/src/settings/operators.ts` (shrinks to the panes + re-exports)
- Move test: `ui/src/settings/operators.test.ts` → `ui/src/operator/creator.test.ts`

**Interfaces:**
- Produces (from `ui/src/operator/creator.ts`): everything `settings/operators.ts` exported EXCEPT the panes — `STARTER_SKILLS`, `mergeSkillVocab`, `SectionKey`, `ModalDraft`, `ModalState`, `ModalHandle`, `canSave`, `canProceedFromStep1`, `openOperatorModal(opts: { mode: "create" | "edit"; preset?: PresetKey; existing?: Operator }): ModalHandle`, `saveOperator`, `ListHandlers`, `renderOperatorList`, **plus a new** `wireOperatorModal` (Step 2).

- [ ] **Step 1: Move the module**

Cut everything from `ui/src/settings/operators.ts` except `OperatorsPane` (:119-329) and `LegacyOperatorsPane` (:336+) into `ui/src/operator/creator.ts`. Adjust imports for the new location: `./operator_presets|soul_frontmatter|operator_chip|cloud_push|marketplace_install` → `../settings/...`; `../operator/avatars` → `./avatars`; `../api`, `../ui/...` unchanged; move `operator-creator.css` next to it and import `"./operator-creator.css"`. At the top of the shrunken `settings/operators.ts` re-export for any straggler importers:
```ts
export * from "../operator/creator";
```
and make the panes import what they use from `../operator/creator`.

- [ ] **Step 2: Extract the modal-save orchestration**

Port `OperatorsPane.openModalWith` (:179-277) into `ui/src/operator/creator.ts` as an exported function, replacing `this.*`:

```ts
export interface WireOpts {
  /** After a successful save. Receives the saved operator. */
  onSaved: (op: Operator) => void | Promise<void>;
  /** Delete button in edit mode. Omit to hide/ignore. */
  onDelete?: (op: Operator) => void;
  /**
   * Org to assign after a successful save. `undefined` = don't touch;
   * a string = assign to that org; `null` = clear to personal (used to
   * rescue stale-org operators on edit). Applies in BOTH modes.
   */
  assignOrgSlug?: string | null;
}

export function wireOperatorModal(handle: ModalHandle, opts: WireOpts): void { /* ported body */ }
```

The ported body is `openModalWith` verbatim with: `this.refresh()` → `opts.onSaved(saved)`; `this.deleteOperator(op)` → `opts.onDelete?.(op)`; and after any successful `saveOperator(handle)` (create OR edit), when `opts.assignOrgSlug !== undefined`: `await operatorSetOrg(saved.id, opts.assignOrgSlug);`. Rewrite `OperatorsPane.openModalWith` as a thin call to `wireOperatorModal` so the settings pane keeps working until Task 8 deletes it.

- [ ] **Step 3: Move the test file** to `ui/src/operator/creator.test.ts`, imports `./creator`.

- [ ] **Step 4: Verify**

Run: `npm test -- creator && npm run build`
Expected: creator tests PASS, tsc clean (build catches any missed import).

- [ ] **Step 5: Commit**

```bash
git add ui/src/operator/creator.ts ui/src/operator/operator-creator.css ui/src/operator/creator.test.ts ui/src/settings/operators.ts
git rm ui/src/settings/operator-creator.css ui/src/settings/operators.test.ts
git commit -m "refactor(operators): relocate immersive creator to ui/src/operator with wireOperatorModal"
```

---

### Task 4: Cockpit "Operators" section

**Files:**
- Modify: `ui/src/canon/cockpit/view.ts` (`SectionKey` :34, `SECTIONS` :61-73, `SECTION_HEAD` :76-88, `renderSection` :162-181, new renderer near `renderAgentsSection` :463)
- Modify: `ui/src/operator/creator.ts` (`ListHandlers`/`renderOperatorList` gain stale badge)
- Test: `ui/src/canon/cockpit/view.test.ts`

**Interfaces:**
- Consumes: `operatorList`, `operatorDelete`, `marketplacePublish` (`../../api`); `openOperatorModal`, `wireOperatorModal`, `renderOperatorList` (`../../operator/creator`); `operatorsForOrg`, `isStaleOrg` (`../../operator/org-filter`); `scheduleCloudPush` (`../../settings/cloud_push`).
- Produces: `SectionKey` includes `"operators"`; `ListHandlers.isStale?: (op: Operator) => boolean` renders an `.op-card-badge` "unassigned" pill.

- [ ] **Step 1: Failing test** (in `view.test.ts`, following its existing mock pattern — extend the `vi.mock("../../api", ...)` factory with `operatorList: vi.fn(async () => [OPERATOR_FIXTURE])` and mock `../../operator/creator` passthrough is NOT needed — real `renderOperatorList` is pure DOM):

```ts
it("operators section renders the org-filtered roster with a New operator button", async () => {
  const v = makeView(); // existing helper/constructor pattern in this file
  v.open();
  v.showSection("operators");
  await vi.waitFor(() => {
    expect(v.element.querySelector(".op-card-grid")).toBeTruthy();
    expect(v.element.textContent).toContain("Zeta");
    expect(v.element.querySelector("[data-role='op-new']")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run** `npm test -- cockpit/view`. Expected: FAIL (unknown section "operators").

- [ ] **Step 3: Implement**

1. `SectionKey`: add `"operators"` before `"agents"`. Add nav entry in `SECTIONS` and:
```ts
operators: ["Operators", "Versions of you, delegated — org-scoped personas that direct your executors."],
```
2. `renderSection` dispatch: `key === "operators" ? this.renderOperatorsSection() : ...`.
3. Renderer (pattern: `renderAgentsSection` async-fill; grid + header button):

```ts
private renderOperatorsSection(): HTMLElement {
  const el = document.createElement("div");
  el.className = "canon-cockpit-section is-operators";
  const bar = document.createElement("div");
  bar.className = "canon-cockpit-actions";
  const newBtn = iconButton(Icons.plus({ size: 15 }), "New operator", () => {
    const active = this.activeOrg();
    const handle = openOperatorModal({ mode: "create" });
    wireOperatorModal(handle, {
      assignOrgSlug: active && !active.personal ? active.slug : null,
      onSaved: () => this.showSection("operators"),
    });
  });
  newBtn.dataset.role = "op-new";
  bar.appendChild(newBtn);
  el.appendChild(bar);

  const list = document.createElement("div");
  list.appendChild(this.note("Loading…"));
  el.appendChild(list);

  void operatorList()
    .then((all) => {
      const known = new Set(this.opts.orgs.map((o) => o.slug));
      const active = this.activeOrg();
      const ops = operatorsForOrg(all, active, known);
      list.replaceChildren();
      if (ops.length === 0) { list.appendChild(this.note("No operators in this org yet.")); return; }
      list.appendChild(renderOperatorList(ops, {
        isStale: (op) => isStaleOrg(op, known),
        onEdit: (op) => {
          const handle = openOperatorModal({ mode: "edit", existing: op });
          wireOperatorModal(handle, {
            // Rescue stale-org operators: saving from the personal view clears the dead slug.
            assignOrgSlug: isStaleOrg(op, known) ? null : undefined,
            onSaved: () => this.showSection("operators"),
            onDelete: (o) => void this.deleteOperator(o),
          });
        },
        onDuplicate: (op) => {
          const handle = openOperatorModal({ mode: "create", existing: { ...op, name: `${op.name} copy` } });
          wireOperatorModal(handle, {
            assignOrgSlug: active && !active.personal ? active.slug : null,
            onSaved: () => this.showSection("operators"),
          });
        },
        onPublish: (op) => { void marketplacePublish(op.id).then(() => pushInfoToast(`${op.name} submitted — pending review`)); },
        onDelete: (op) => void this.deleteOperator(op),
      }));
    })
    .catch((e) => { list.replaceChildren(); list.appendChild(this.note(`Failed to load operators: ${this.friendlyError(e)}`)); });
  return el;
}
```
4. Port `deleteOperator` guards from `OperatorsPane` (:293-319) as a private method: block deleting the default and the last operator, `confirm`, `operatorDelete(op.id)`, dispatch `window` `"operator:deleted"` CustomEvent, `scheduleCloudPush()`, re-render via `this.showSection("operators")`.
5. `renderOperatorList` in `creator.ts`: add `isStale?: (op: Operator) => boolean` to `ListHandlers`; when true, append inside the card:
```ts
const badge = document.createElement("span");
badge.className = "op-card-badge";
badge.textContent = `unassigned · ${op.org_slug}`;
card.append(badge);
```
Style it in `operator-creator.css` (sharp corners, muted token colors — follow neighboring pill styles).

- [ ] **Step 4: Run** `npm test -- cockpit/view` then full `npm test`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/canon/cockpit/view.ts ui/src/canon/cockpit/view.test.ts ui/src/operator/creator.ts ui/src/operator/operator-creator.css
git commit -m "feat(canon): Operators section in the cockpit — org-scoped roster with immersive creator"
```

---

### Task 5: Registry section — Skills | Operators toggle

**Files:**
- Modify: `ui/src/canon/cockpit/view.ts` (`renderRegistrySection` :738-825, `SECTION_HEAD.registry` copy)
- Test: `ui/src/canon/cockpit/view.test.ts`

**Interfaces:**
- Consumes: `marketplaceSearch`, `MarketplaceListing`, `operatorCreateFromSoul`, `operatorList`, `operatorSetOrg`, `marketplaceInstallCount` (`../../api`); `suffixSoulName` (`../../settings/marketplace_install`); `skillCard` (existing import).
- Produces: registry section with a two-button kind toggle; operators install into the active org.

- [ ] **Step 1: Failing test**

```ts
it("registry toggle switches to operators and renders marketplace results", async () => {
  const v = makeView();
  v.open();
  v.showSection("registry");
  const toggle = [...v.element.querySelectorAll(".canon-reg-kind")].find((b) => b.textContent === "Operators")!;
  (toggle as HTMLButtonElement).click();
  await vi.waitFor(() => {
    expect(v.element.textContent).toContain("Zeta"); // mocked marketplaceSearch listing
  });
});
```
Mock `marketplaceSearch: vi.fn(async () => [LISTING_FIXTURE])` in the api mock factory.

- [ ] **Step 2: Run** `npm test -- cockpit/view`. Expected: FAIL (no `.canon-reg-kind`).

- [ ] **Step 3: Implement**

In `renderRegistrySection`, above the search row, add the toggle (two `.canon-reg-kind` buttons "Skills" / "Operators", `aria-pressed`, sharp corners). Keep the existing skills path as-is for "Skills". For "Operators", the search handler calls `marketplaceSearch(q || undefined)` and renders each `MarketplaceListing` with the existing `skillCard`:

```ts
const inst = iconButton(Icons.download({ size: 15 }), "Install", () => {
  inst.disabled = true;
  void (async () => {
    const existing = new Set((await operatorList()).map((o) => o.name.toLowerCase()));
    const raw = suffixSoulName(r.soul_md, existing);
    const created = await operatorCreateFromSoul(raw);
    const org = this.activeOrg();
    if (org && !org.personal) await operatorSetOrg(created.id, org.slug);
    marketplaceInstallCount(r.id).catch(() => {});
    inst.innerHTML = Icons.check({ size: 15 });
  })().catch((e) => { inst.disabled = false; errorEl.hidden = false; errorEl.textContent = this.friendlyError(e); });
});
results.appendChild(skillCard({
  name: r.name,
  meta: `@${r.author_login} · ${r.installs} ${r.installs === 1 ? "install" : "installs"}`,
  description: r.tagline,
  className: "canon-search-result",
  fetchPreview: () => Promise.resolve(r.soul_md),
  actions: [inst],
}));
```
(Confirm `operatorCreateFromSoul` returns the created `Operator` — the api.ts wrapper types say so; if it returns void, re-list and find by name instead.)

Update `SECTION_HEAD.registry` copy to: `"Browse and install skills and operators shared across the organization."`

- [ ] **Step 4: Run** `npm test`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/canon/cockpit/view.ts ui/src/canon/cockpit/view.test.ts ui/src/canon/cockpit/cockpit.css
git commit -m "feat(canon): fold operator marketplace into the cockpit registry (Skills | Operators)"
```

---

### Task 6: Rail panel — Operators census cell + fold

**Files:**
- Modify: `ui/src/canon/panel.ts` (imports :7-11, `refresh` :488-529, `renderStatus` kinds :559-570)
- Test: `ui/src/canon/panel.test.ts`

**Interfaces:**
- Consumes: `operatorList`, `operatorSoulRead` (`../api`); `operatorsForOrg` (`../operator/org-filter`).
- Produces: public field `operators: Operator[]` on `CanonPanel` (tests set it directly); census has 8 cells.

- [ ] **Step 1: Update + add tests** in `panel.test.ts`:
  - Existing census test: expect `cells.length` **8** and add `"Operators"` to the label list.
  - New test:

```ts
it("renders an Operators fold when the panel has operators", () => {
  const host = document.createElement("div");
  const panel = new CanonPanel({ groupId: "g", groupLabel: "G", groupColor: null, groupRootDir: "/repo" });
  panel.mount(host);
  panel.operators = [{ id: "01H", name: "Zeta", tags: ["security"], model: "gpt-4o" } as unknown as Operator]; // test double
  panel.renderStatus({ installed: [], agents: [], contexts: [], memory: [], commands: [], mcp: [], specs: [] });
  const fold = [...host.querySelectorAll(".rail-gname")].find((el) => el.textContent === "Operators");
  expect(fold).toBeTruthy();
  expect(host.textContent).toContain("Zeta");
});
```
Add `operatorList: vi.fn(async () => [])` and `operatorSoulRead: vi.fn(async () => "")` to this file's api mock factory.

- [ ] **Step 2: Run** `npm test -- canon/panel`. Expected: FAIL (7 cells, no field).

- [ ] **Step 3: Implement**

1. Field: `operators: Operator[] = [];` (public — tests assign it).
2. `refresh()`: extend the `Promise.all` with `operatorList().catch(() => [] as Operator[])`; after resolving:
```ts
const known = new Set(orgs.map((o) => o.slug));
this.operators = operatorsForOrg(allOps, this.activeOrg(), known);
```
3. `kinds` list — first entry, before Agents:
```ts
{ label: "Operators", rows: this.operators.map((o) => ({
  title: o.name,
  meta: o.tags.filter(Boolean).slice(0, 3).join(" · ") || o.model,
  onOpen: () => openMarkdownReader(o.name, operatorSoulRead(o.id)),
})) },
```

- [ ] **Step 4: Run** `npm test -- canon/panel` then `npm test`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/canon/panel.ts ui/src/canon/panel.test.ts
git commit -m "feat(canon): Operators census cell + fold in the rail panel"
```

---

### Task 7: "Agents" → "Subagents" rename (labels only)

**Files:**
- Modify: `crates/canon/src/kind.rs:42` (`label()`)
- Modify: `ui/src/canon/cockpit/view.ts` (`SECTIONS` agents entry, `SECTION_HEAD.agents`)
- Modify: `ui/src/canon/panel.ts` (kinds label)
- Tests: `ui/src/canon/panel.test.ts`, `ui/src/canon/cockpit/view.test.ts`, any Rust test asserting `"Agent"`

**Interfaces:** none new — internal enum, serde `lowercase` names, and `.covenant/canon/agents/` dir are all UNCHANGED.

- [ ] **Step 1: Implement**

- `kind.rs`: `Self::Agent => "Subagent",` (run `grep -rn '"Agent"' crates/` to catch label assertions in tests).
- Cockpit: `agents: ["Subagents", "Repo-level subagent files projected into executor context."],` + the `SECTIONS` nav label.
- Rail: `{ label: "Subagents", rows: s.agents.map(...) }` — keep `meta: "agent"` (matches the kind string used by `readSource("agent", ...)`).
- Update the census-label expectation in `panel.test.ts` (`"Agents"` → `"Subagents"`), grep `ui/src` tests for other `"Agents"` assertions.

- [ ] **Step 2: Verify**

Run: `cargo test -p covenant-canon && npm test`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add crates/canon/src/kind.rs ui/src/canon/cockpit/view.ts ui/src/canon/panel.ts ui/src/canon/panel.test.ts ui/src/canon/cockpit/view.test.ts
git commit -m "refactor(canon): relabel Agents kind to Subagents (internal kind/dir unchanged)"
```

---

### Task 8: Settings teardown — section becomes "Autonomous Mode"

**Files:**
- Modify: `ui/src/settings/panel.ts` (:19 import, :200 field, :414 reset, :454 nav, :981-1043 markup, :1677-1682 mount, :1980 keywords)
- Delete: `ui/src/settings/operators.ts`, `ui/src/settings/operator_marketplace.ts`

**Interfaces:**
- Consumes: nothing new. Section id `sec-operators` and tab id `"operators"` are KEPT (achievements mount, tabs.ts, palette all keyed on them) — only visible labels change.

- [ ] **Step 1: Rework the section**

In `panel.ts`:
- Nav (:454): `>Operators<` → `>Autonomous Mode<`.
- Markup (:981+): title → `Autonomous Mode`; desc → `Autonomous Operator Mode budget and the experimental operator mind. Manage the operator roster in the Canon cockpit.`; DELETE the `<div id="operators-pane" ...>` div and the now-redundant `Autonomous Operator Mode (AOM)` subsection heading (its fields move up under the section title). Keep `aom_budget`, Mind v2 fields, and the achievements mount behavior untouched.
- Remove the `OperatorsPane` import (:19), field (:200), reset (:414), and mount block (:1677-1682).
- Search keywords (:1980): `"sec-operators": "autonomous aom budget mind operator achievements"`.

- [ ] **Step 2: Delete the dead modules**

Run: `grep -rn "settings/operators\|OperatorsPane\|LegacyOperatorsPane\|operator_marketplace\|MarketplacePanel" ui/src --include="*.ts" -l` — repoint any remaining importer to `../operator/creator`, then:
```bash
git rm ui/src/settings/operators.ts ui/src/settings/operator_marketplace.ts
```
Keep `ui/src/settings/marketplace_install.ts` (`suffixSoulName` — used by Task 5) and `cloud_sync.ts`'s `"operators"` scope key (backup toggle, unrelated).

- [ ] **Step 3: Verify**

Run: `npm test && npm run build`
Expected: PASS, tsc clean.

- [ ] **Step 4: Commit**

```bash
git add ui/src/settings/panel.ts
git commit -m "feat(settings): retire the Operators section — roster lives in Canon; AOM stays as Autonomous Mode"
```

---

### Task 9: Full gates + live verify

- [ ] **Step 1: Full test + lint gates**

```bash
cargo fmt --all && cargo clippy --workspace --all-targets
cargo test --workspace   # telegram tests may hang under broad runs (known gotcha) — scope with -p if so
npm test && npm run build
```
Expected: clean fmt/clippy, all tests PASS.

- [ ] **Step 2: Live verify (use the `verify` skill / DOM-dump flow — osascript is blocked)**

Checklist: census shows Operators cell; fold lists the roster; cockpit Operators section renders cards + New operator opens the immersive creator; creating inside a non-personal org sets `org_slug`; registry toggle shows marketplace operators and Install works; Settings shows "Autonomous Mode" with AOM fields and NO roster; "Subagents" label in rail + cockpit.

- [ ] **Step 3: Commit any verify fixes** (conventional `fix:` commits), then hand off per `superpowers:finishing-a-development-branch`.
