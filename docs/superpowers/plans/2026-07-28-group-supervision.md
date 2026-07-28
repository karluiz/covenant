# Group Supervision Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator with the new Supervision capability be attached to a tab group — group perception (Phase 1), cross-tab correlation notifications (Phase 2), and opt-in group AOM intervention (Phase 3).

**Architecture:** Approach A from the spec (`docs/superpowers/specs/2026-07-28-group-supervision-design.md`): no backend group registry. The FE tab manifest stays the durable copy; the backend `OperatorRegistry` holds two in-memory maps (`group_supervisors`, `session_groups`) synced from the FE, and the operator resolution chain becomes pin → group supervisor → default. Phase 2 mirrors the existing `CrossSessionWatcher` pattern, scoped to a group. Phase 3 reuses the existing per-pane AOM enable/live commands — no new execution loop.

**Tech Stack:** Rust (Tauri 2, tokio, rusqlite) in `crates/app`; TypeScript strict + Vitest in `ui/src`.

## Global Constraints

- Driver wins: a pane with its own pin is NEVER touched by the supervisor (no perception, no AOM). Observation (Phase 2 context) covers all group sessions.
- Intervene is opt-in per group, default off. `aomExcluded` panes are never claimed. The hard blocklist (`crates/agent`-equivalent in `crates/app/src/safety.rs`) is untouched and always applies.
- `perception_enabled_for` runs on a hot path and must NEVER panic.
- No `unwrap()` outside `#[cfg(test)]`. `thiserror` in libs. IDs are `ulid` newtypes.
- FE: TS `strict`, all Tauri commands wrapped in `ui/src/api.ts`, no emoji in chrome (inline SVG `Icons.*` only), tooltips via `attachTooltip` (never `element.title`), new UI surfaces sharp corners (`border-radius: 0`), English copy.
- Tests: run Vitest from repo ROOT (`npm test`), Rust via `cargo test -p covenant <module>` (broad `cargo test --workspace` can hang on telegram tests).
- Conventional Commits, one feature-coherent commit per task.

---

### Task 1: Operator capability flag `supervision_enabled`

**Files:**
- Modify: `crates/app/src/operator_registry.rs` (struct ~line 70, setter after `set_perception_enabled` ~638, command after `operator_set_perception_enabled` ~1085)
- Modify: `crates/app/src/storage.rs` (migration ~779, INSERT ~1908, UPDATE ~1953, SELECT ~2126, setter after `operator_set_perception_enabled` ~2095)
- Modify: `crates/app/src/lib.rs` (command registration ~5940)
- Test: inline `#[cfg(test)]` in `storage.rs` (mirror the perception round-trip test ~4985)

**Interfaces:**
- Consumes: existing `Operator`, `Storage`, `OperatorRegistry` patterns.
- Produces: `Operator.supervision_enabled: bool`; `OperatorRegistry::set_supervision_enabled(&self, storage, id, enabled) -> Result<(), RegistryError>`; Tauri command `operator_set_supervision_enabled(id: String, enabled: bool)`; `Storage::operator_set_supervision_enabled(id: String, enabled: bool)`.

- [ ] **Step 1: Write the failing storage round-trip test**

In `storage.rs`, next to the perception test (~4985), same arrange pattern (create operator via existing test helpers in that module):

```rust
#[tokio::test]
async fn operator_supervision_enabled_round_trip() {
    // Arrange identical to the perception_enabled test above it:
    // fresh Storage, insert one operator with supervision_enabled: false.
    // (copy that test's setup verbatim, rename the operator)
    assert!(!listed_operator.supervision_enabled); // defaults off
    s.operator_set_supervision_enabled(op_id.to_string(), true)
        .await
        .unwrap();
    assert!(relisted_operator.supervision_enabled);
}
```

Note: adding the struct field first (Step 3) is required for this to compile — write the test, expect compile failure as the "red".

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p covenant operator_supervision_enabled_round_trip`
Expected: FAIL (no field `supervision_enabled`, no method `operator_set_supervision_enabled`)

- [ ] **Step 3: Add the field + migration + SQL mappings**

`operator_registry.rs`, on `Operator` directly after `perception_enabled` (~line 70):

```rust
    /// When true, this operator can be attached to a tab group as its
    /// SUPERVISOR: group perception fallback, cross-tab correlation, and
    /// (opt-in per group) AOM intervention on unpinned panes. Off by
    /// default (deny-biased). Registry-only (NOT SOUL frontmatter).
    #[serde(default)]
    pub supervision_enabled: bool,
```

`storage.rs` migration, after the `perception_enabled` ALTER (~779):

```rust
        // Supervision: operator can be attached to a tab group as its
        // supervisor. Existing operators default off, like perception.
        let _ = conn.execute(
            "ALTER TABLE operators ADD COLUMN supervision_enabled INTEGER NOT NULL DEFAULT 0",
            [],
        );
