# Ship eval definitions inside the package

> Design. Written 2026-08-01, immediately after
> `2026-08-01-cdlc-eval-plan-b-design.md` shipped with a corrected label.
> Read that spec's **Correction** section first — this one exists to retire it.

## Problem

Plan B pushes eval results to the org registry and shows them on the package
card. The card had to say **"12/14 eval runs"** rather than "12/14 evals",
because the number is not a suite pass-rate. Two facts force that:

- **Eval definitions never travel with the package.** `read_skill_package`
  reads exactly `skill.toml` and `SKILL.md` (`crates/canon/src/install.rs:172-176`);
  `install_from_dir` writes exactly those two (`install.rs:124-125`). Evals are
  hand-authored per machine under `.covenant/canon/skills/<skill>/evals/*.toml`,
  and `.covenant/` is gitignored, so they do not travel between clones either.
- The result row key is `(package_id, github_id, eval_id)`, so the total counts
  (person × eval) pairs. Two members each running seven evals sum to 14.

So the aggregate blends private, uncoordinated suites. Two members' `e1` are
unrelated tests. The number is real — people did run those evals and they did
pass — but it measures *activity*, not *conformance*.

That is a genuine loss. The whole argument for evals (`docs/canon-context-is-the-new-code.md`,
the Evaluate phase) is that context should not ship on a vibe check. A suite
that cannot be shared is a vibe check with a number attached.

## Decision

Eval definitions become part of the package. Publishing a skill carries its
`evals/*.toml`; installing it lays them down beside `SKILL.md`. Everyone who
installs `kyc-peru@2.1.0` runs the same suite, so `count(*)` over a member's
rows is bounded by the suite size and the aggregate finally means what the
original spec claimed.

Two consequences fall out and both are wanted:

- **A published eval is reviewable.** Today nobody but the author ever sees an
  eval. Once it is in the package it goes through the same publish path as the
  skill body, and a reviewer can read what the skill claims to be tested on.
- **The card can say "evals" again**, and a per-eval breakdown across the org
  becomes meaningful for the first time — `flags-pep-match` failing for six of
  nine members is a sentence about one shared test. Plan B rejected that view
  precisely because it would have been noise; here it is signal. Still out of
  scope for this spec.

## Package format

`skill.toml` + `SKILL.md` becomes `skill.toml` + `SKILL.md` + zero or more
`evals/<id>.toml`. The `Eval` shape is unchanged (`crates/canon/src/eval.rs`):
`id`, `scenario`, `rubric`.

The wire format is the open question, and it is the one thing worth deciding
carefully, because `cdlc_packages` stores the package as two `TEXT` columns
(`skill_toml`, `skill_md`) and every deployed client reads exactly those.

**Recommended: a third nullable column `evals_toml TEXT`,** holding the eval
files concatenated into one TOML document under an array-of-tables:

```toml
[[eval]]
id = "rejects-expired-doc"
scenario = "..."
rubric = "..."

[[eval]]
id = "flags-pep-match"
scenario = "..."
rubric = "..."
```

Why one column and not a new table or a tarball:

- **Old clients keep working with zero effort.** They select
  `skill_toml, skill_md` by name and never see the new column. A package
  published with evals installs cleanly on a client that predates this change —
  it just gets no evals, which is exactly today's behavior.
- **A new client installing an old package** sees `NULL` and writes no
  `evals/` directory. Same outcome, no branch.
- It reuses the existing size cap and the existing `sha`/`signer` story rather
  than inventing a second integrity surface.

Rejected: a `cdlc_package_evals` child table (correct-looking, but it makes
publish a multi-statement transaction and resolve a join, for data that is only
ever read as a whole); a base64 tarball (opaque, unreviewable in the registry
UI, and the thing we most want is for evals to be *readable*).

Cap `evals_toml` at 256 KiB, matching `skill_md`.

## Changes

| Where | What |
|---|---|
| `covenant-server` | migration: `ALTER TABLE cdlc_packages ADD COLUMN evals_toml TEXT`; `PublishReq` and `PkgFull` gain `evals_toml: Option<String>`; the publish size check covers it |
| `crates/canon` | `read_skill_package` returns the evals document; `install_from_dir` writes `evals/<id>.toml` per entry; a new `read_evals_doc` / `write_evals_doc` pair for the concat/split |
| `crates/app` | `canon_publish` sends it; the registry install path passes it through |
| `ui` | `evalChip` says `evals` again; the package preview shows the eval ids the package carries |

## The two hard parts

**Splitting and rejoining is lossy if done naively.** `evals/<id>.toml` files
are authored by hand and may carry comments and formatting. Concatenating into
`[[eval]]` and writing back produces canonical TOML, so a publish→install round
trip does not return byte-identical files. That is acceptable — the round trip
preserves the three fields that define an eval — but it must be stated, because
the alternative (preserving bytes) means a tarball and gives up readability.
`id` collisions within one package are a publish-time `400`.

**Local edits versus installed evals.** After this change a skill directory can
hold evals that came from the package *and* evals the user wrote locally. The
run loop reads the directory, so both run, and both get pushed — reintroducing
the incomparability this spec exists to remove.

The lazy fix that actually holds: mark package-provided evals. Write them with
a `source = "package"` key; `read_evals` keeps returning all of them (local
evals are useful and should still run), but **only `source = "package"` results
are pushed to the registry.** One field, one filter in `push_results_for`, and
the org aggregate is once again a statement about one shared suite while local
evals stay a private tool. Everything else — a separate directory, refusing to
run local evals, a merge UI — is more machinery for the same outcome.

## Testing

| Where | What |
|---|---|
| `crates/canon` | round trip: three eval files → document → three files, fields preserved; duplicate `id` rejected; a package with no evals writes no `evals/` directory |
| `crates/canon` | `push_results_for` sends only `source = "package"` results when both kinds are present — this is the property the whole spec turns on |
| `covenant-server` | `#[sqlx::test]`: publish with evals then resolve returns them; publish without leaves `NULL`; the 256 KiB cap rejects |
| `covenant-server` | an old-client `SELECT skill_toml, skill_md` still succeeds against a row that has `evals_toml` |
| `ui` | the card renders `evals` and the preview lists the package's eval ids |

## Out of scope

- Per-eval breakdown across the org (now meaningful — but a separate surface)
- Running an installed package's evals automatically on install
- Signing or sandboxing eval scenarios beyond what the skill body already gets;
  an eval scenario is a prompt handed to an agent in the existing throwaway
  sandbox, so it inherits that posture rather than needing a new one
- Migrating existing local evals into packages — authors republish when ready
