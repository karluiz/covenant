# Canon — create a unit of any kind from the cockpit

Date: 2026-07-21
Branch: `feat/canon-new-unit` · worktree `../karlTerminal-canon-new`

## Problem

Canon's six cockpit sections (Subagents, Commands, MCP, Specs, Memory, Skills)
are read-only views over the repo (`canonLocalStatus(cwd)`). They can *publish*,
*adopt* and *import* — but nothing can be **authored** from Canon. The empty
states literally say "author a .md by hand". An organization owner has no way to
inscribe a new capability from the surface that owns capabilities.

## Goal

The owner of an organization can create a new unit of each Canon kind directly
from its cockpit section, land it in the repo's Canon source, edit it, and
publish it to the org registry.

## Scope decision

Created artifacts are **repo-local Canon source** (`.covenant/canon/<dir>/…`),
projected to the executors, and reach the organization through the **existing**
per-row Publish action. Org-native transversal units (`required`/`offered`
push-down) remain out of scope — that is sub-project B of the Canon
detection/adoption design, and needs server work.

## Design

### 1. Backend — one command

`canon_new_unit(cwd, kind, name) -> String` (absolute path of the created file),
implemented in `crates/canon` with a Tauri wrapper.

- Slug via the existing `compile::slugify` — same normalization `adopt` uses, so
  `MyThing` → `mything` and the name is always a valid package name.
- Rejects an empty slug and rejects an existing path (no silent clobber).
- Writes a scaffold, one `match` arm per kind over the directory constants that
  already exist:

| kind | file | contents |
|---|---|---|
| agent | `.covenant/canon/agents/<slug>.md` | YAML frontmatter `name` / `description` + stub body |
| command | `.covenant/canon/commands/<slug>.md` | same |
| memory | `.covenant/canon/memory/<slug>.md` | same |
| skill | `.covenant/canon/skills/<slug>/SKILL.md` | same |
| mcp | `.covenant/canon/mcp/<slug>.json` | `McpServer { type: "stdio", command: "", args: [] }` serialized |

- Runs `project(repo_root)` afterwards — same tail as `adopt`, so the executor
  sees the new unit immediately.
- `spec` and `context` are **not** accepted by this command (Specs routes to the
  Spec Creator, see §5; Context already has its own "New context" head action).

### 2. UI — a head action per section

`renderSection` generalizes the branch Context and Skills already have. For
`agents / commands / mcp / memory / skills` the section header gets a `+ New`
button that toggles an **inline bar** reusing the `.canon-import-bar` chrome:
a name input + Create. On submit:

`canonNewUnit(cwd, kind, name)` → `onOpenFile(path)` → the cockpit closes and
the file opens in the editor via `manager.openFileAtLine` (already wired for
specs in `main.ts`).

The five empty states gain the `action` that `emptyState()` already supports,
pointing at the same flow — they stop being dead ends.

**Skills collision.** That section's head action already toggles the skills.sh
import bar. One input serves both: a value containing `/` is treated as an
`owner/repo --skill name` import (existing path), anything else is a new skill
name. The placeholder states both forms.

### 3. Owner gate

The `+ New` action renders when `groupRootDir` is set **and**
(`activeOrg() === null` **or** `activeOrg().role === "owner"`).

Gating strictly on `role === "owner"` would lock out anyone working without an
organization — or whose org fetch failed (`orgsFetched === false`) — from
authoring a file in their own repo. The rule is therefore: *inside an org, only
owners; with no org, it's your repo and you may.* This is a surface gate, not a
security boundary — the file is writable outside the app regardless.

### 4. Publishing to the organization

No new code. Once the unit is created and edited, its row already carries the
Publish action (`unitPublishAction`) that pushes it to the org registry. Create
does **not** auto-publish: publishing an empty stub would burn a useless version
into the registry. The post-create toast says so:
`Created <name> — publish it to <org> when it's ready.`

Memory and Specs stay repo-local; the registry rejects those kinds on both
sides, unchanged.

### 5. Specs

No scaffold. The Specs head action opens the existing immersive Spec Creator,
passing `cwd = groupRootDir` of the cockpit's group (the creator already renders
the "Agent grounded in \<cwd\>" chip) and `canonContext: true`, so the session is
scoped to the repo being worked on rather than starting generic over the active
workspace.

## Verification

- Rust unit test for `new_unit`: five kinds produce the expected paths, a
  duplicate name is rejected, `MyThing` slugifies to `mything`.
- Vitest: the owner gate (owner / member / no org) and the Skills input routing
  (`/` → import, otherwise → create).
- Live check in the dev app via DOM dump for one kind end-to-end.

## Files

`crates/canon/src/*` (new-unit writer), the Tauri command module, `ui/src/api.ts`,
`ui/src/canon/cockpit/view.ts`, `ui/src/main.ts` (two `CanonCockpitView`
construction sites).
