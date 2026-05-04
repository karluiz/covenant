# AOM Per-Tab Exclusion Visibility — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing M-OP5 per-tab AOM exclusion feature discoverable, visible, and persistent — so the user can keep specific tabs manual while AOM drives the rest.

**Architecture:** Backend already supports `aom_excluded` per tab. We (1) drop the per-`aom_start` reset, (2) make AOM auto-enable skip excluded tabs, (3) reintroduce a per-tab `bot` icon (slashed when excluded), (4) wire `⌘⇧E` + click to toggle, (5) persist via the tab manifest, (6) surface "N excluded" on the AOM status-bar chip with a popover for per-tab + bulk Include actions.

**Tech Stack:** Rust + Tokio (`crates/app`), TypeScript + xterm.js (`ui/src`), Lucide-sourced inline SVG icons, no test runner for UI (manual verification per CLAUDE.md).

**Spec:** `docs/superpowers/specs/2026-05-04-aom-exclusion-visibility-design.md`

---

## File-by-file impact

| File | Change |
|---|---|
| `crates/app/src/lib.rs` | Drop `clear_all_aom_excluded` from `aom_start` handler. |
| `crates/app/src/operator.rs` | Add exclusion guard to `enable_all_for_aom`. Update doc comments on `clear_all_aom_excluded` (kept for explicit user action). |
| `ui/src/icons/index.ts` | Add `botOff` icon. |
| `ui/src/tabs/manager.ts` | Render `bot` / `bot-off` icon on tab pill. Click handler. Manifest serialize + restore. Push exclusion data to StatusBar. Update obsolete comment at :2373-2378. |
| `ui/src/main.ts` | `⌘⇧E` keypress handler. |
| `ui/src/shortcuts/registry.ts` | Add `⌘⇧E` row under "AOM". |
| `ui/src/status/bar.ts` | New setters for excluded list + count. Render "(N excluded)" segment. Popover lists excluded tabs with per-tab Include + Include all. |
| `ui/src/styles.css` | Tab-pill bot icon hover/disabled states; status segment for excluded count. |

---

## Task 1: Drop reset of `aom_excluded` on `aom_start`

**Files:**
- Modify: `crates/app/src/lib.rs` (currently around line 882-885 — line numbers advisory; locate by content)

The current `aom_start` handler resets every tab's exclusion to `false` and has a comment block justifying that reset. Per the design (Q3 → A), exclusion now persists across AOM cycles. We remove BOTH the call and the obsolete comment, and replace them with a comment that documents the new behavior. The function `clear_all_aom_excluded` itself stays alive — Task 11 reuses it as the "Include all" explicit action.

- [ ] **Step 1: Read the current `aom_start` handler**

Run: `grep -n -A 30 "async fn aom_start" /Users/carlosgallardoarenas/Sources/karlTerminal/crates/app/src/lib.rs`

You will see (within the function):

```rust
    // Fresh AOM session = fresh per-tab exclusions. Saves the user
    // from the "I don't remember which tabs I excluded last time"
    // foot-gun on a new sleep period.
    state.operator.clear_all_aom_excluded().await;
```

- [ ] **Step 2: Replace those four lines with the new behavior comment**

Find that exact 4-line block (3 comment lines + 1 call line) inside `aom_start`. Replace with:

```rust
    // M-OP5+: per-tab `aom_excluded` is persistent across AOM cycles.
    // The user opts tabs IN/OUT explicitly via the tab badge, ⌘⇧E, the
    // tab context menu, or the "Include all" action in the AOM popover.
    // We deliberately do NOT reset here — the previous reset surprised
    // users who marked a tab manual and lost it the next time AOM ran.
```

- [ ] **Step 3: Verify the project still builds**

Run: `cargo check -p covenant`
Expected: PASS (no errors).

- [ ] **Step 4: Commit**

```bash
git add crates/app/src/lib.rs
git commit -m "$(cat <<'EOF'
refactor(aom): drop aom_excluded reset on aom_start

Exclusion is now a persistent property of the tab. The reset on each
aom_start surprised users who marked a tab manual and lost the
designation the next time AOM ran. clear_all_aom_excluded stays alive
for the explicit "Include all" action surfaced in the AOM popover.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Skip excluded tabs in `enable_all_for_aom`

**Files:**
- Modify: `crates/app/src/operator.rs:910-921`

`enable_all_for_aom` currently enables Operator on every tab where `enabled=false`. We want it to skip tabs with `aom_excluded=true` so AOM doesn't take over a tab the user marked manual (e.g. a tab created during AOM, born excluded by default at `lib.rs:354`).

- [ ] **Step 1: Read the current implementation**

Run: `sed -n '905,925p' /Users/carlosgallardoarenas/Sources/karlTerminal/crates/app/src/operator.rs`

You should see:

```rust
    pub async fn enable_all_for_aom(&self) -> Vec<SessionId> {
        let mut inner = self.inner.lock().await;
        let mut touched = Vec::new();
        for (id, att) in inner.sessions.iter_mut() {
            if !att.enabled {
                att.enabled = true;
                att.enabled_by_aom = true;
                touched.push(*id);
            }
        }
        touched
    }
```

- [ ] **Step 2: Add the exclusion guard**

Replace the inner loop body so the function reads:

```rust
    pub async fn enable_all_for_aom(&self) -> Vec<SessionId> {
        let mut inner = self.inner.lock().await;
        let mut touched = Vec::new();
        for (id, att) in inner.sessions.iter_mut() {
            // Skip tabs the user marked manual — AOM does not auto-
            // claim them. Includes tabs born excluded by default
            // (new tabs spawned WHILE AOM was already running, see
            // `lib.rs` attach default).
            if att.aom_excluded {
                continue;
            }
            if !att.enabled {
                att.enabled = true;
                att.enabled_by_aom = true;
                touched.push(*id);
            }
        }
        touched
    }
