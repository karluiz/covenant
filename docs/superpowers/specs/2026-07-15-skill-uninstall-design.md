# Local Skill Uninstall from Canon

**Date:** 2026-07-15
**Status:** Approved
**Repo:** `karlTerminal` (client-only — no server change)

## Problem

Canon can install and publish skills, but there is no way to remove a locally
installed skill from the UI. The Skills section rows carry only a Publish
button; deleting a skill today means manually `rm`-ing
`.covenant/canon/skills/<name>/`, editing `canon.toml`/`canon.lock`, and
hunting down the projected copies in `.claude/skills/` and `.pi/skills/`.

A second, latent problem blocks a correct delete: skill projection is
**additive**. `project_with_active` (project.rs) writes `canon-<name>/SKILL.md`
into each `SKILL_DIRS` entry but never removes a `canon-*` dir whose source is
gone. So removing the source and re-projecting would leave a stale projected
skill that executors still load.

## Scope

**Skills only.** Skills project under a `canon-<name>` namespace, so stale
projected dirs can be pruned unambiguously. Agents/commands project as bare
`<name>.md` (no namespace) and can't be told apart from the user's own files,
so auto-cleanup there is unsafe — out of scope. MCP already reconciles its own
`canon-` keys but is deferred with the rest. Registry unpublish is out of scope
(the server has no DELETE endpoint).

## Design

### canon crate

**1. Reconciling skill projection (`crates/canon/src/project.rs`).**
Add `prune_stale_skill_dirs(repo_root, keep: &HashSet<String>)`: for each dir in
`SKILL_DIRS` (`.claude/skills`, `.pi/skills`), remove every `canon-*`
subdirectory whose name is not `canon-<kept>` for a kept skill name. Call it in
`project_with_active` immediately before the `write_skill_dirs` loop, passing
the current installed skill names. This makes skill projection idempotent and
also cures the latent stale-projection bug for the normal re-export path. Only
touches `canon-`-prefixed dirs — never user files. A `SKILL_DIRS` entry that
doesn't exist yet is a no-op.

**2. `uninstall_skill(repo_root, name) -> Result<(), CanonError>`
(`crates/canon/src/install.rs`).** Mirrors `install_from_dir` in reverse:

- Reject invalid names via `valid_pkg_name` (path-traversal guard) — same gate
  install uses.
- Compute `dest = canon_dir(repo_root).join("skills").join(name)`; assert
  `dest.starts_with(skills_root)` (belt-and-suspenders, matching install).
- If `dest` does not exist AND the manifest has no entry for `name`, return
  `CanonError::InvalidPackage("skill not installed: <name>")` — nothing to do,
  surfaced as a clear error rather than a silent success.
- `std::fs::remove_dir_all(&dest)` (ignore NotFound so a manifest-only orphan
  still cleans up).
- Read manifest, `manifest.installed.retain(|i| i.name != name)`,
  `write_manifest` + `write_lock` (the existing private helper in this file).
- `project(repo_root)` — now prunes the stale `canon-<name>` projection and
  rebuilds the codex/copilot managed block from the reduced manifest.

### app crate

`canon_uninstall_skill(cwd: String, name: String) -> Result<(), String>`
(`crates/app/src/lib.rs`): `spawn_blocking` → `karl_canon::uninstall_skill`,
map errors to strings. Register in the `generate_handler!` list next to
`canon_install_registry`. No score event.

### api.ts

```ts
export async function canonUninstallSkill(cwd: string, name: string): Promise<void> {
  return invoke<void>("canon_uninstall_skill", { cwd, name });
}
```

### UI (`ui/src/canon/cockpit/view.ts` `renderSkillsSection`)

Each skill row already builds an `actions` array (currently the Publish
button, conditionally). Append a trash button to every skill row
(unconditional — you can always uninstall a local skill):

```ts
const del = iconButton(Icons.trash({ size: 15 }), "Uninstall skill", () => {
  if (!confirm(`Uninstall skill "${i.name}"? Removes it from this repo and every executor projection.`)) return;
  errorEl.hidden = true;
  del.disabled = true;
  void canonUninstallSkill(cwd, i.name)
    .then(load)
    .catch((e) => {
      errorEl.hidden = false;
      errorEl.textContent = this.friendlyError(e);
      del.disabled = false;
    });
});
actions.push(del);
```

`load` (the section's existing reload closure) and `errorEl` are already in
scope. Order the actions Publish-then-Trash (Publish first when present).
`Icons.trash` exists in `ui/src/icons/index.ts` — use it.

## Testing

- **canon (`install.rs` tests):** install a skill, `uninstall_skill`, assert the
  source dir is gone, the manifest no longer lists it, and the projected
  `.claude/skills/canon-<name>` dir is gone. Uninstalling an absent skill
  returns an error.
- **canon (`project.rs` tests):** with a stale `.claude/skills/canon-ghost` dir
  present and `ghost` NOT in the manifest, `project` removes it while keeping a
  legitimately-installed skill's projected dir and any non-`canon-` user dir.
- **UI (vitest):** a skill row renders a trash button; clicking it (with
  `confirm` stubbed true) calls `canonUninstallSkill` with the name and reloads;
  `confirm` false does nothing.

## Out of scope

- Uninstall for agent/command/context/mcp kinds (projection-namespace redesign).
- A trash button in the rail panel (`panel.ts`) — follow-up.
- Registry unpublish (no server endpoint).