```

Then, following the `perception_enabled` pattern exactly:
- INSERT (~1908): append `supervision_enabled` to the column list and a `if op.supervision_enabled { 1_i64 } else { 0_i64 }` param.
- UPDATE (~1953): append `supervision_enabled=?N` and the same param.
- SELECT (~2126–2174): append `supervision_enabled` to the column list; map `supervision_enabled: row.get::<_, i64>(19).unwrap_or(0) != 0,` (current last index is 18 = `org_slug`).
- Setter after `operator_set_perception_enabled` (~2095): copy that method, s/perception/supervision/.

`operator_registry.rs`: copy `set_perception_enabled` (~622) → `set_supervision_enabled`; copy the Tauri command `operator_set_perception_enabled` (~1074) → `operator_set_supervision_enabled`.

- [ ] **Step 4: Fix every `Operator` literal**

Struct literals in tests/seeds don't get `#[serde(default)]`. Find and add `supervision_enabled: false,` to each:

Run: `grep -rn "perception_enabled: false" crates/app/src | cut -d: -f1 | sort -u`

Add the field right after `perception_enabled` in every literal (operator_registry.rs seeds ~286/472/755/981/1017, storage.rs tests, lib.rs, any others the grep finds).

- [ ] **Step 5: Register the command**

`lib.rs` ~5940, next to `operator_set_perception_enabled`:

```rust
            operator_registry::commands::operator_set_supervision_enabled,
```

- [ ] **Step 6: Run tests to verify green**

Run: `cargo test -p covenant operator_supervision && cargo test -p covenant operator_registry`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add crates/app/src/operator_registry.rs crates/app/src/storage.rs crates/app/src/lib.rs
git commit -m "feat(operator): supervision_enabled capability flag"
```

---

### Task 2: Registry group maps + resolution fallback (backend core of Phase 1)

**Files:**
- Modify: `crates/app/src/operator_registry.rs` (struct ~173, `load` ~203, pins block ~659, `effective_for` ~674, `perception_enabled_for` ~693, commands mod end ~1130, new test mod after `perception_activation_tests` ~1256)
- Modify: `crates/app/src/lib.rs` (command registration ~5948)

**Interfaces:**
- Consumes: Task 1's `Operator.supervision_enabled`.
- Produces:
  - `pub struct GroupSupervision { pub operator: OperatorId, pub intervene: bool }` (derive `Debug, Clone, Copy, PartialEq, Eq`)
  - `OperatorRegistry::set_group_supervisor(&self, group_id: String, sup: Option<GroupSupervision>)`
  - `OperatorRegistry::group_supervision(&self, group_id: &str) -> Option<GroupSupervision>`
  - `OperatorRegistry::set_session_group(&self, session_id: SessionId, group_id: Option<String>)`
  - `OperatorRegistry::session_group(&self, session_id: SessionId) -> Option<String>`
  - `OperatorRegistry::group_sessions(&self, group_id: &str) -> Vec<SessionId>`
  - `OperatorRegistry::supervisor_for(&self, session_id: SessionId) -> Option<Operator>`
  - Tauri commands `group_set_supervisor(group_id, operator_id: Option<String>, intervene: bool)`, `session_set_group(session_id: String, group_id: Option<String>)`

- [ ] **Step 1: Write the failing fallback tests**

New mod after `perception_activation_tests` (~1256), reusing `OperatorRegistry::for_tests("Default")`:

```rust
#[cfg(test)]
mod supervision_tests {
    use super::*;
    use ulid::Ulid;

    fn add_supervisor(reg: &OperatorRegistry, name: &str, supervision: bool) -> OperatorId {
        let mut op = reg.default().expect("default operator");
        op.id = OperatorId(Ulid::new());
        op.name = name.into();
        op.is_default = false;
        op.supervision_enabled = supervision;
        op.perception_enabled = true;
        let oid = op.id;
        reg.by_id.write().unwrap().insert(oid, op);
        oid
    }

    #[test]
    fn effective_for_falls_back_to_group_supervisor() {
        let reg = OperatorRegistry::for_tests("Default");
        let sid = SessionId::new();
        let sup = add_supervisor(&reg, "Warden", true);

        // No group membership → default.
        assert!(reg.effective_for(sid).is_default);

        reg.set_session_group(sid, Some("g1".into()));
        reg.set_group_supervisor("g1".into(), Some(GroupSupervision { operator: sup, intervene: false }));
        assert_eq!(reg.effective_for(sid).id, sup);

        // Pin wins over supervisor.
        let driver = add_supervisor(&reg, "Driver", false);
        reg.pin_session(sid, driver);
        assert_eq!(reg.effective_for(sid).id, driver);
    }

    #[test]
    fn supervisor_without_capability_is_ignored() {
        let reg = OperatorRegistry::for_tests("Default");
        let sid = SessionId::new();
        let sup = add_supervisor(&reg, "NoCap", false);
        reg.set_session_group(sid, Some("g1".into()));
        reg.set_group_supervisor("g1".into(), Some(GroupSupervision { operator: sup, intervene: false }));
        assert!(reg.effective_for(sid).is_default);
        assert!(reg.supervisor_for(sid).is_none());
    }