```

- [ ] **Step 3: Update the doc comment on `clear_all_aom_excluded`**

`clear_all_aom_excluded` at `operator.rs:635-644` had its doc comment justify the auto-reset. Now it's only called from the explicit "Include all" UI action. Replace the doc with:

```rust
    /// Reset every tab's `aom_excluded` to false. No longer called on
    /// `aom_start` — exclusion is persistent across AOM cycles. Reused
    /// here as the backend for the AOM popover's "Include all in AOM"
    /// explicit user action: when the user wants to undo every prior
    /// exclusion in one click. UI surface lives in `ui/src/status/bar.ts`.
    pub async fn clear_all_aom_excluded(&self) {
```

- [ ] **Step 4: Verify the project still builds**

Run: `cargo check -p covenant`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/operator.rs
git commit -m "$(cat <<'EOF'
feat(aom): enable_all_for_aom skips tabs marked aom_excluded

When AOM starts, it no longer auto-enables Operator on tabs the user
explicitly marked manual. Combined with the dropped reset in aom_start
(prior commit), this gives the user a stable per-tab carve-out.

clear_all_aom_excluded keeps its purpose; comment updated to reflect
that it now backs the "Include all" explicit user action.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Add `botOff` icon

**Files:**
- Modify: `ui/src/icons/index.ts`

Add a Lucide-sourced `bot-off` icon (slashed bot) to the `Icons` map. Lucide ships this as `bot-off`; we transcribe its SVG paths inline like the existing icons.

- [ ] **Step 1: Read the current bot icon to match style**

Run: `sed -n '25,35p' /Users/carlosgallardoarenas/Sources/karlTerminal/ui/src/icons/index.ts`

- [ ] **Step 2: Add `botOff` after the `bot` definition**

In `ui/src/icons/index.ts`, find the `bot:` entry (lines 27–31). Immediately after its closing `,`, insert:

```typescript
  /** Robot with slash — operator excluded from AOM. Used on tab pills
   * to indicate "AOM is on globally but this tab is staying manual". */
  botOff: (o?: IconOptions): string =>
    svg(
      `<path d="M22 22 2 2"/><path d="M9 13v2"/><path d="M14 17H7a2 2 0 0 1-2-2v-5"/><path d="M19 14a2 2 0 0 0 2-2V8H10"/><path d="M11 4H8V2"/><path d="M12 4h4v4"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/>`,
      o,
    ),
```

- [ ] **Step 3: Run the type-checker / build to verify TS compiles**

Run: `npx tsc --noEmit -p .`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add ui/src/icons/index.ts
git commit -m "$(cat <<'EOF'
feat(icons): add botOff icon for AOM-excluded tabs

Slashed-bot variant from Lucide. Used by tab pills to signal "this tab
is being kept manual while AOM is running on the rest".

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Render `bot` / `botOff` on tab pill

**Files:**
- Modify: `ui/src/tabs/manager.ts:2345-2412` (`renderTabPill`)
- Modify: `ui/src/styles.css`

Per design Q1=C (and user-confirmed Q1 follow-up): each Operator-enabled tab shows the `bot` icon in the leading edge of the pill. When AOM is running and the tab is excluded, the icon swaps to `botOff` with muted color. Removes the obsolete comment at lines 2373-2378.

- [ ] **Step 1: Read the current `renderTabPill` to find the insertion point**

Run: `sed -n '2345,2415p' /Users/carlosgallardoarenas/Sources/karlTerminal/ui/src/tabs/manager.ts`

You'll see the obsolete comment at 2373-2378 that says badges were moved to the status bar. We're replacing that with a conditional bot icon.

- [ ] **Step 2: Replace the obsolete comment with the icon render**

In `renderTabPill`, find the block:

```typescript
    // Operator + mission badges used to live here as leading icons on
    // every tab pill. Moved to the status bar (active tab only) for a
    // simpler, less noisy tab strip — see StatusBar.setMission and
    // setOperator. Tradeoff: you can no longer see at a glance which
    // INACTIVE tabs have Operator/mission on, but the right-click
    // context menu still surfaces both per tab.
```

Replace the entire comment block with:

```typescript
    // Per-tab Operator badge. Reintroduced after the spec
    // 2026-05-04-aom-exclusion-visibility — during AOM the user needs
    // an at-a-glance view of which tabs are getting hijacked vs which
    // are kept manual. The badge is interactive (toggles exclusion)
    // only while AOM is running; otherwise it's decorative.
    if (tab.operatorEnabled) {
      const aomOn = this.aomBanner?.isOn() ?? false;
      const excluded = tab.aomExcluded;
      const showOff = aomOn && excluded;
      const iconHtml = showOff
        ? Icons.botOff({ size: 12 })
        : Icons.bot({ size: 12 });
      const badge = document.createElement("button");
      badge.type = "button";
      badge.className = "tab-bot-badge";
      if (showOff) badge.classList.add("tab-bot-badge--excluded");
      if (!aomOn) badge.classList.add("tab-bot-badge--inert");
      badge.innerHTML = iconHtml;
      badge.title = aomOn
        ? showOff
          ? "Excluded from AOM (manual). Click or ⌘⇧E to include."
          : "AOM is driving this tab. Click or ⌘⇧E to exclude."
        : "Operator enabled";
      badge.setAttribute(
        "aria-label",
        aomOn
          ? showOff
            ? "Excluded from AOM"
            : "AOM driving this tab"
          : "Operator enabled",
      );
      badge.addEventListener("mousedown", (e) => e.stopPropagation());
      badge.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!aomOn) return; // inert when AOM is off
        void this.toggleAomExcluded(tab.id);
      });
      pill.appendChild(badge);
    }
```

(The badge is appended to `pill` BEFORE the `if (this.isRenamingTab(tab.id))` block — that block builds the label/input and uses `appendChild` itself, so order matters. Insert your new block immediately above the `if (this.isRenamingTab(tab.id))` line.)

- [ ] **Step 3: Verify `aomBanner` is accessible from `TabManager`**

Run: `grep -n "aomBanner\|AomBanner" /Users/carlosgallardoarenas/Sources/karlTerminal/ui/src/tabs/manager.ts | head -10`

If `TabManager` does NOT already hold a reference to the `AomBanner`, add a setter and a private field. Run:

```
grep -n "private aomBanner\|aomBanner:" /Users/carlosgallardoarenas/Sources/karlTerminal/ui/src/tabs/manager.ts
```

If empty, add near other private fields (around line 100-200 of the class):

```typescript
  /// Held so the per-tab Operator badge knows whether AOM is on (toggle
  /// is active only during AOM). Wired by main.ts after both classes
  /// are constructed.
  private aomBanner: AomBanner | null = null;

  setAomBanner(banner: AomBanner): void {
    this.aomBanner = banner;
  }
