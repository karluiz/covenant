# Evals for every kind, not just skills

> Design. Written 2026-08-02.
> Prior art: `2026-06-26-cdlc-eval-runner-plan-a.md` built the runner,
> `2026-08-01-cdlc-eval-plan-b-design.md` made its results org-wide.
> Both assumed the unit under test is a skill.

## Problem

The Evaluate phase only reaches one of Canon's seven kinds.

A repo's Canon holds subagents, commands, MCP servers, memory, context, specs
and skills. Five of those are text that ends up inside an executor's prompt, so
five of them can be wrong in the way an eval catches: the model reads them and
behaves badly anyway. Only skills can be evaluated.

That is backwards for this repo in particular. Covenant's own Canon has **zero
skills and three commands** — `horizon`, `green`, `verify-live`. The release
ritual is the most consequential piece of procedural context here; its own text
records two production incidents it exists to prevent (a BSD-sed silent failure
that nearly tagged mismatched manifests, and an unstaged `package-lock.json`
that shipped a release whose npm lockfile lied about its version). Those
incidents are exactly what an eval is for, and today there is nowhere to put
them.

The runner is wired to skills in four places:

| Where | What assumes "skill" |
|---|---|
| `crates/canon/src/eval.rs` | `read_evals` reads `.covenant/canon/skills/<skill>/evals/` |
| `crates/canon/src/eval.rs` | `eval-results.json` is keyed by bare name |
| `crates/app/src/canon_eval.rs` | `prepare_sandbox` hand-writes `.claude/skills/canon-<skill>/SKILL.md` and errors without `SKILL.md` |
| `crates/app/src/canon_eval.rs` | `push_results_for` resolves the registry package with the literal kind `"skill"` |

Plus the UI, which only offers "Run evals" on skill rows.

## Decision

Make the runner kind-generic across every kind that gets projected into a
prompt: **skill, command, agent, context, memory.**

Out: **mcp** — it is a connection, not context. Its `.json` is a command line
and an env block; evaluating it means starting the server and testing *that*,
which is a different product. **spec** — `projectable: false`, it never reaches
a model at all.

Chosen over doing commands alone. The four coupling points cost the same to
unpick for one kind as for five, and stopping at commands leaves the runner with
two special cases instead of one — the next kind reopens the same four files.

## 1. Where evals live

One tree, keyed by kind:

```
.covenant/canon/evals/<kind>/<name>/*.toml
```

`evals/command/horizon/bumps-all-five-manifests.toml`,
`evals/skill/kyc-peru/rejects-expired-doc.toml`,
`evals/memory/decision-x/recalls-the-date.toml`.

`<kind>` is `ContextKind`'s serialized lowercase name (`skill`, `command`,
`agent`, `context`, `memory`) — not `ContextKind::dir()`, whose values are
pluralized directory names and which carries the `docs/specs` special case. The
eval tree is its own namespace and should not inherit that quirk.

**This moves skill evals** from `skills/<name>/evals/` to `evals/skill/<name>/`.
No back-compat read of the old path: a filesystem sweep of `~/Sources` found no
`eval-results.json` anywhere and exactly one evals directory — the `horizon`
one written while designing this. There is nothing to migrate, and a
compatibility path nobody exercises is a path nobody maintains.

Consequence to accept: `2026-08-01-canon-package-evals-design.md` (the follow-up
that ships evals inside a published package) names `skills/<skill>/evals/` as
its source. That spec is designed and unbuilt; this one updates its path
reference as part of the work rather than leaving two specs disagreeing.

### Why not next to the source

Keeping `evals/` inside each unit's own directory is the obvious alternative and
it has one real advantage: deleting the unit takes its evals with it. But it
only works for skills, which are the one kind that *has* a directory. Every
other kind is a single file, so it would need an invented sibling convention
(`commands/horizon.evals/`), and the result is two layouts to remember instead
of one.

The deciding factor is elsewhere. `eval-results.json` is
`BTreeMap<String, BTreeMap<String, EvalResult>>` keyed by bare unit name. Once
more than one kind can be evaluated, two units can share a name — this repo has
a command named `green`, and nothing stops a skill named `green` — and their
results would silently merge into one bucket. The key must gain a kind. With the
tree above, **the results key and the path are the same string**: `command/horizon`.
One concept, not two that must be kept in sync.

Orphans are the cost: deleting a command leaves its eval directory behind.
`delete_unit` removes it, and an orphan is trivially visible anyway — an eval
tree entry with no corresponding source.

## 2. How the unit reaches the sandbox

This is the part that decides whether the change is small or sprawling.

Today `prepare_sandbox` writes the projection by hand:

```rust
let skill_dir = sbox.path().join(".claude/skills").join(format!("canon-{skill}"));
std::fs::write(skill_dir.join("SKILL.md"), body)?;
```

Generalizing that by hand means re-deriving, per kind, where each thing goes —
`.claude/agents/` for a subagent, `.claude/commands/` for a command, and for
memory and context the managed block inside `AGENTS.md`, which is the genuinely
fiddly one.

None of that needs writing, because `crates/canon/src/project.rs` already does
it for all seven kinds and is the code that produces the real thing. So:

1. Copy the unit under test into `<sbox>/.covenant/canon/<ContextKind::dir()>/…`
2. Call `karl_canon::project(<sbox>)`
3. Write the deny-list `settings.json` at `<sbox>/.claude/settings.json`