    #[test]
    fn perception_enabled_for_uses_supervisor_and_never_panics() {
        let reg = OperatorRegistry::for_tests("Default");
        let sid = SessionId::new();
        let sup = add_supervisor(&reg, "Seer", true); // perception_enabled: true
        reg.set_session_group(sid, Some("g1".into()));
        reg.set_group_supervisor("g1".into(), Some(GroupSupervision { operator: sup, intervene: false }));
        assert!(reg.perception_enabled_for(sid));

        // Supervisor pointing at a deleted operator → falls to default, no panic.
        reg.by_id.write().unwrap().remove(&sup);
        assert!(!reg.perception_enabled_for(sid));
    }

    #[test]
    fn membership_maps_round_trip() {
        let reg = OperatorRegistry::for_tests("Default");
        let (a, b) = (SessionId::new(), SessionId::new());
        reg.set_session_group(a, Some("g1".into()));
        reg.set_session_group(b, Some("g1".into()));
        assert_eq!(reg.session_group(a).as_deref(), Some("g1"));
        let mut members = reg.group_sessions("g1");
        members.sort_by_key(|s| s.0);
        assert_eq!(members.len(), 2);

        reg.set_session_group(b, None);
        assert_eq!(reg.group_sessions("g1").len(), 1);
        reg.set_group_supervisor("g1".into(), None);
        assert!(reg.group_supervision("g1").is_none());
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p covenant supervision_tests`
Expected: FAIL (no `GroupSupervision`, no methods)

- [ ] **Step 3: Implement maps + methods + fallback**

Struct fields (~173–177) and `load` (~203) plus the bare literal in `perception_enabled_for_never_panics_without_a_default` (~1243) gain:

```rust
    group_supervisors: RwLock<HashMap<String, GroupSupervision>>,
    session_groups: RwLock<HashMap<SessionId, String>>,
```

(initialize both with `RwLock::new(HashMap::new())` in `load` and in the test literal).

After the pins block (~669):

```rust
/// A group's attached supervisor. FE-synced, in-memory only — the tab
/// manifest is the durable copy, mirroring `pins`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GroupSupervision {
    pub operator: OperatorId,
    pub intervene: bool,
}
```

```rust
    pub fn set_group_supervisor(&self, group_id: String, sup: Option<GroupSupervision>) {
        let mut g = self.group_supervisors.write().unwrap();
        match sup {
            Some(s) => {
                g.insert(group_id, s);
            }
            None => {
                g.remove(&group_id);
            }
        }
    }

    pub fn group_supervision(&self, group_id: &str) -> Option<GroupSupervision> {
        self.group_supervisors.read().unwrap().get(group_id).copied()
    }

    pub fn set_session_group(&self, session_id: SessionId, group_id: Option<String>) {
        let mut m = self.session_groups.write().unwrap();
        match group_id {
            Some(g) => {
                m.insert(session_id, g);
            }
            None => {
                m.remove(&session_id);
            }
        }
    }

    pub fn session_group(&self, session_id: SessionId) -> Option<String> {
        self.session_groups.read().unwrap().get(&session_id).cloned()
    }

    pub fn group_sessions(&self, group_id: &str) -> Vec<SessionId> {
        self.session_groups
            .read()
            .unwrap()
            .iter()
            .filter(|(_, g)| g.as_str() == group_id)
            .map(|(s, _)| *s)
            .collect()
    }

    /// The operator supervising this session via its group, if any.
    /// Gated on the operator still existing AND having the Supervision
    /// capability — a stale attach never resolves.
    pub fn supervisor_for(&self, session_id: SessionId) -> Option<Operator> {
        let gid = self.session_group(session_id)?;
        let sup = self.group_supervision(&gid)?;
        let op = self.get(sup.operator)?;
        if op.supervision_enabled {
            Some(op)
        } else {
            None
        }
    }
```

`effective_for` (~674): insert between pin and default:

```rust
        if let Some(op) = self.supervisor_for(session_id) {
            return op;
        }
```

`perception_enabled_for` (~693) becomes:

```rust
        self.pinned(session_id)
            .and_then(|oid| self.get(oid))
            .or_else(|| self.supervisor_for(session_id))
            .or_else(|| self.default())
            .map(|op| op.perception_enabled)
            .unwrap_or(false)
```

Update both doc comments to name the new chain: pin → group supervisor → default.

- [ ] **Step 4: Add the Tauri commands**

In `commands` mod after `session_get_operator` (~1130):

```rust
    #[tauri::command]
    pub async fn group_set_supervisor(
        group_id: String,
        operator_id: Option<String>,
        intervene: bool,
        registry: State<'_, Arc<OperatorRegistry>>,
    ) -> Result<(), String> {
        match operator_id {
            Some(s) => {
                let oid: OperatorId = s.parse().map_err(map_err)?;
                registry.set_group_supervisor(
                    group_id,
                    Some(GroupSupervision { operator: oid, intervene }),
                );
            }
            None => registry.set_group_supervisor(group_id, None),
        }
        Ok(())
    }

