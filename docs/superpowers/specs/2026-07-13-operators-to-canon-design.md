# Operators move to Canon — design

**Date:** 2026-07-13
**Status:** Approved (brainstorm with Karluiz)

## Summary

Operators leave Settings and become org-scoped citizens of the Canon. The
standalone operator Marketplace tab dies; discovery/install folds into the
cockpit's registry section. Settings keeps only AOM. The existing Canon
"Agents" kind (repo-level subagent files under `.covenant/canon/agents/`) is
relabeled **Subagents** to end the naming collision.

## Decisions (locked)

| Question | Decision |
|---|---|
| Scoping | Operators become **org-scoped** entities shown in Canon |
| Marketplace | Folds into cockpit **registry** section as a kind toggle (Skills \| Operators) |
| Migration | Existing operators land in the **personal org** — via NULL sentinel, no data rewrite |
| Settings | Only **AOM** remains, promoted to its own section |
| Persistence | **Local + `org_slug`** column; server only for publish/install (like skills) |
| Naming | Cockpit/canon "Agents" → label **"Subagents"**; internal kind + dir unchanged |

## 1. Data model & backend

- `operators` table gains `org_slug TEXT NULL`.
  **NULL = personal org** (sentinel). No migration write; every existing
  operator is personal by definition.
- `operator_list` gains an optional org filter (`org_slug: Option<String>`,
  `None` = personal). `operator_create` / `operator_create_from_soul` accept
  `org_slug`.
- SOUL.md is untouched. Org membership is registry metadata (like
  `is_default`), not part of the persona.
- `is_default` stays **global** in v1. Known wrinkle: the default operator may
  belong to a non-active org and thus be invisible in the current roster view.
  <!-- ponytail: global default; make per-org when it hurts -->

Touched: `crates/app/src/storage.rs` (column + filter),
`crates/app/src/operator_registry.rs` (command params), `ui/src/api.ts`
(`Operator.org_slug`, wrapper params).

## 2. Canon UI

### Rail panel (`ui/src/canon/panel.ts`)
- Census strip gains an **Operators** cell; a new fold lists operator rows
  (avatar, name, tags) using the existing `railRow` idiom.
- Filtered by the active org; no active org → personal.
- Row click → cockpit operators section; row action → edit (immersive
  creator).

### Cockpit (`ui/src/canon/cockpit/view.ts`)
- New `SectionKey: "operators"`, placed above the existing `agents` section.
- Roster card grid, same actions as today: edit / duplicate / publish /
  delete, plus **New operator** → immersive creator.
- `agents` section header relabeled **Subagents** ("Repo-level subagent
  definitions projected into executor context"). `crates/canon/src/kind.rs`
  `label()`: `Agent` → `"Subagent"`. Internal enum, serde name, and the
  `.covenant/canon/agents/` dir do NOT change.

## 3. Immersive creator relocation

- `openOperatorModal` (+ its render helpers) and `operator-creator.css` move
  from `ui/src/settings/` to `ui/src/operator/` (alongside `avatars.ts`,
  `persona-composer.ts`).
- Gains an org param: creates/edits within the active org (personal when
  none).
- Same code otherwise — pure relocation + one parameter.

## 4. Marketplace → cockpit registry

- Cockpit registry section gains a kind toggle: **Skills | Operators**.
- Reuses existing publish/install APIs (`marketplacePublish` etc.).
- `ui/src/settings/operator_marketplace.ts` (standalone `MarketplacePanel`)
  is deleted; its list/install rendering folds into the registry section.
- Publish stays reachable from the operator card in the cockpit.

## 5. Settings teardown

- Delete `sec-operators`, `OperatorsPane`, and `LegacyOperatorsPane` from
  `ui/src/settings/panel.ts` / `operators.ts`.
- AOM becomes its own settings section, nav label **"Autonomous Mode"**.
- Any deep links to settings→operators (operator chip, spawn UI, etc.)
  redirect to the cockpit operators section.

## Error handling

- Unknown/stale `org_slug` (org deleted server-side): the operator surfaces
  in the personal roster with an "unassigned" badge so nothing silently
  disappears; editing it there reassigns (or clears) the slug.
- Offline / not logged in: org list unavailable → everything behaves as
  personal (NULL filter), matching today's behavior.

## Testing

- **Rust:** storage test for the new column + org filter (list scoped vs
  personal-NULL); registry command param tests; `kind.rs` label test update.
- **TS (vitest, repo root):** cockpit operators section renders roster;
  registry kind toggle switches lists; rail fold renders operator rows.
- **Live verify:** DOM-dump flow (per memory: osascript blocked) — census
  cell, fold, cockpit section, creator opens with org context, settings
  section gone, AOM intact.

## Out of scope

- Server-side roster sync between org members.
- Per-org default operator.
- Moving AOM out of Settings.
- Projecting operators as canon context (compile/projection pipeline).