```

And import at the top of the file (find the other relative imports):

```typescript
import type { AomBanner } from "../aom/banner";
```

In `ui/src/main.ts`, after both `manager` and `aomBanner` are constructed, add:

```typescript
manager.setAomBanner(aomBanner);
```

- [ ] **Step 4: Add CSS for the badge**

Append to `ui/src/styles.css`:

```css
/* Per-tab Operator badge — see TabManager.renderTabPill. Compact
   leading-edge button. Inherits color from the tab's text. */
.tab-bot-badge {
  appearance: none;
  background: transparent;
  border: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  margin-right: 4px;
  width: 16px;
  height: 16px;
  color: var(--accent, currentColor);
  cursor: pointer;
  border-radius: 3px;
  flex-shrink: 0;
}
.tab-bot-badge:hover {
  background: rgba(255, 255, 255, 0.06);
}
.tab-bot-badge--excluded {
  color: var(--fg-muted, rgba(255, 255, 255, 0.45));
}
.tab-bot-badge--inert {
  cursor: default;
  pointer-events: none;
  opacity: 0.7;
}
```

- [ ] **Step 5: Verify TS + build**

Run: `npx tsc --noEmit -p .`
Expected: no errors.

- [ ] **Step 6: Manual verification**

Run the dev server: `npm run tauri dev` (in repo root).

Steps:
1. Open the app, ensure ≥2 tabs exist.
2. Right-click → "Enable operator" on at least one tab.
3. Verify a `bot` icon appears at the leading edge of that tab.
4. Start AOM (⌘⇧A). All Operator-enabled tabs should still show `bot`.
5. ⌘⇧E does nothing yet (Task 6) — that's expected.
6. Right-click on an Operator-enabled tab during AOM → "Exclude from AOM (keep this tab manual)". Verify the icon swaps to `botOff` (slashed) with muted color.
7. Click the slashed icon. Verify it swaps back to `bot` and the tab rejoins AOM.
8. Stop AOM. Verify the icon returns to plain `bot` (not interactive — hover doesn't show pointer cursor).

If any of those fail, fix before committing.

- [ ] **Step 7: Commit**

```bash
git add ui/src/tabs/manager.ts ui/src/styles.css ui/src/main.ts
git commit -m "$(cat <<'EOF'
feat(tabs): per-tab AOM bot badge with excluded variant

Reintroduces a leading-edge bot icon on Operator-enabled tab pills.
When AOM is running and the tab is excluded, the icon swaps to
botOff (slashed) with muted color. Click during AOM toggles
exclusion; outside AOM the badge is decorative.

Replaces an obsolete comment that justified removing per-tab badges
— that decision predates the per-tab AOM exclusion UX where
at-a-glance state is essential.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Re-render tab badges on AOM transitions

**Files:**
- Modify: `ui/src/tabs/manager.ts` (look at the existing `aomBanner.onChange` registration, around `:628-673`)

The badge variant depends on `aomBanner.isOn()`. When AOM toggles on/off, the tabbar must re-render so badge variants update. The existing `refreshAllOperatorState` is wired to `aomBanner.onChange`; we just need to ensure `renderTabbar` is called from that path.

- [ ] **Step 1: Read the current onChange wiring**

Run: `grep -n "aomBanner.onChange\|refreshAllOperatorState\|renderTabbar" /Users/carlosgallardoarenas/Sources/karlTerminal/ui/src/tabs/manager.ts | head -15`

- [ ] **Step 2: Confirm `refreshAllOperatorState` calls `renderTabbar`**

Read the function:

```
sed -n '670,700p' /Users/carlosgallardoarenas/Sources/karlTerminal/ui/src/tabs/manager.ts
```

If `renderTabbar()` is already called inside the function (it is — line 671 in the audit output: `if (touched) this.renderTabbar();`), you only need to ensure the `touched` boolean accounts for AOM transitions even when no per-tab `enabled` actually flipped. Since icon variant flips on every AOM transition for every Operator-enabled tab, force a re-render unconditionally on transition.

Find the `if (touched) this.renderTabbar();` line inside `refreshAllOperatorState` and replace with:

```typescript
    // Always re-render on AOM transitions: the bot badge variant
    // (bot vs botOff) depends on aomBanner.isOn(), and a transition
    // flips that for every Operator-enabled tab even if none of their
    // per-tab `enabled` flags changed.
    this.renderTabbar();
```

- [ ] **Step 3: Manual verification**

`npm run tauri dev`. Steps:
1. Open 2 tabs. Enable Operator on both.
2. Exclude one via right-click while AOM is OFF — verify nothing changes (badge inert, no variant flip).
3. Start AOM → verify the excluded tab's badge swaps to `botOff` *immediately* (no delay).
4. Stop AOM → verify both tabs show plain `bot` (inert).

- [ ] **Step 4: Commit**

```bash
git add ui/src/tabs/manager.ts
git commit -m "$(cat <<'EOF'
fix(tabs): force tabbar re-render on AOM transitions

Bot badge variant (bot vs botOff) depends on aomBanner.isOn(), so a
transition flips the icon for every Operator-enabled tab even if no
per-tab enabled flag changed. The previous touched-only re-render
missed this case.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: `⌘⇧E` shortcut to toggle exclusion on active tab

**Files:**
- Modify: `ui/src/main.ts` (around the `⌘⇧A` block at `:586-614` — add a sibling block)
- Modify: `ui/src/shortcuts/registry.ts` (under `// AOM`)

Per design Q2=B: keyboard shortcut on the active tab, no-op silently when AOM is off or active tab is not Operator-enabled.

- [ ] **Step 1: Add a public method on TabManager that the shortcut can call**