    #[tauri::command]
    pub async fn session_set_group(
        session_id: String,
        group_id: Option<String>,
        registry: State<'_, Arc<OperatorRegistry>>,
    ) -> Result<(), String> {
        let sid: SessionId = session_id.parse().map_err(map_err)?;
        registry.set_session_group(sid, group_id);
        Ok(())
    }
```

Register both in `lib.rs` (~5948, next to `session_set_operator`).

- [ ] **Step 5: Run tests to verify green**

Run: `cargo test -p covenant supervision_tests && cargo test -p covenant perception_activation_tests`
Expected: PASS (including the pre-existing perception tests — the fallback must not break them)

- [ ] **Step 6: Commit**

```bash
git add crates/app/src/operator_registry.rs crates/app/src/lib.rs
git commit -m "feat(operator): group supervisor maps + pin>supervisor>default resolution"
```

---

### Task 3: FE api wrappers + manifest persistence

**Files:**
- Modify: `ui/src/api.ts` (Operator interface ~358, wrappers near ~468 and ~2483)
- Modify: `ui/src/tabs/manager.ts` (`TabGroup` ~376, `SerializedGroup` ~559, serialize ~6149, restore ~6185, group creation ~7085 and `createEmptyGroup` ~7413)
- Test: `ui/src/tabs/manager.test.ts` (or the file where manifest round-trip tests live — find with `grep -rln "SerializedGroup\|serializeManifest" ui/src/*.test.ts ui/src/**/*.test.ts`)

**Interfaces:**
- Consumes: Task 2's commands.
- Produces:
  - `api.ts`: `Operator.supervision_enabled: boolean`; `operatorSetSupervisionEnabled(id: string, enabled: boolean): Promise<void>`; `groupSetSupervisor(groupId: string, operatorId: string | null, intervene: boolean): Promise<void>`; `sessionSetGroup(sessionId: string, groupId: string | null): Promise<void>`
  - `manager.ts`: `TabGroup.supervisorId: string | null`, `TabGroup.supervisorIntervene: boolean`; `SerializedGroup.supervisor_id?: string | null`, `SerializedGroup.supervisor_intervene?: boolean`

- [ ] **Step 1: Write the failing manifest round-trip test**

In the manifest test file located above, following its existing group round-trip pattern:

```ts
it("round-trips group supervisor fields through the manifest", () => {
  // arrange: manager with one group, supervisorId "op-1", supervisorIntervene true
  // (copy the file's existing group serialize/restore test setup)
  const manifest = mgr.serializeManifest();
  expect(manifest.groups[0].supervisor_id).toBe("op-1");
  expect(manifest.groups[0].supervisor_intervene).toBe(true);
  const restored = freshManager();
  restored.restoreFromManifest(manifest);
  const g = [...restored.groupsForTest()][0]; // use whatever accessor the file already uses
  expect(g.supervisorId).toBe("op-1");
  expect(g.supervisorIntervene).toBe(true);
});

it("defaults supervisor fields for older manifests", () => {
  // restore a manifest whose groups lack the new fields
  expect(g.supervisorId).toBeNull();
  expect(g.supervisorIntervene).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- manager` (from repo root)
Expected: FAIL (fields don't exist)

- [ ] **Step 3: Implement types + persistence**

`TabGroup` (~388, after `canonOrg`):

```ts
  /// Operator attached as this group's SUPERVISOR (null = none). The
  /// backend registry mirror is synced via groupSetSupervisor; this is
  /// the durable copy.
  supervisorId: string | null;
  /// Phase 3 gate: when true the supervisor may claim unpinned,
  /// non-excluded panes for AOM. Default false (observe-only).
  supervisorIntervene: boolean;
```

`SerializedGroup` (~572): `supervisor_id?: string | null;` and `supervisor_intervene?: boolean;` (optional for backward compat).

Serialize (~6149): `supervisor_id: g.supervisorId, supervisor_intervene: g.supervisorIntervene,`
Restore (~6185): `supervisorId: g.supervisor_id ?? null, supervisorIntervene: g.supervisor_intervene ?? false,`
Group creation sites (~7085, `createEmptyGroup` ~7413, and any other `this.groups.set(` literal — grep `groups.set(`): add `supervisorId: null, supervisorIntervene: false,`.

`api.ts`: add `supervision_enabled: boolean;` to the `Operator` interface (~358); wrappers:

```ts
export async function operatorSetSupervisionEnabled(id: string, enabled: boolean): Promise<void> {
  return invoke<void>("operator_set_supervision_enabled", { id, enabled });
}

export async function groupSetSupervisor(
  groupId: string,
  operatorId: string | null,
  intervene: boolean,
): Promise<void> {
  return invoke<void>("group_set_supervisor", { groupId, operatorId, intervene });
}

export async function sessionSetGroup(sessionId: string, groupId: string | null): Promise<void> {
  return invoke<void>("session_set_group", { sessionId, groupId });
}
```

Fix any FE test fixtures constructing `Operator` objects (grep `perception_enabled: false` in `ui/src` — e.g. `ui/src/operator/creator.test.ts:162,187,205,222,243`) by adding `supervision_enabled: false`.

- [ ] **Step 4: Run tests + typecheck to verify green**

Run: `npm test -- manager && npm run build`
Expected: PASS, no TS errors

- [ ] **Step 5: Commit**

```bash
git add ui/src/api.ts ui/src/tabs/manager.ts ui/src/tabs/manager.test.ts ui/src/operator/creator.test.ts
git commit -m "feat(ui): group supervisor manifest fields + api wrappers"
```

---

### Task 4: FE membership + supervisor sync (completes Phase 1)

**Files:**
- Modify: `ui/src/tabs/manager.ts` (groupId mutation sites 7129, 7289, 7313, 7374, 7443; close teardown ~6574; boot restore ~6185 region; pane sessionId assignment sites — find with `grep -n "\.sessionId = " ui/src/tabs/manager.ts`)
- Test: same manifest test file as Task 3, with `vi.mock` on the api module

**Interfaces:**
- Consumes: Task 3's `sessionSetGroup`, `groupSetSupervisor`.
- Produces: `TabManager.syncSessionGroup(tab: Tab): void` (private helper; called from every membership mutation). Backend maps stay consistent with FE state from boot onward.

- [ ] **Step 1: Write the failing sync test**

```ts
it("pushes membership to the backend when a tab joins/leaves a group", () => {
  const spy = vi.spyOn(api, "sessionSetGroup").mockResolvedValue();
  // arrange: tab with one pane whose sessionId is "s1"
  mgr.addTabToGroupForTest(tab.id, "g1"); // whichever public path the file's tests use to group a tab
  expect(spy).toHaveBeenCalledWith("s1", "g1");
  mgr.ungroupForTest("g1");
  expect(spy).toHaveBeenCalledWith("s1", null);
});
```

Adapt arrange/act to the test file's existing helpers — the assertion pairs are the contract.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- manager`
Expected: FAIL (no sync calls happen)

- [ ] **Step 3: Implement the sync helper + call sites**

```ts
  /// Push a tab's group membership to the backend operator registry —
  /// one call per pane with a live session. Fire-and-forget: the map is
  /// in-memory backend-side; the manifest is the durable copy.
  private syncSessionGroup(tab: Tab): void {
    for (const p of tab.panes) {
      if (p.sessionId) void api.sessionSetGroup(p.sessionId, tab.groupId);
    }
  }
```

Call it immediately after every `tab.groupId` assignment (7129, 7289, 7313, inside the 7374 loop, 7443). In the close teardown (~6574, where the pane unpin already happens): `if (pane.sessionId) void api.sessionSetGroup(pane.sessionId, null);`.

Sessions spawn after tabs exist, so also call `sessionSetGroup` where `pane.sessionId` is assigned (each `.sessionId = ` site with a non-null value, when the tab has a `groupId`).

Boot resync: after `restoreFromManifest` finishes rebuilding groups (~6185 region), for each group with `supervisorId !== null` call `void api.groupSetSupervisor(g.id, g.supervisorId, g.supervisorIntervene);` — membership syncs organically as sessions respawn through the sites above.

Group destroy/ungroup already funnel through the 7313/7374 sites; verify `destroyGroup` (~7385) also clears membership (its tab-close path hits the ~6574 teardown) and add `void api.groupSetSupervisor(groupId, null, false)` in both `ungroup` (~7372) and `destroyGroup`.

- [ ] **Step 4: Run tests to verify green**

Run: `npm test -- manager && npm run build`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add ui/src/tabs/manager.ts ui/src/tabs/manager.test.ts
git commit -m "feat(ui): sync group membership + supervisor attach to backend registry"
```

At this point Phase 1 is functionally complete end-to-end EXCEPT the attach UI (Task 5): a group with a supervisor set in the manifest gets group perception on unpinned tabs via the two untouched perception lanes.

---

### Task 5: Supervisor UI — capability toggle, attach menu, group chip

**Files:**
- Modify: `ui/src/operator/creator.ts` (state ~119/215/268/362, Behaviour section ~1102–1125, save ~1468–1475)
- Modify: `ui/src/tabs/manager.ts` (`openGroupContextMenu` ~8372, group chip render ~7721 region)
- Modify: `ui/src/main.ts` (wire an operator-list provider onto the manager, near the existing `listOperators: operatorList` wiring ~862)
- Test: `ui/src/operator/creator.test.ts` (extend existing fixtures)

**Interfaces:**
- Consumes: Task 3's `operatorSetSupervisionEnabled`, `groupSetSupervisor`; `api.operatorList()`.
- Produces: `TabManager.listOperators: (() => Promise<import("../api").Operator[]>) | null` public field (set from `main.ts`); attach/detach/intervene handled inside `openGroupContextMenu`; `TabManager.setGroupSupervisor(groupId: string, operatorId: string | null): void` and `TabManager.setGroupIntervene(groupId: string, intervene: boolean): void` (public so Task 7 can hook them).

- [ ] **Step 1: Operator editor — Supervision toggle**

Mirror the Perception field exactly (creator.ts ~1102–1125): state field `supervisionEnabled: boolean` (init from `opts.existing?.supervision_enabled ?? false` ~215, setter ~268, dirty-check ~362), a second `op-soul-seg` + `op-modal-field` labeled `Supervision` with hint `Can be attached to a tab group as supervisor`, and the save-side call (~1468 pattern):

```ts
    const prevSupervision = handle.state.existing?.supervision_enabled ?? false;
    if (saved.id && handle.state.supervisionEnabled !== prevSupervision) {
      try { await operatorSetSupervisionEnabled(saved.id, handle.state.supervisionEnabled); } catch (e) {
        console.warn("operator_set_supervision_enabled failed", e);
      }
    }
```

- [ ] **Step 2: Manager — supervisor mutators**

```ts
  setGroupSupervisor(groupId: string, operatorId: string | null): void {
    const g = this.groups.get(groupId);
    if (!g) return;
    g.supervisorId = operatorId;
    if (!operatorId) g.supervisorIntervene = false;
    void api.groupSetSupervisor(groupId, operatorId, g.supervisorIntervene);
    this.persist();  // use the same persistence call neighboring group mutators use (see setGroupCanonOrg ~2105)
    this.render();   // same render/refresh call those mutators use
  }

  setGroupIntervene(groupId: string, intervene: boolean): void {
    const g = this.groups.get(groupId);
    if (!g || !g.supervisorId) return;
    g.supervisorIntervene = intervene;
    void api.groupSetSupervisor(groupId, g.supervisorId, intervene);
    this.persist();
  }
```

(Match the exact persist/render method names used by `setGroupColor` ~6970 / `setGroupCanonOrg` ~2105.)

- [ ] **Step 3: Group context menu**

Make `openGroupContextMenu` async (call site 7804 becomes `void this.openGroupContextMenu(...)`). Before `menu.show`, fetch eligible operators:

```ts
    const ops = (await this.listOperators?.().catch(() => [])) ?? [];
    const eligible = ops.filter((o) => o.supervision_enabled);
    const supervisor = group.supervisorId
      ? ops.find((o) => o.id === group.supervisorId) ?? null
      : null;
```

Menu items (insert after "Open notes", before "Rename group"), following the file's existing item shape:

```ts
      {
        label: supervisor ? `Supervisor: ${supervisor.name}` : "Attach supervisor…",
        icon: Icons.eye(),  // reuse an existing Icons glyph; add eye() only if none fits — never emoji
        submenu: [
          ...(eligible.length === 0
            ? [{ label: "(no operators with Supervision)", disabled: true }]
            : eligible.map((o) => ({
                label: o.name,
                onClick: () => this.setGroupSupervisor(group.id, o.id),
              }))),
          ...(supervisor
            ? [
                { divider: true as const },
                {
                  label: group.supervisorIntervene ? "Intervene: on" : "Intervene: off",
                  onClick: () => this.setGroupIntervene(group.id, !group.supervisorIntervene),
                },
                { label: "Detach supervisor", onClick: () => this.setGroupSupervisor(group.id, null) },
              ]
            : []),
        ],
      },
```

`main.ts`: `tabManager.listOperators = operatorList;` next to the existing operator wiring (~862).

- [ ] **Step 4: Group chip indicator**

At the group chip render (~7721, where `chip.dataset.groupId` is set): when `group.supervisorId` is set, append a small inline-SVG glyph element to the chip (same glyph as the menu), with `attachTooltip(el, "Supervised" + (name ? " by " + name : ""))`. Sharp corners, no new colors — follow the chip's existing token usage. Stale-attach cleanup: while building the context menu, if `group.supervisorId` no longer matches any listed operator or the operator lost the capability, call `this.setGroupSupervisor(group.id, null)` before rendering items.

- [ ] **Step 5: Extend creator tests + run**

Add `supervision_enabled: false` fixtures already done in Task 3; add one test mirroring the file's perception-toggle test (if present) for the new toggle. Run: `npm test && npm run build`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add ui/src/operator/creator.ts ui/src/operator/creator.test.ts ui/src/tabs/manager.ts ui/src/main.ts
git commit -m "feat(ui): supervisor attach UI — capability toggle, group menu, chip"
```

UI/CSS work: run the `design-rules-auditor` agent on the diff before merging (DESIGN.md hard rules).

---

### Task 6: Phase 2 — GroupSupervisor correlation runtime

**Files:**
- Create: `crates/app/src/group_supervision.rs`
- Modify: `crates/app/src/cross_session.rs` (make `SimpleRate` and the shared prompt-context helper `pub(crate)` if private)
- Modify: `crates/app/src/lib.rs` (module decl ~32, AppState field ~243, attach ~944, spawn ~5085 region)
- Modify: `ui/src/notifications/toast.ts` (~103, second listener)
- Test: inline `#[cfg(test)]` in `group_supervision.rs`

**Interfaces:**
- Consumes: Task 2's `session_group` / `group_supervision` / `supervisor_for`; `SessionWorldModel`; `CrossSessionWatcher`'s architecture (copy, don't abstract).
- Produces: `GroupSupervisionWatcher::spawn(app, settings, registry: Arc<OperatorRegistry>, vitals) -> Self`, `GroupSupervisionWatcher::attach(session_id, world, bus)`; Tauri event `"group-supervision-finding"` with payload `GroupSupervisionFinding { group_id: String, operator_id: String, operator_name: String, message: String, timestamp_unix_ms: u64 }`.

- [ ] **Step 1: Write the failing gating test**

The trigger-gating logic must be a pure function so it's testable without the LLM:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::operator_registry::{GroupSupervision, OperatorRegistry};

    #[test]
    fn supervised_group_for_gates_on_membership_and_capability() {
        let reg = OperatorRegistry::for_tests("Default");
        let sid = karl_session::SessionId::new();
        // ungrouped session → None
        assert!(supervised_group_for(&reg, sid).is_none());
        // grouped but unsupervised → None
        reg.set_session_group(sid, Some("g1".into()));
        assert!(supervised_group_for(&reg, sid).is_none());
        // supervised (operator with supervision_enabled, per Task 2 helper) → Some
        // (create the supervisor exactly as supervision_tests::add_supervisor does)
        assert!(supervised_group_for(&reg, sid).is_some());
    }
}
```

Run: `cargo test -p covenant group_supervision` — Expected: FAIL (module doesn't exist)

- [ ] **Step 2: Implement the watcher**

Copy `cross_session.rs` wholesale into `group_supervision.rs` and adapt — deliberate duplication over premature abstraction; the two watchers will diverge:

- Constants: `DEBOUNCE` 1500ms, `MAX_CHECKS_PER_MINUTE: 6` (reuse `SimpleRate` from cross_session — make it `pub(crate)` there), `FINDING_EVENT_NAME: &str = "group-supervision-finding"`.
- `spawn(...)` additionally takes `registry: Arc<OperatorRegistry>`.
- The pure gate:

```rust
/// The (group_id, supervisor) this failure belongs to, or None when the
/// session is ungrouped / the group unsupervised / the operator lost the
/// capability. Pure — unit-testable without the watcher.
pub(crate) fn supervised_group_for(
    registry: &OperatorRegistry,
    session_id: SessionId,
) -> Option<(String, crate::operator_registry::Operator)> {
    let gid = registry.session_group(session_id)?;
    let op = registry.supervisor_for(session_id)?;
    Some((gid, op))
}
```

- In the `watch_loop` failure arm: only set `last_failure_at` when `supervised_group_for(...)` is `Some`, carrying `(Instant, SessionId, String /* group_id */)`.
- In `check_for_pattern`: snapshot only worlds whose session is in `registry.group_sessions(&group_id)`; skip when fewer than 2 group sessions (single-session findings are the M4 fix-proposer's job — same rule as cross_session). System prompt = the cross_session prompt with a prefix block naming scope and identity:

```
You are "{operator_name}", the supervisor attached to ONE tab group.
{persona}
Only the sessions listed below (all members of this group) are in scope.
```

plus `voice_directive(op.voice)` appended, and the same strict `FINDING:` output contract.
- On a finding, emit `GroupSupervisionFinding` (fields per Interfaces above) via `app.emit(FINDING_EVENT_NAME, &finding)`.
- Award nothing, write nothing to any PTY — notify-only.

`lib.rs`: `mod group_supervision;` (~32); field `group_supervision: group_supervision::GroupSupervisionWatcher` on AppState (~243); spawn next to `CrossSessionWatcher::spawn` (~5085) passing the registry Arc; attach next to `cross_session.attach` (~944) with the same `(id, world.clone(), session.subscribe())`.

- [ ] **Step 3: FE toast listener**

`ui/src/notifications/toast.ts` (~103): add a second `listen` for `"group-supervision-finding"` rendering the same toast chrome, message prefixed by the supervisor's name (payload field — no lookup needed).

- [ ] **Step 4: Run tests to verify green**

Run: `cargo test -p covenant group_supervision && npm run build`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/group_supervision.rs crates/app/src/cross_session.rs crates/app/src/lib.rs ui/src/notifications/toast.ts
git commit -m "feat(agent): group supervisor correlation watcher + attributed findings"
```

---

### Task 7: Phase 3 — Intervene application

**Files:**
- Modify: `ui/src/tabs/pane.ts` (~60, add runtime flag)
- Modify: `ui/src/tabs/manager.ts` (`setGroupIntervene` from Task 5, `setTabOperator` ~5563, membership mutation sites from Task 4)
- Test: `ui/src/tabs/manager.test.ts` (pure helper test)

**Interfaces:**
- Consumes: Task 5's `setGroupIntervene`; existing `api.setOperatorEnabled` (api.ts:202) and the `set_operator_live` wrapper (api.ts:239); Task 4's mutation-site hooks.
- Produces: `Pane.supervisorAom?: boolean` (runtime-only, never serialized); exported pure helper `panesForIntervene(tabs: Tab[], groupId: string): Pane[]`; `TabManager.applyGroupIntervene(groupId)` / `unapplyGroupIntervene(groupId)` (private).

- [ ] **Step 1: Write the failing helper test**

```ts
import { panesForIntervene } from "./manager";

it("selects only unpinned, non-excluded, live panes of the group", () => {
  const tabs = [
    tabWith({ groupId: "g1", panes: [pane({ sessionId: "s1" })] }),                       // eligible
    tabWith({ groupId: "g1", panes: [pane({ sessionId: "s2", operator: "op-9" })] }),     // pinned → out
    tabWith({ groupId: "g1", panes: [pane({ sessionId: "s3", aomExcluded: true })] }),    // excluded → out
    tabWith({ groupId: "g1", panes: [pane({ sessionId: null })] }),                       // no session → out
    tabWith({ groupId: "g2", panes: [pane({ sessionId: "s5" })] }),                       // other group → out
  ];
  expect(panesForIntervene(tabs, "g1").map((p) => p.sessionId)).toEqual(["s1"]);
});
```

(Build `tabWith`/`pane` from the test file's existing fixture helpers.)

Run: `npm test -- manager` — Expected: FAIL (helper doesn't exist)

- [ ] **Step 2: Implement**

`pane.ts` (~60, after `perceptionOperator`):

```ts
  /// True when the GROUP SUPERVISOR's Intervene toggle enabled AOM on
  /// this pane — so un-toggling reverts exactly these panes and never a
  /// user's own manual enablement. Runtime only, never persisted.
  supervisorAom?: boolean;
```

`manager.ts` — the exported pure helper:

```ts
/// Panes the group supervisor may claim under Intervene: no own pin
/// (driver wins), not AOM-excluded, live session. Exported for tests.
export function panesForIntervene(tabs: Tab[], groupId: string): Pane[] {
  return tabs
    .filter((t) => t.groupId === groupId)
    .flatMap((t) => t.panes)
    .filter((p) => !p.operator && !p.aomExcluded && !!p.sessionId);
}
```

Private appliers (api wrapper names per api.ts:202/239):

```ts
  private applyGroupIntervene(groupId: string): void {
    for (const p of panesForIntervene(this.tabs, groupId)) {
      if (p.supervisorAom) continue;
      p.supervisorAom = true;
      p.operatorEnabled = true;
      p.operatorLive = true;
      void api.setOperatorEnabled(p.sessionId!, true);
      void api.setOperatorLive(p.sessionId!, true);
    }
  }

  private unapplyGroupIntervene(groupId: string): void {
    for (const t of this.tabs.filter((t) => t.groupId === groupId))
      for (const p of t.panes) {
        if (!p.supervisorAom) continue;
        p.supervisorAom = false;
        p.operatorEnabled = false;
        p.operatorLive = false;
        if (p.sessionId) {
          void api.setOperatorEnabled(p.sessionId, false);
          void api.setOperatorLive(p.sessionId, false);
        }
      }
  }
```

Hook sites:
- `setGroupIntervene` (Task 5): after syncing, `intervene ? this.applyGroupIntervene(groupId) : this.unapplyGroupIntervene(groupId)`.
- `setGroupSupervisor(…, null)` (detach) and `ungroup`/`destroyGroup`: `unapplyGroupIntervene(groupId)` first.
- Task 4's membership sites: after `syncSessionGroup(tab)`, if the tab's NEW group has an intervening supervisor → `applyGroupIntervene(newGroupId)`; if it LEFT such a group → revert that tab's `supervisorAom` panes (same loop body as `unapplyGroupIntervene` scoped to the one tab — extract a `revertSupervisorAom(tab: Tab)` private used by both).
- `setTabOperator` (~5563): on PIN — if the target pane has `supervisorAom`, revert it via `revertSupervisorAom` semantics for that pane (driver takes over clean). On UNPIN — if the tab's group has an intervening supervisor, `applyGroupIntervene(tab.groupId)`.

If the tab-render code shows an AOM/live indicator per pane, it needs no change — the flags are the same ones it already reads.

- [ ] **Step 3: Run tests to verify green**

Run: `npm test -- manager && npm run build`
Expected: PASS

- [ ] **Step 4: Full suite + clippy**

Run: `npm test && cargo test -p covenant supervision && cargo clippy --workspace --all-targets && cargo fmt --all -- --check`
Expected: PASS (telegram-adjacent broad test runs are known to hang — stick to targeted filters)

- [ ] **Step 5: Commit**

```bash
git add ui/src/tabs/pane.ts ui/src/tabs/manager.ts ui/src/tabs/manager.test.ts
git commit -m "feat(ui): group intervene — supervisor claims unpinned panes via existing AOM"
```

---

## Post-plan notes

- **Safety review:** Task 7 widens what an operator may run unattended (supervisor AOM over unpinned panes). Before merge, run the `safety-blocklist-reviewer` agent over the branch diff — the spec's gates (pin wins, aomExcluded, opt-in intervene, blocklist untouched) are the review contract.
- **Deliberately NOT changed:** `enable_all_for_aom` (operator.rs:1420) still skips unpinned sessions — global AOM does not auto-claim supervisor-covered tabs; only the group's explicit Intervene toggle does.
- **Manual smoke (after Task 5):** create a group with 2 tabs, attach a supervision-enabled operator with Perception on, run `claude` in an unpinned tab, verify the punteado chip attributes the auto-answer to the supervisor; pin a different operator to one tab and verify the supervisor stops covering it.
