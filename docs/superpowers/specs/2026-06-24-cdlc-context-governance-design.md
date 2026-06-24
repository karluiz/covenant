# CDLC — Context Development Life Cycle inside Covenant

**Date:** 2026-06-24
**Status:** Design approved, Phase 1 scoped
**Work front:** Context Governance (anchor companies: Mibanco, Pacífico Seguros)

---

## Problem

The implicit knowledge of an anchor company — code standards, patterns, and
especially the **regulatory context** that governs Peruvian banking/insurance —
lives in people's heads and dead wikis. There is no lifecycle for *context* the
way there is for code. CDLC is that lifecycle, and Covenant is the instrument
that measures it.

CDLC has four work fronts:

- **Generate** — extract implicit knowledge into structured context specs.
- **Evaluate** — TDD-style scenarios over the *context* (not the code).
- **Distribute** — a shared skills/context library; one team publishes, others install.
- **Observe/Adapt** — the continuous-improvement loop, fed by Covenant telemetry.

### The Covenant hook (why this is a moat)

Covenant's four primitives — **Spec, Prompt, Commit, LLM Call** — are literally
the measurement instrument of the CDLC. This is the layer LinearB cannot be:
telemetry at the level of **context and inference**, not the level of the PR.
It reinforces the supplier-evaluation thesis — Copilot gives you autocomplete,
not *audited context governance*.

## Current state (what Covenant already provides)

Covenant already implements ~60% of the CDLC. Confirmed by codebase survey:

| Front | Today | Gap |
|---|---|---|
| **Generate** | Spec Creator — `crates/agent/src/spec_author.rs` + `ui/src/spec-chat/`, per-repo, emits `docs/specs/*.md` | Point it at the CDLC context dir; regulatory extraction is prompt-shaping |
| **Evaluate** | Score crate — 4 primitives instrumented, per-group/repo/branch telemetry (`crates/score/`), achievements | "TDD over context" (behavior under context) has no runner yet → **Phase 2** |
| **Distribute** | **Nothing** — no publish/install, no shared library | **The Phase 1 build** |
| **Observe/Adapt** | Familiar rolling summary (`ui/src/familiars/`), **per-session only** | No group-level learning loop → **Phase 3** |

## Decisions (locked)

1. **Source of truth = committed repo artifact** `.covenant/cdlc/` + a per-group
   UI panel that is a view over it. Portable, diffable, PR-reviewable,
   git-shareable between separate orgs. The bank *owns* its context asset; it is
   not locked inside Covenant's DB.
2. **Distribute = hosted Covenant registry** (`registry.covenant.uno` on
   covenant-server). `publish`/`install`, versioned, signed, with adoption
   telemetry. This is the cross-anchor-company moat.
3. **Evaluate = behavior-under-context (real TDD)** — a scenario is run through
   an agent *with* the context loaded; assert the output/command is compliant.
   Red without the skill, green with it. Every run is 4-primitive telemetry.
   **Deferred to Phase 2.**
4. **Build order = Skeleton + Distribute first.** Lead with the moat and the
   cross-org story (the artifact that makes the anchor-company conversation real).
5. **Executors learn CDLC via projection, not a custom injection layer.** On
   install, each executor's *native* instruction file is generated from the
   installed skills. Always-on — correct for a regulatory floor. Operator
   relevance-injection is **Phase 2**.

---

## Phase 1 architecture — Skeleton + Distribute

### 1. The artifact: `.covenant/cdlc/` (per repo, committed)

```
.covenant/cdlc/
  cdlc.toml          # loop state, provenance, installed refs
  context/           # Generate output (markdown specs)
    kyc-peru.md
  skills/            # published/installed packages
    kyc-peru/
      skill.toml     # name, version, owner, signer, sha, deps
      SKILL.md       # the context payload (markdown + frontmatter)
  cdlc.lock          # resolved versions (package-lock style)
```

- **TOML** matches Covenant convention (`tauri.conf`, `Cargo`). **Markdown**
  payload matches the superpowers skill format (audit-friendly, and 1:1 with
  Claude Code skill files for projection).
- No new file format is invented.

`cdlc.toml` (sketch):
```toml
[cdlc]
version = 1

[[installed]]
name = "kyc-peru"
version = "2.1.0"
source = "registry.covenant.uno"
sha = "…"
signer = "github:mibanco-platform"
installed_at = "2026-06-24T…"
```

### 2. Per-group panel: `ui/src/cdlc/`

Clone the `ProjectNotesPanel` pattern verbatim (`ui/src/project-notes/panel.ts`):
`CDLCPanel({ groupId, groupLabel, groupColor, groupRootDir })`, mounted as a
singleton in `main.ts`, opened via the rail + a keyboard chord, reads
`.covenant/cdlc/` from `groupRootDir`. Three sections:

- **Context** (Generate) — lists `context/*.md`; "New" opens the **existing Spec
  Creator** with output path forced to `.covenant/cdlc/context/`. Reuse, do not
  rebuild.