Add (or verify exists) a public `toggleAomExcludedActive(): Promise<void>` on `TabManager`. It calls `toggleAomExcluded(this.activeId)` if there's an active tab AND it's Operator-enabled AND AOM is running.

In `ui/src/tabs/manager.ts`, near the existing `toggleAomExcluded` method (`:1643-1655`), add:

```typescript
  /// Wrapper around toggleAomExcluded keyed off the currently active
  /// tab. Used by the ⌘⇧E global shortcut. Silent no-op when AOM is
  /// off, no active tab, or the active tab is not Operator-enabled.
  async toggleAomExcludedActive(): Promise<void> {
    if (!this.aomBanner?.isOn()) return;
    if (!this.activeId) return;
    const tab = this.tabs.find((t) => t.id === this.activeId);
    if (!tab || !tab.operatorEnabled) return;
    await this.toggleAomExcluded(tab.id);
  }
```

- [ ] **Step 2: Wire `⌘⇧E` in main.ts**

In `ui/src/main.ts`, after the `⌘⇧A` block (around line 614), add:

```typescript
    // ⌘⇧E — toggle AOM exclusion for the active tab. Silent no-op
    // when AOM is off; the badge is the discoverable affordance and
    // the shortcut just shaves a click for users who know it exists.
    if (e.metaKey && e.shiftKey && (e.key === "E" || e.key === "e")) {
      e.preventDefault();
      void manager.toggleAomExcludedActive();
      return;
    }
```

(Order matters relative to other ⌘⇧ shortcuts in the same file — pick a position grouped with other AOM shortcuts. The block immediately after the ⌘⇧A handler is a good spot.)

- [ ] **Step 3: Add the row to the shortcuts registry**

In `ui/src/shortcuts/registry.ts`, find the `// AOM` block (around line 41–43). Append after the ⌘⇧R row:

```typescript
  { category: "AOM", keys: ["⌘", "⇧", "E"], label: "Toggle AOM for active tab", description: "Include/exclude the active tab from AOM. Visible feedback via the tab's bot badge (slashed = excluded)." },
```

- [ ] **Step 4: Verify TS compiles**

Run: `npx tsc --noEmit -p .`
Expected: no errors.

- [ ] **Step 5: Manual verification**

`npm run tauri dev`. Steps:
1. Two tabs, both Operator-enabled. Start AOM.
2. Activate tab A. Press `⌘⇧E`. Tab A's badge swaps to `botOff`.
3. Press `⌘⇧E` again. Tab A's badge swaps back to `bot`.
4. Activate tab B. Press `⌘⇧E`. Tab B (not A) swaps.
5. Stop AOM. Press `⌘⇧E`. Nothing happens. No console errors.
6. Open the shortcuts panel (⌘⇧K). Verify the new row appears under AOM.

- [ ] **Step 6: Commit**

```bash
git add ui/src/main.ts ui/src/tabs/manager.ts ui/src/shortcuts/registry.ts
git commit -m "$(cat <<'EOF'
feat(aom): ⌘⇧E toggles AOM exclusion for the active tab

Active-tab keyboard affordance for the per-tab AOM opt-out. Silent
no-op when AOM is off, no active tab, or active tab has Operator
disabled. Pairs with the new bot badge (click) and the existing
right-click menu — three discoverable paths to the same toggle.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Persist `aom_excluded` in `TabManifestV1`

**Files:**
- Modify: `ui/src/tabs/manager.ts:1696-1720` (`serializeManifest`) and the manifest interface
- Modify: `ui/src/tabs/manager.ts:1729-1780+` (`restoreFromManifest`)

Per design § 4 + Q3=A: exclusion persists across app restarts via the manifest. Manifest version stays `1` — additive optional field. Restore path always sends `setAomExcluded` (per spec amendment).

- [ ] **Step 1: Find the manifest type definition**

Run: `grep -n "TabManifestV1\|interface TabManifestV1\|type TabManifestV1" /Users/carlosgallardoarenas/Sources/karlTerminal/ui/src/tabs/manager.ts`

- [ ] **Step 2: Extend the per-tab manifest entry type**

Find the type `TabManifestV1` (and any per-tab entry type it nests). Add the new optional field. The signature reads `tabs: Array<{ ... }>` — add `aom_excluded?: boolean` to that inline shape (or to the named per-tab type if there is one). Example diff for the inline form:

```typescript
  tabs: Array<{
    custom_name: string | null;
    cwd: string | null;
    color: string | null;
    group_id: string | null;
    mission_path: string | null;
    operator_id: string | null;
    aom_excluded?: boolean;  // <-- new, optional for backward compat
  }>;
```

If the type lives in a separate `TabManifestEntry` named type, add the field there.

- [ ] **Step 3: Serialize the field**

In `serializeManifest()` around line 1705, the per-tab `.map(...)` produces objects with keys like `custom_name: t.customName`. Add a new line:

```typescript
        aom_excluded: t.aomExcluded,
```

Within the existing object literal.

- [ ] **Step 4: Restore the field**

In `restoreFromManifest()` (`:1729+`), after the existing per-tab restore block (mission, operator_id), add:

```typescript
      if (created) {
        // Always call setAomExcluded with the persisted value (defaulting
        // to false if missing) — the backend's default at attach time
        // depends on whether AOM is currently running, so explicitly
        // pinning the value avoids subtle drift across restarts.
        const persistedExcluded = t.aom_excluded ?? false;
        try {
          await setAomExcluded(created.sessionId, persistedExcluded);
          created.aomExcluded = persistedExcluded;
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn("aom_excluded restore failed", err);
        }
      }
```

(Verify `setAomExcluded` is already imported from `../api`. If not, add it to the imports at the top.)

- [ ] **Step 5: Verify TS compiles**

Run: `npx tsc --noEmit -p .`
Expected: no errors.

- [ ] **Step 6: Manual verification**

`npm run tauri dev`. Steps:
1. Two tabs, both Operator-enabled. Start AOM.
2. Exclude tab A via ⌘⇧E or right-click.
3. Stop AOM.
4. Quit the app entirely (⌘Q).
5. Relaunch. Verify both tabs are restored.
6. Start AOM. Verify tab A immediately renders with `botOff` (its excluded state survived the restart). Tab B renders with `bot`.

- [ ] **Step 7: Commit**

```bash
git add ui/src/tabs/manager.ts
git commit -m "$(cat <<'EOF'
feat(persistence): persist aom_excluded across app restarts

