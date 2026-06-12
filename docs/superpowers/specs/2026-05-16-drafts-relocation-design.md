# Drafts relocation — from sidebar full-page to ProjectNotesPanel tab

**Date:** 2026-05-16
**Author:** Karluiz + Claude
**Status:** Design (approved, pending plan)

---

## Problem

The right sidebar nav strip exposes `[Blocks] [Files] [Drafts]` as peers. Clicking "Drafts" looks like it will open a sidebar pane (matching the Blocks/Files affordance) but actually takes over the whole workspace with a full-page panel containing a list, a wizard, and a "Published specs" tab.

Two issues compound:

1. **Affordance mismatch.** The button promises a sidebar pane and delivers a page takeover.
2. **Wrong job-to-be-done framing.** Drafts are mostly *agent-authored* artifacts (Claude / Copilot / Codex emit them via `save_draft` as part of spec-driven work). The user rarely sits down to author one from scratch. The user's actual job is **review / edit / publish** the agent's output — plus the occasional case of **scaffolding a spec with AI assistance before handing off to an executor agent**.

The full-page panel optimizes for neither job: review is heavy because every interaction is a page-takeover, and the standalone creation path is hidden inside a list-first UI.

## Goals

- Make agent-authored drafts discoverable in the **context of the group/repo** they belong to.
- Reuse the **standard markdown editor** for reading/editing drafts. Drafts are `.md` files; treat them as such.
- Preserve the **AI-assisted spec creation wizard** as a focused entry point for human-initiated spec scaffolding.
- Eliminate the affordance-mismatched sidebar nav button.
- Zero migration: existing drafts in `docs/specs/` stay put.

## Non-goals

- Changing the on-disk format of drafts (`docs/specs/<slug>.md` with frontmatter).
- Changing the `spec_author` Rust crate or LLM section-suggest behavior.
- Per-group draft scoping at the data layer (drafts remain repo-scoped on disk).
- Killing or rewriting the wizard UI.
- Notifying agents about review state (out of scope for this round).

## Design

### Conceptual model

Drafts splits into **two surfaces, two roles**:

| Surface | Role | Implementation |
|---|---|---|
| **ProjectNotesPanel > Drafts tab** | List + entry points for the active group's repo | New tab in `ui/src/project-notes/panel.ts` |
| **SpecAuthorPage** (renamed from DraftsPanel) | Creation-only AI-assisted wizard | Trimmed `ui/src/drafts/panel.ts` — wizard mode only |

Reading and editing happen in the **existing markdown editor** — no dedicated review UI.

### ProjectNotesPanel > Drafts tab

Added as a 4th tab alongside `commands | notes | docs | drafts`. Per-group: filters `docs/specs/*.md` files within `group.rootDir` (the repo of the active group) where frontmatter `status` ≠ `published`.

Layout:

```
COVENANT
[commands] [notes] [docs] [drafts •2]    ← counter shows in-flight count
─────────────────────────────────────
+ New spec (AI-assisted)                 ← entry point for human-initiated creation

▸ 2026-05-16-pi-rpc-executor.md
  Pi RPC executor · updated 2h ago · 1 LLM call
▸ feature-onboarding.md
  Onboarding wizard · agent draft · updated 14m ago
```

Interactions:

- **Item click** → opens the underlying `.md` in the existing markdown editor. No wizard, no full-page takeover. The editor reads frontmatter and renders a `spec draft` chip in the tab header.
- **`+ New spec (AI-assisted)`** → opens `SpecAuthorPage` (wizard) with the active group's `rootDir` precharged as `repoRoot`. On save/publish, page closes and the new draft appears in the list.
- **Empty state** → "No drafts. + New spec…".
- **No `rootDir` on the group** → "Set a root dir for this group to track drafts" with a button that triggers the existing root-dir picker.
- **Counter `•N`** styled identical to the commands counter pill.

The Drafts tab is **always visible** for every group (no conditional rendering based on draft count) — discoverability over minimalism.

### SpecAuthorPage (the wizard)

`ui/src/drafts/panel.ts` is trimmed:

- Removes the list view, the "Drafts / Published specs" tab toggle, and the published-specs rendering path.
- Boots directly into wizard mode when opened.
- `open()` accepts `{ repoRoot: string }` so the caller (ProjectNotesPanel) injects the group's repo.
- On wizard save → emits `draft:saved` event with `{ repoRoot, slug, title }` and closes itself.
- On publish → closes; published spec lives at `docs/specs/<NN>-<slug>.md` as today.

Optional rename of the file / class to `SpecAuthorPage` for clarity. Not required for the design to land; flagged for the plan.

### Sidebar nav strip

```
[Blocks] [Files]
```

The "Drafts" button (`ui/src/tabs/manager.ts:1853-1864`) is removed entirely. No replacement in that strip.