- **Skills** (Distribute) — installed packages + version + source + adoption
  status; **Publish / Install / Update** actions → registry.
- **Loop** (Observe) — Phase-3 placeholder, read-only telemetry view.

Keyboard chord: pick a free binding (⌘⇧C = Changes, ⌘⇧G taken). **Detail to
confirm during implementation, not hard-committed here.**

### 3. Registry: `registry.covenant.uno` (covenant-server)

covenant-server already runs axum on Pulzen with `covenant-pg`. Add:

- `POST /cdlc/packages` — publish; auth by existing `github_id`, owner-scoped;
  stores manifest + payload + sha + signer.
- `GET /cdlc/packages/:name/:version` — resolve/install with dependency tree.
- `GET /cdlc/packages?q=` — cross-org search (the shared library).
- Install events recorded → adoption metric per package.

**Storage:** package blobs in **pg `bytea`** for v1.
`// ponytail: bytea blobs; move to object store if packages get large.`

**Trust:** separate orgs → packages **signed by Covenant identity** (`github_id`)
+ sha recorded on publish, verified on install.
`// ponytail: identity+sha provenance for v1; cosign-style keypairs when an auditor demands it.`

### 4. Tauri commands → `crates/app` + `ui/src/api.ts`

`cdlc_local_status(group)`, `cdlc_publish(group, package)`,
`cdlc_install(group, name, version)`, `cdlc_search(query)`. UI calls typed
wrappers in `api.ts`. No standalone CLI.
`// ponytail: UI-driven; add a covenant cdlc CLI when CI needs it.`

### 5. Executor projection (how agents "know" CDLC)

On `cdlc_install`, after writing the canonical `.covenant/cdlc/skills/<pkg>/`,
generate each executor's **native** instruction file from it:

| Executor | Native path | Written |
|---|---|---|
| `claude` | `.claude/skills/` | `.claude/skills/cdlc-<pkg>/SKILL.md` (1:1, payload is already skill-format) |
| `codex` | `AGENTS.md` | managed block (delimited, regenerated) |
| `copilot` | `.github/copilot-instructions.md` | managed block |
| `pi` / `hermes` | their instruction file | managed block |

Managed blocks are delimited (`<!-- cdlc:start --> … <!-- cdlc:end -->`) so
regeneration is idempotent and never clobbers hand-written content. Projection
is deterministic; whether the generated files are committed or `.gitignore`'d +
regenerated-on-install is a per-repo choice (default: committed, for full audit).

Executors discover CDLC through the exact mechanism they already use for repo
instructions. Zero runtime coupling.

### 6. Telemetry hook (the Covenant gancho)

- Add `EventKind::CdlcInstall` to `crates/score/src/types.rs`; record install
  events keyed by existing `Context { repo, branch, group_name, workspace }`.
- Tag LLM calls that loaded a CDLC skill (best-effort, via projection presence).
- Registry surfaces **adoption per package across orgs** — context-level
  telemetry, not PR-level. This is the moat made literal.

> Caveat: projection proves a skill is *available*, not *used*. For Phase 1,
> "installed/projected" is the adoption signal. Proving the context actually
> steered behavior is exactly what the Phase-2 eval runner provides.

### 7. Data flow

```
Spec Creator → context/*.md → package → cdlc_publish → registry (signed, versioned)
  → other org: cdlc_install → .covenant/cdlc/skills/ (committed)
      → projection writes .claude/skills, AGENTS.md, copilot-instructions
  → executor LLM calls load skill → score telemetry tags usage
  → registry shows adoption
```

---

## Scope

**IN (Phase 1):** `.covenant/cdlc/` manifest, per-group panel, Generate wired to
existing Spec Creator, registry publish/install/search, install telemetry,
identity+sha signing, executor projection (claude/codex/copilot/pi/hermes).

**OUT (Phase 2+):**
- Agent-TDD eval runner + behavior pass-rate metric (**Phase 2**).
- Operator relevance-injection of task-matched skills (**Phase 2**).
- Observe/Adapt auto-loop, group-level learning (**Phase 3**).
- Keypair/cosign signing; object-store blobs; standalone CLI.

## Testing

- **Rust:** `cdlc.toml`/`skill.toml` read-write roundtrip; registry
  publish→install→resolve; signer/sha verify; projection managed-block
  idempotency (regenerate twice = no diff).
- **TS:** panel renders from a fixture `.covenant/cdlc/`; Publish/Install/Update
  actions call the `api.ts` wrappers. Run vitest/tsc from the **repo root**, not
  `ui/`.

## Risks / open ceilings

- **bytea blobs** — fine until packages carry binary assets or grow large.
- **identity+sha provenance** — sufficient for v1 audit; a real auditor will
  eventually want keypair signatures.
- **adoption ≠ usage** — Phase 1 measures availability; behavior proof needs
  Phase 2.
- **projection drift** — hand edits inside managed blocks are lost on
  regenerate; delimiters + a one-line warning mitigate.