Adds an optional aom_excluded field to TabManifestV1 (additive — old
manifests default to false). Restore always calls setAomExcluded with
the persisted value to avoid drift from the backend's attach-time
default which depends on whether AOM is currently running.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: StatusBar setters for excluded list & count

**Files:**
- Modify: `ui/src/status/bar.ts`

Per design § 5: when ≥1 tab is excluded, the AOM segment renders a "(N excluded)" suffix. Click opens a popover listing each excluded tab with an "Include" button + an "Include all" action. We add a typed setter and store the data; render comes in Task 9.

- [ ] **Step 1: Add types for excluded-tab info**

Near the top of `ui/src/status/bar.ts`, after `ActiveTabInfo`:

```typescript
/// Lightweight per-tab descriptor for the excluded-list popover.
export interface ExcludedTabInfo {
  sessionId: SessionId;
  tabId: string;
  name: string;
  /// Trimmed cwd for display. Empty string when no cwd.
  cwdShort: string;
}

/// AOM popover callbacks — extended in Task 8 for per-tab + bulk
/// inclusion. Stop and Afk remain.
export interface AomActions {
  onStop: () => void;
  onAfk: () => void;
  /// Re-include a single excluded tab. Implementer (TabManager)
  /// should call setAomExcluded(sessionId, false) and refresh state.
  onIncludeTab: (sessionId: SessionId) => void;
  /// Re-include every excluded tab in one click. Implementer should
  /// call clear_all_aom_excluded().
  onIncludeAll: () => void;
}
```

(Replace the existing `AomActions` interface with the extended one.)

- [ ] **Step 2: Add private state for the excluded list**

Inside `class StatusBar`, near `private currentAom: AomStatus | null = null;`:

```typescript
  /// Tabs currently excluded from AOM. Pushed by TabManager whenever
  /// the set changes (toggle, AOM transition, restore). Empty when
  /// AOM is off OR no exclusions exist — both collapse the suffix.
  private excludedTabs: ExcludedTabInfo[] = [];
```

- [ ] **Step 3: Add the setter**

Near the other setters (after `setAom`):

```typescript
  /// Pushed by TabManager whenever the per-tab exclusion set changes
  /// — on AOM start/stop transitions, on individual toggles, and on
  /// manifest restore. The chip suffix and popover read from this list.
  setExcludedTabs(tabs: ExcludedTabInfo[]): void {
    // Cheap identity check: same length AND same ids in same order.
    const same =
      this.excludedTabs.length === tabs.length &&
      this.excludedTabs.every((t, i) => t.sessionId === tabs[i]?.sessionId);
    if (same) return;
    this.excludedTabs = tabs;
    // If popover is open, re-render its body so the list stays live.
    if (this.aomPopover) {
      this.refreshExcludedListInPopover();
    }
    this.render(this.lastDirCtx);
  }

  private refreshExcludedListInPopover(): void {
    // Concrete render comes in Task 9. Stub for now.
  }
```

- [ ] **Step 4: Verify TS compiles**

Run: `npx tsc --noEmit -p .`
Expected: type errors about missing `onIncludeTab` / `onIncludeAll` in callers wiring `bindAomActions`. We'll fix those in Task 11.

For now, TEMPORARILY mark `onIncludeTab` and `onIncludeAll` as optional in the interface to defer the wiring — change the type to:

```typescript
export interface AomActions {
  onStop: () => void;
  onAfk: () => void;
  onIncludeTab?: (sessionId: SessionId) => void;
  onIncludeAll?: () => void;
}
```

Re-run `npx tsc --noEmit -p .` — expected to pass now. We'll tighten in Task 11.

- [ ] **Step 5: Commit**