### Keyboard shortcut

`⌘⇧D` is re-targeted:

- **Before:** dispatches `drafts:toggle`, opens the full DraftsPanel.
- **After:** opens the ProjectNotesPanel of the active group and switches it to the Drafts tab.

### Agent flow

Agents still write drafts via the existing `save_draft` Tauri command. **New behavior:** on success, the backend emits a `draft:saved` Tauri event (or the frontend wrapper does, equivalent). The frontend:

1. Refreshes the Drafts tab of the ProjectNotesPanel for the group whose `rootDir` matches the draft's `repoRoot`.
2. Increments the in-flight counter.
3. Shows a toast: *"Claude saved draft 'foo'"* with a "Review" CTA that opens the draft in the editor.

## Architecture / components touched

| File / module | Change |
|---|---|
| `ui/src/project-notes/panel.ts` | Add `drafts` tab type; render `DraftsTab` in `updateTabUI()` |
| `ui/src/project-notes/drafts-tab.ts` (new) | List view, counter, "+ New" button, item-click → open in markdown editor |
| `ui/src/drafts/panel.ts` | Trim to wizard-only; accept `repoRoot` injection; emit `draft:saved` |
| `ui/src/drafts/api.ts` | No change. `save_draft` and `list_drafts` already do what we need |
| `ui/src/tabs/manager.ts:1853-1864` | Remove the "Drafts" button from the sidebar nav strip |
| `ui/src/shortcuts/registry.ts:49` | Update `⌘⇧D` description to "Open Drafts tab in ProjectNotesPanel" |
| `ui/src/main.ts` | Re-wire `⌘⇧D` and `drafts:toggle` dispatch to ProjectNotesPanel.openDraftsTab(group) |
| Markdown editor (existing) | On open, parse frontmatter; if `status` exists (i.e. spec draft), render a chip in the tab header |
| `crates/agent/src/spec_author/` | No change |
| `save_draft` Tauri command | Emit `draft:saved` event after writing |

## Data flow

```
Agent (Claude/Copilot/Codex)
    └─ save_draft(repoRoot, slug, title, body)
        └─ writes docs/specs/<slug>.md
        └─ emits Tauri event "draft:saved" { repoRoot, slug, title }
            ↓
        ProjectNotesPanel listens, finds groups where group.rootDir == repoRoot,
        refreshes their Drafts tab + bumps counter + shows toast.

User click on Drafts item in ProjectNotesPanel
    └─ opens docs/specs/<slug>.md in markdown editor (existing path)

User "+ New spec (AI-assisted)" in ProjectNotesPanel
    └─ opens SpecAuthorPage with repoRoot = activeGroup.rootDir
        └─ wizard flow → save → close → list refreshes
```

## Error handling

- **`group.rootDir` is null** → empty state with "Set a root dir" CTA. Don't call `list_drafts` with a placeholder.
- **`list_drafts` fails** (repo not a git repo, dir doesn't exist, perms) → render error row in the tab with a Retry button. Log via `tracing`.
- **`save_draft` event for an unknown repoRoot** (no group matches) → toast only (no panel refresh). Should not happen in practice but be defensive.
- **Wizard open fails** → existing error path stays as-is.

## Testing

- **Unit:** `familiars/panel.test.ts` — new cases: renders drafts list, increments counter on `draft:saved`, filters by group `rootDir`, empty state without rootDir.
- **Unit:** `drafts/wizard.test.ts` — already covers wizard flow; add a test that `save` emits `draft:saved` payload.
- **Integration (manual):**
  1. With a Covenant group rooted at the Covenant repo, agent runs `save_draft` → counter bumps, toast appears.
  2. Click a draft → opens in markdown editor with `spec draft` chip.
  3. `+ New spec` → wizard opens with repoRoot precharged; publish → file appears in `docs/specs/`, panel refreshes.
  4. Switch to a group with no rootDir → empty state shows "Set a root dir" CTA.
  5. Two groups sharing the same rootDir → both panels show identical draft lists.
  6. `⌘⇧D` from anywhere → ProjectNotesPanel of active group opens on Drafts tab.

## Migration

None. Drafts on disk stay where they are. The sidebar button removal is a one-way UI change. `⌘⇧D` is re-targeted, not removed — muscle memory survives.

## Open questions

- **Should the SpecAuthorPage be renamed (file + class) to `SpecAuthorPage`?** Recommended yes — `DraftsPanel` becomes misleading once the list view is gone. Decision deferred to the plan.
- **Does the markdown editor already know how to render a frontmatter chip?** If not, a tiny addition is required (parse frontmatter on open, show chip if `status` field exists). Plan should verify and scope.
- **Should the toast deep-link directly to the editor, or to the ProjectNotesPanel?** Recommended: directly to the editor (the user's job is to review the content, not to admire the counter).