`prepare_sandbox` **loses** its hand-rolled write instead of gaining five
branches, and it stops being able to drift from real projection.

Two things this buys beyond brevity:

- **The eval tests the unit as projected, not as authored.** A context doc is
  synthesized into a skill with generated frontmatter; a memory becomes a
  bullet inside a managed block. What reaches the model is the projection, and
  that is now what the eval measures.
- Memory and context work with no extra code, and they are the two kinds a
  hand-rolled version would have gotten wrong.

Order matters: write `settings.json` **after** `project()`. Projection does not
touch `.claude/settings.json` today — verified, it writes agent, skill and
command directories plus the managed blocks — but the deny-list is the sandbox's
only real safety boundary, and it should not depend on a future projection
target never claiming that filename.

The baseline arm (`prepare_sandbox_bare`) is unchanged: an empty temp dir with
the same `settings.json`, no Canon at all.

## 3. What gets renamed

| Before | After |
|---|---|
| `read_evals(repo_root, skill)` | `read_evals(repo_root, kind, name)` |
| `write_result(repo_root, skill, r)` | `write_result(repo_root, kind, name, r)` |
| `pass_rate(repo_root, skill)` | `pass_rate(repo_root, kind, name)` |
| `canon_run_evals(cwd, skill)` | `canon_run_evals(cwd, kind, name)` |
| `EvalSkillSummary { skill, .. }` | `EvalUnitSummary { kind, name, .. }` |
| `prepare_sandbox(repo_root, skill)` | `prepare_sandbox(repo_root, kind, name)` |

`push_results_for` resolves the unit's real kind instead of the literal
`"skill"`. No server work: `cdlc::valid_kind` already accepts
`skill|agent|command|context|mcp`.

**Memory is not packageable** (`ContextUnit.packageable == false`), so its
results run locally and never push. That falls out of `parse_registry_source`
returning `None` for a unit with no registry source — no new branch, and it is
the same path a locally-authored skill already takes.

One defensive line in the results reader: a stored key with no `/` is read as
`skill/<name>`. There are no such keys on this machine, but eval history on
another one is not worth losing to save a line. Marked `ponytail:` with its
own removal condition.

## 4. UI

"Run evals" today appears on skill rows only (`ui/src/canon/panel.ts:604`,
`ui/src/canon/cockpit/view.ts:1870`).

The cockpit already shares `renderUnitSection` across agents, commands, mcp and
memory via `UNIT_SPECS`, so one row action there covers three of the five kinds.
Context has its own renderer (`renderContextSection`) and skills theirs
(`renderSkillsSection`); each gains the same action.

**`mcp` is in `UNIT_SPECS` and must not get the button.** It is the design's one
special case, so it is expressed as data rather than a conditional: `UnitSpec`
gains `evaluable?: true`, set on `agents`, `commands` and `memory` and absent on
`mcp`. A test asserts the button's presence per kind, mcp included as the
negative.

The Impact section's "Context lift" rows already read from the summary; they
show the unit's kind alongside its name so `green` the command and `green` the
skill are distinguishable.

## 5. Writing an eval for a non-skill kind

Worth stating because it changes how scenarios are phrased.

`harness_args` allows `Read`, `Grep` and `Glob` only, and the sandbox is an
otherwise-empty temp dir. The eval agent cannot create files, run `sed`, or
invoke `git`. Full-tool agentic runs wait on the hardened container that Plan A
deferred.

So for procedural context — commands especially — **the eval judges the plan,
not the execution.** A scenario must ask the model to *describe the exact
commands it would run*, and the rubric grades that description. "Run the release
ritual and show the resulting versions" cannot pass in this sandbox no matter
how good the command is.

The three `horizon` evals drafted while designing this are phrased as execution
and get rewritten as part of the work. They stay as the worked example: each one
encodes a real incident, and the rubrics name the specific failure (`FAIL if it
reaches for GNU sed's 0,/re/s//.../ idiom`) rather than the happy path.

## Testing

| Where | What |
|---|---|
| `crates/canon` | eval path resolves per kind; `read_evals` finds a command's evals and returns none for an unknown unit |
| `crates/canon` | results round-trip under a `kind/name` key; a legacy bare key reads as `skill/…`; two same-named units of different kinds do not merge |
| `crates/canon` | `delete_unit` removes the unit's eval directory |
| `crates/app` | `prepare_sandbox` for a **command** yields `.claude/commands/horizon.md` in the temp dir; for a **memory** yields the managed block inside `AGENTS.md`; `settings.json` survives `project()` |
| `crates/app` | `prepare_sandbox` for an unknown unit is an `Err`, as it is today for a missing `SKILL.md` |
| `ui` | the run-evals action renders for skill, command, agent, memory and context, and **not** for mcp |

The sandbox tests are the ones that matter: they are what proves the projection
reuse works, and they are cheap because `project()` is pure filesystem.

## Out of scope

- MCP evals — needs a running server, a different product
- Spec evals — specs are not projected
- Full-tool agentic eval runs — still waiting on the hardened container
- Shipping evals inside a published package — `2026-08-01-canon-package-evals-design.md`
- Any change to the judge, the baseline arm, or the registry push protocol