```bash
git add ui/src/status/bar.ts
git commit -m "$(cat <<'EOF'
feat(status): track excluded-tab list on the AOM chip

Adds the data plumbing for the excluded-tab suffix and popover.
Render and wiring land in subsequent tasks. AomActions gains optional
onIncludeTab / onIncludeAll callbacks; the optionality is temporary
and tightens once TabManager wires them up.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Render "(N excluded)" suffix on AOM chip

**Files:**
- Modify: `ui/src/status/bar.ts:564-603` (`aomSegment`) and the chip-related render logic

The AOM chip (`aomSegment`) renders icon + AOM label + time + cost. We add a conditional segment after the cost that reads `· N excluded` when `excludedTabs.length > 0`. Clicking the segment opens the same popover as the rest of the chip (already happens — segment is the parent button).

- [ ] **Step 1: Modify `aomSegment` to take the excluded count**

Find the function `aomSegment` (line 564). Change its signature to:

```typescript
function aomSegment(
  aom: AomStatus,
  excludedCount: number,
  onClick: (anchor: HTMLElement) => void,
): HTMLElement {
```

After the existing `cost` span append, before the `el.addEventListener("click", ...)`, add:

```typescript
  if (excludedCount > 0) {
    const sep = document.createElement("span");
    sep.className = "status-segment-sep";
    sep.textContent = "·";
    el.appendChild(sep);

    const excl = document.createElement("span");
    excl.className = "status-secondary status-aom-excluded";
    excl.textContent = `${excludedCount} excluded`;
    el.appendChild(excl);
  }
```

- [ ] **Step 2: Update the call site**

Find where `aomSegment` is called (around `:459-462`). Change:

```typescript
    if (this.currentAom) {
      this.host.appendChild(
        aomSegment(this.currentAom, (anchor) => this.openAomPopover(anchor)),
      );
    }
```

to:

```typescript
    if (this.currentAom) {
      this.host.appendChild(
        aomSegment(
          this.currentAom,
          this.excludedTabs.length,
          (anchor) => this.openAomPopover(anchor),
        ),
      );
    }
```

- [ ] **Step 3: Add CSS for the new segment**

Append to `ui/src/styles.css`:

```css
.status-aom-excluded {
  /* Slightly muted to read as supplementary info, not as primary
     warning. The popover carries the actionable detail. */
  color: var(--fg-muted, rgba(255, 255, 255, 0.55));
  font-variant-numeric: tabular-nums;
}
```

- [ ] **Step 4: Verify TS compiles**

Run: `npx tsc --noEmit -p .`

- [ ] **Step 5: Manual verification (partial — list comes in Task 10)**

The setter is not wired by TabManager yet (Task 12). Skip live verification; we'll cover it after Task 12.

- [ ] **Step 6: Commit**

```bash
git add ui/src/status/bar.ts ui/src/styles.css
git commit -m "$(cat <<'EOF'
feat(status): render \"(N excluded)\" suffix on AOM chip

Conditionally appended after the cost segment when ≥1 tab is excluded.
Clicking still opens the existing popover (the suffix is part of the
parent button). Wiring from TabManager lands in a later task.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Excluded list + Include actions in AOM popover

**Files:**
- Modify: `ui/src/status/bar.ts:270-341` (`openAomPopover`) and `refreshExcludedListInPopover`

When the popover opens and there are excluded tabs, render a list section between the stats grid and the action buttons. Each entry is `name (cwdShort)` with a per-tab "Include" button. Below the list, a single "Include all in AOM" button when ≥2 excluded.

- [ ] **Step 1: Extend `openAomPopover` to include the excluded section**

Inside `openAomPopover`, replace the `pop.innerHTML = ...` template. Find the current template (lines 280-297). Insert a new block between the `</div>` that closes `.status-aom-pop-grid` and the `<div class="status-aom-pop-actions">`. The new block:

```html
${
  this.excludedTabs.length > 0
    ? `
      <div class="status-aom-pop-excluded">
        <div class="status-aom-pop-excluded-title">Excluded from AOM (${this.excludedTabs.length})</div>
        <ul class="status-aom-pop-excluded-list">
          ${this.excludedTabs
            .map(
              (t) => `
              <li>
                <span class="status-aom-pop-excluded-name">${escapeHtml(t.name)}</span>
                ${t.cwdShort ? `<span class="status-aom-pop-excluded-cwd">${escapeHtml(t.cwdShort)}</span>` : ""}
                <button type="button" class="status-aom-pop-excluded-btn" data-session-id="${t.sessionId}">Include</button>
              </li>
            `,
            )
            .join("")}
        </ul>
        ${
          this.excludedTabs.length >= 2
            ? `<button type="button" class="status-aom-pop-include-all">Include all in AOM</button>`
            : ""
        }
      </div>
    `
    : ""
}
```

(Place this template fragment inside the existing template literal before the action buttons.)

- [ ] **Step 2: Wire the new buttons**

After the existing Stop/AFK button wiring (around line 320), add:

```typescript
    pop.querySelectorAll<HTMLButtonElement>(".status-aom-pop-excluded-btn").forEach(
      (btn) => {
        btn.addEventListener("click", () => {
          const sid = btn.dataset.sessionId;
          if (!sid) return;
          this.aomActions?.onIncludeTab?.(sid as SessionId);
          this.closeAomPopover();
        });
      },
    );
    pop.querySelector<HTMLButtonElement>(".status-aom-pop-include-all")?.addEventListener(
      "click",
      () => {
        this.aomActions?.onIncludeAll?.();
        this.closeAomPopover();
      },
    );
```

- [ ] **Step 3: Implement `refreshExcludedListInPopover`**

Replace the stub from Task 8 with a full re-render of the popover (simplest correct approach — the popover is small):

```typescript
  private refreshExcludedListInPopover(): void {
    if (!this.aomPopover) return;
    const anchor = this.host.querySelector<HTMLElement>(".status-aom");
    this.closeAomPopover();
    if (anchor) this.openAomPopover(anchor);
  }
```

- [ ] **Step 4: Add CSS for the popover list**

Append to `ui/src/styles.css`:

```css
.status-aom-pop-excluded {
  border-top: 1px solid var(--border, rgba(255, 255, 255, 0.08));
  padding-top: 8px;
  margin-top: 4px;
}
.status-aom-pop-excluded-title {
  font-size: 11px;
  color: var(--fg-muted, rgba(255, 255, 255, 0.55));
  margin-bottom: 6px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.status-aom-pop-excluded-list {
  list-style: none;
  padding: 0;
  margin: 0 0 6px 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.status-aom-pop-excluded-list li {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
}
.status-aom-pop-excluded-name {
  font-weight: 500;
}
.status-aom-pop-excluded-cwd {
  display: block;
  grid-column: 1 / 2;
  font-size: 11px;
  color: var(--fg-muted, rgba(255, 255, 255, 0.45));
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.status-aom-pop-excluded-btn,
.status-aom-pop-include-all {
  appearance: none;
  background: transparent;
  border: 1px solid var(--border, rgba(255, 255, 255, 0.12));
  color: inherit;
  padding: 3px 8px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 11px;
}
.status-aom-pop-excluded-btn:hover,
.status-aom-pop-include-all:hover {
  background: rgba(255, 255, 255, 0.06);
}
.status-aom-pop-include-all {
  width: 100%;
  padding: 6px 8px;
  margin-top: 4px;
}
```

- [ ] **Step 5: Verify TS compiles**

Run: `npx tsc --noEmit -p .`

- [ ] **Step 6: Commit**

```bash
git add ui/src/status/bar.ts ui/src/styles.css
git commit -m "$(cat <<'EOF'
feat(status): excluded-tabs section in AOM popover

Lists each excluded tab with a per-tab Include button. Adds an
\"Include all in AOM\" button when ≥2 are excluded. Both wire to
optional AomActions callbacks (TabManager binds in the next task).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Wire StatusBar exclusion data + actions from TabManager

**Files:**
- Modify: `ui/src/main.ts` (the `bindAomActions` call) — wire `onIncludeTab` and `onIncludeAll`
- Modify: `ui/src/tabs/manager.ts` — push `setExcludedTabs` on every relevant change
- Modify: `ui/src/status/bar.ts` — tighten `AomActions` (remove `?` from `onIncludeTab`/`onIncludeAll`)

The popover is data-driven. TabManager owns the truth (per-tab state), StatusBar just renders. We wire the push points and the action callbacks.

- [ ] **Step 1: Find current `bindAomActions` call site**

Run: `grep -n "bindAomActions" /Users/carlosgallardoarenas/Sources/karlTerminal/ui/src/main.ts`

- [ ] **Step 2: Extend the action wiring**

In `ui/src/main.ts` at the `bindAomActions` call site (likely around the AOM banner setup), extend the object passed in:

```typescript
statusBar.bindAomActions({
  onStop: () => {
    /* existing */
  },
  onAfk: () => {
    /* existing */
  },
  onIncludeTab: (sessionId) => {
    void manager.setAomExcludedFor(sessionId, false);
  },
  onIncludeAll: () => {
    void manager.includeAllInAom();
  },
});
```

- [ ] **Step 3: Add the helper methods on TabManager**

In `ui/src/tabs/manager.ts`, add two public methods near the existing `toggleAomExcluded`:

```typescript
  /// Set exclusion explicitly (Task 11 — used by the popover's per-tab
  /// Include action). Wraps backend + local state + tabbar render +
  /// StatusBar push.
  async setAomExcludedFor(sessionId: SessionId, excluded: boolean): Promise<void> {
    const tab = this.tabs.find((t) => t.sessionId === sessionId);
    if (!tab) return;
    if (tab.aomExcluded === excluded) return;
    try {
      await setAomExcluded(sessionId, excluded);
      tab.aomExcluded = excluded;
      this.renderTabbar();
      this.pushExcludedToStatusBar();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("setAomExcludedFor failed", err);
    }
  }

  /// "Include all" — invokes the bulk backend command, then refreshes
  /// every per-tab cache and re-renders. Used by the AOM popover.
  async includeAllInAom(): Promise<void> {
    try {
      await clearAllAomExcluded();
      for (const t of this.tabs) {
        t.aomExcluded = false;
      }
      this.renderTabbar();
      this.pushExcludedToStatusBar();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("clearAllAomExcluded failed", err);
    }
  }

  /// Recompute the StatusBar exclusion list from current tab state and
  /// push. Called whenever the set could have changed (toggle, restore,
  /// AOM transition).
  private pushExcludedToStatusBar(): void {
    const aomOn = this.aomBanner?.isOn() ?? false;
    if (!aomOn) {
      this.statusBar?.setExcludedTabs([]);
      return;
    }
    const list = this.tabs
      .filter((t) => t.operatorEnabled && t.aomExcluded)
      .map((t) => ({
        sessionId: t.sessionId,
        tabId: t.id,
        name: tabDisplayName(t),
        cwdShort: shortCwd(t.cwd),
      }));
    this.statusBar?.setExcludedTabs(list);
  }
```

Add a helper for `shortCwd` (replace `$HOME` with `~`, truncate the leading parents to keep ~30 chars). Place near the other small helpers in the file:

```typescript
function shortCwd(cwd: string | null): string {
  if (!cwd) return "";
  // /Users/<name>/ → ~/  (Linux: /home/<name>/ → ~/). Cheap regex,
  // no need for an env round-trip — process.env.HOME isn't available
  // in the Tauri webview anyway.
  let p = cwd.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~");
  if (p.length > 30) p = "…" + p.slice(p.length - 29);
  return p;
}
```

- [ ] **Step 4: Verify `clearAllAomExcluded` is exported in `api.ts`**

Run: `grep -n "clearAllAomExcluded\|clear_all_aom_excluded" /Users/carlosgallardoarenas/Sources/karlTerminal/ui/src/api.ts`

If absent, add to `ui/src/api.ts`:

```typescript
export async function clearAllAomExcluded(): Promise<void> {
  return invoke<void>("clear_all_aom_excluded");
}
```

Then verify the backend command exists. Run: `grep -n "clear_all_aom_excluded" /Users/carlosgallardoarenas/Sources/karlTerminal/crates/app/src/lib.rs`. If a Tauri command wrapper isn't already exposed in `tauri::generate_handler!`, add one:

```rust
#[tauri::command]
async fn clear_all_aom_excluded(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    state.operator.clear_all_aom_excluded().await;
    Ok(())
}
```

And register it in the `tauri::generate_handler!` macro alongside `set_aom_excluded`, `is_aom_excluded`. Be sure to add the import for `clear_all_aom_excluded` in the handler list.

- [ ] **Step 5: Add a `statusBar` reference on TabManager**

If TabManager doesn't already hold the StatusBar (parallel to the `aomBanner` reference added in Task 4), add:

```typescript
  private statusBar: StatusBar | null = null;

  setStatusBar(sb: StatusBar): void {
    this.statusBar = sb;
  }
```

Import the type:

```typescript
import type { StatusBar } from "../status/bar";
```

In `main.ts` after both are constructed:

```typescript
manager.setStatusBar(statusBar);
```

- [ ] **Step 6: Push exclusion list at the right moments**

Find the existing `aomBanner.onChange` registration in TabManager (the one that triggers `refreshAllOperatorState`). After the call to `this.renderTabbar()` (which we made unconditional in Task 5), add a call to `pushExcludedToStatusBar()`:

```typescript
    this.renderTabbar();
    this.pushExcludedToStatusBar();
```

Also call `this.pushExcludedToStatusBar()` in:
- `toggleAomExcluded` (after `tab.aomExcluded = next; this.renderTabbar();`)
- `restoreFromManifest` (after the loop finishes restoring all tabs)

- [ ] **Step 7: Tighten AomActions interface**

In `ui/src/status/bar.ts`, remove the `?` markers from `onIncludeTab` and `onIncludeAll` in the `AomActions` interface. Should now be:

```typescript
export interface AomActions {
  onStop: () => void;
  onAfk: () => void;
  onIncludeTab: (sessionId: SessionId) => void;
  onIncludeAll: () => void;
}
```

Update the popover wiring inside `openAomPopover` to drop the optional-chaining `?.()` — call directly. (The wiring is now mandatory.)

- [ ] **Step 8: Verify TS + Rust compile**

Run: `npx tsc --noEmit -p .` (no errors)
Run: `cargo check -p covenant` (no errors)

- [ ] **Step 9: Manual verification end-to-end**

`npm run tauri dev`. Steps:
1. Two tabs, both Operator-enabled. Start AOM.
2. Verify status-bar AOM chip shows "AOM · Xm · $0.000". No excluded suffix.
3. ⌘⇧E on tab A. Chip now shows "AOM · Xm · $0.000 · 1 excluded".
4. Click the chip → popover opens with header, stats, then "EXCLUDED FROM AOM (1)" with tab A's name and an Include button.
5. Click Include on tab A's row. Popover closes. Chip suffix disappears. Tab A's badge swaps back to plain `bot`.
6. ⌘⇧E on tab A again, then ⌘⇧E on tab B → both excluded. Chip: "2 excluded". Popover lists both with per-tab buttons + an "Include all in AOM" button below.
7. Click "Include all in AOM" → popover closes, both tabs rejoin AOM, chip suffix gone.
8. Repeat #6, then quit + relaunch the app. Verify the manifest restored both tabs as excluded (chip immediately shows "2 excluded" once AOM is started).

- [ ] **Step 10: Commit**

```bash
git add ui/src/main.ts ui/src/tabs/manager.ts ui/src/status/bar.ts ui/src/api.ts crates/app/src/lib.rs
git commit -m "$(cat <<'EOF'
feat(status): wire excluded list + Include actions end-to-end

TabManager now pushes the excluded set to the StatusBar on every
mutation (toggle, AOM transition, restore). Popover Include buttons
(per-tab + bulk) call back into TabManager which performs the backend
write and refreshes local state.

Adds clear_all_aom_excluded as an exposed Tauri command + api.ts
wrapper. Backend method itself was already present and unchanged.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: Final regression sweep

**Files:** none — verification only.

The convergence overlay (`crates/app/src/convergence.rs:206-207`) and operator dispatch (`crates/app/src/operator.rs:1261, 1516-1533`) already gate on `aom_excluded`. Persistence + visibility don't change those paths. We confirm the existing behaviors still hold.

- [ ] **Step 1: Convergence overlay behavior**

`npm run tauri dev`. Steps:
1. 3 Operator-enabled tabs. Start AOM.
2. Open convergence overlay (⌘⇧M).
3. All 3 tiles visible.
4. ⌘⇧E on tab A (now excluded) → tile for tab A disappears from the overlay (filtered by `enrolled = aom_enabled && op_enabled && !aom_excluded`).
5. Include tab A again → tile reappears.

- [ ] **Step 2: Cost accounting**

Continuing from Step 1: leave AOM running for ~2 minutes with two tabs excluded. Periodically check the AOM popover. Cost continues to grow only based on the included tab's activity. No cost from the excluded tabs.

- [ ] **Step 3: AOM stop reverts only auto-enabled tabs**

Steps:
1. With AOM running, the included tabs that AOM auto-enabled have `enabled_by_aom=true` (internal). Excluded tabs that the user manually enabled have `enabled_by_aom=false`.
2. Stop AOM (⌘⇧A).
3. Auto-enabled tabs revert (Operator off).
4. Manually-enabled-then-excluded tabs stay Operator-on (unchanged).

(Verify via right-click → "Disable operator" / "Enable operator" labels reflecting current state.)

- [ ] **Step 4: Right-click context menu still works**

Steps:
1. With AOM running, right-click on a tab → "Exclude from AOM" / "Include in AOM" toggles correctly. Badge updates. Popover updates.
2. Outside AOM, right-click → menu shows "Operator: dry-run / live" toggle (existing M-OP3) instead. No exclusion entry — same as before.

- [ ] **Step 5: No console errors during the full flow**

Open the dev tools console. Run through every step from Tasks 4-11's manual verification sections. There should be zero errors and zero unhandled promise rejections.

- [ ] **Step 6: Final commit (if any docs need updating)**

If you noticed any stale comment or doc string while working through the verification, fix it now and commit:

```bash
git add <files>
git commit -m "docs: tidy stale comments after AOM exclusion-visibility rollout"
```

If nothing to commit, skip this step.

---

## Acceptance criteria (from the spec)

Verify each of these before declaring the plan done:

- [ ] During AOM, every Operator-enabled tab shows a `bot` icon; an excluded tab shows `botOff`. The variant updates within 1s of a toggle. ← Task 4 + 5
- [ ] `⌘⇧E` on the active tab toggles exclusion when AOM is on; is a silent no-op otherwise. ← Task 6
- [ ] Clicking the icon on a tab while AOM is on toggles its exclusion. ← Task 4
- [ ] Stopping AOM and restarting it does NOT wipe per-tab exclusion state. ← Task 1
- [ ] Quitting and relaunching the app preserves per-tab exclusion state via the tab manifest. ← Task 7
- [ ] When ≥1 tab is excluded, the AOM banner shows `· N excluded` and exposes a popover with per-tab "Include" + global "Include all". ← Tasks 9 + 10 + 11
- [ ] AOM auto-enable does not touch a tab marked `aom_excluded`. ← Task 2
- [ ] Excluded tabs do not appear in the convergence overlay; do not contribute to `accumulated_cost_usd`. ← Task 12

---

## Self-review

**Spec coverage:** Each section (§ 1–6) has at least one task. § 1 → Tasks 1, 2. § 2 → Tasks 3, 4, 5. § 3 → Tasks 6, 11. § 4 → Task 7. § 5 → Tasks 8, 9, 10, 11. § 6 → Tasks 5, 6, 7, 11, 12 (manual verification embedded throughout).

**Type consistency:** `setAomExcluded` (UI api), `setAomExcludedFor` (TabManager), `set_aom_excluded` (Tauri command). `aomExcluded` (UI Tab field), `aom_excluded` (manifest + Rust). All consistent across tasks.

**Placeholder scan:** No TBDs, TODOs, or "implement later" markers. Every code block is concrete.

**Open follow-ups:** none.
