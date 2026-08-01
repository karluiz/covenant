# Eval Plan B — cross-org pass-rate on the registry card

> Design. Written 2026-08-01. Plan A (the local runner) shipped in
> `docs/superpowers/plans/2026-06-26-cdlc-eval-runner-plan-a.md` and declared
> this out of scope: *"Registry push (`POST /cdlc/evals`, cross-org pass-rate)
> is Plan B. The runner must emit a registry-ready `EvalResult { eval_id, pass,
> ran_at_ms }` so Plan B can POST without changing the runner."* It does. This
> spec spends that credit.

## Problem

Canon's four phases are Generate → Evaluate → Distribute → Observe. Three of
them are org-wide: the registry distributes, the roster syncs, Impact reads
org-level telemetry. **Evaluate is the one that stops at your laptop.** You run
evals on a skill you installed from your org's registry, the judge says 3/5,
and that number dies in `.covenant/canon/eval-results.json`. The next person to
install that same skill learns nothing from your run, and the person who
published it never finds out their skill fails two thirds of the time.

That is exactly the failure Debois names in *Context Is the New Code*: context
is a team asset, and an evaluation nobody else can see is a vibe check with
extra steps.

## Decision

Push pass/fail results to the org registry, and show the aggregate on the
package card. **Registry card only** — no new read endpoint, no new view, no
fold-back into Impact. Chosen over two richer surfaces (a lift comparison in
the Impact section, a per-eval breakdown view) because they both need a second
fetch and a new endpoint to answer a question nobody has asked yet. The card is
where the decision *to install* gets made, so it is where the number pays.

Rejected: storing results in `score_events`. That table is keyed by user and
group; there is no `package_id` to join on, and inventing one would be a worse
version of the table below.

## Data model — `covenant-server`, `migrations/0016_cdlc_evals.sql`

```sql
CREATE TABLE cdlc_evals (
  package_id    BIGINT  NOT NULL REFERENCES cdlc_packages(id) ON DELETE CASCADE,
  github_id     BIGINT  NOT NULL REFERENCES users(github_id),
  eval_id       TEXT    NOT NULL,
  pass          BOOLEAN NOT NULL,
  baseline_pass BOOLEAN,
  ran_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (package_id, github_id, eval_id)
);
```

Two properties carry the whole design:

**The primary key means upsert, not history.** The last run of a given eval by
a given person on a given package version replaces the previous one. Without
that, `12/14` becomes a counter that only ever grows — you fix a skill, re-run,
and the aggregate does not move because the old failures are still in the
table. Nobody would trust it twice. There is no audit trail of past runs and
that is deliberate; the question the card answers is "does this work *now*",
not "what happened in June".

**`package_id` is version-scoped**, because `cdlc_packages` has one row per
`(org, kind, name, version)`. Results therefore belong to a version, and
publishing a new version starts from an empty aggregate. Correct: v1 results
say nothing about v2. It is also the same granularity as `installs`, which
already lives on that row, so the two numbers on the card are consistent with
each other.

`baseline_pass` rides along because the runner already computes it (the
without-skill arm, `EvalResult.baseline_pass`). Nothing reads it yet. It is one
nullable column and dropping it would mean a second migration the day someone
wants org-level lift; keeping it costs nothing and requires no client change
later.

## Write path — `POST /cdlc/packages/:id/evals`

Member-gated, using the same `allowed` CTE `record_install` already uses
(`src/cdlc.rs`) — so the existing 404-if-absent / 403-if-not-a-member
distinction comes for free rather than being re-derived.

Request:

```json
{"results": [
  {"eval_id": "rejects-expired-doc", "pass": true,  "baseline_pass": false, "ran_at_ms": 1754006400000},
  {"eval_id": "flags-pep-match",     "pass": false, "baseline_pass": null,  "ran_at_ms": 1754006400000}
]}
```

Response: `{"ok": true, "stored": 2}`.

Validation, all `400 Bad Request`:

- `results` empty or longer than 200 entries
- any `eval_id` empty or longer than 128 chars

One `INSERT … ON CONFLICT (package_id, github_id, eval_id) DO UPDATE SET pass =
EXCLUDED.pass, baseline_pass = EXCLUDED.baseline_pass, ran_at = EXCLUDED.ran_at`
per row, inside one transaction. `ran_at` is derived server-side from the
client's `ran_at_ms` (`to_timestamp(ran_at_ms / 1000.0)`) so a clock-skewed
client cannot claim a future run — clamped to `now()` if it exceeds it.

**Not owner-gated.** Any member who runs evals contributes; that is the entire
point of a cross-org number. This is a deliberate difference from the operator
roster (owner-gated) and it follows the same rule org defaults follow: gate on
what auto-propagates. A roster entry syncs itself into every member's machine,
so it needs an owner. An eval result changes a number on a card. It does not.

**`reason` is never sent.** `EvalResult.reason` is free text an LLM wrote about
your repository while looking at a transcript of an agent working in it. It
stays on disk. The Plan A contract promised exactly `{ eval_id, pass, ran_at_ms }`
and this honors it, plus the boolean.

## Read path — no new endpoint

`search` (`GET /cdlc/packages?org=…&kind=…`) already returns `PkgMeta`, and the
registry cards already call it. The aggregate comes back on that same row:

```sql
LEFT JOIN LATERAL (
  SELECT count(*) FILTER (WHERE pass) AS eval_passed,
         count(*)                     AS eval_total
    FROM cdlc_evals e
   WHERE e.package_id = p.id
) ev ON true
```

`PkgMeta` grows `eval_passed: i64` and `eval_total: i64` (both `NOT NULL`,
zero when nobody has run anything). The `DISTINCT ON (name) … ORDER BY name,
created_at DESC` shape of the query is unchanged; the lateral join hangs off
each surviving row.

Consequence worth stating: the card shows the *latest published version's*
aggregate. Publish v2 and the number goes blank until someone runs evals
against it. That is the honest answer, not a bug.

Evals only exist for skills (`canon_run_evals` is skill-scoped), so
`eval_total` is structurally 0 for agent / command / mcp / context. The join is
kind-agnostic anyway; the UI simply never has anything to show for them.

## Client push — `karlTerminal`

At the end of `canon_run_evals` (`crates/app/src/canon_eval.rs`), after the
`done` progress event, one call that **cannot fail the run**:

1. `read_manifest(&repo_root)` → the `InstalledRef` whose `name == skill`.
   If there is none, or its `source` does not start with `registry:`, return.
   No network call for a locally-authored skill.
2. `parse_registry_source(&source)` → `Option<(org, name, version)>` from
   `registry:<org>/<name>@<version>`. **New pure function in `crates/canon`** —
   the only real logic in this change, and the only thing that needs a unit
   test on the client side.
3. `canon_registry::resolve(org, name, version, "skill")` → `PkgFull.id`. The
   function already exists; passing the pinned version (never `latest`) is what
   makes the results land on the row the user actually installed.
4. `POST` the results for that skill, read back from `eval-results.json` via
   `read_results`, mapped to the wire shape (dropping `reason` and
   `duration_ms`).

Every step failure is a `tracing::warn!` and nothing else. Offline, expired
JWT, deleted org, server not yet deployed → the evals already ran and are
already on disk. The user never sees an error for a side effect they did not
ask for.

Deploy order: server first. A client that ships early gets a 404 from
`POST /cdlc/packages/:id/evals`, warns, and moves on — the same tolerance the
operator roster pull already has.

## Consent

The "Run evals" confirm card (`ui/src/canon/evals.ts`) already gates the run on
cost. It gains one sentence:

> Pass/fail results are shared with your org's registry — never the judge's
> reasoning.

No new setting. The push only happens for skills the user installed *from that
same registry*, they are already a member of the org, and the payload is two
booleans and a timestamp. An opt-out toggle would be a settings bool if it is
ever asked for; adding it now would be a config for a value nobody has wanted
to change.

## UI

`renderRegistrySection` in `ui/src/canon/cockpit/view.ts` builds a `meta` line
and a `stats` chip row per card. For `wire === "skill"` with `eval_total > 0`,
the meta line gains one segment:

```
v2.1.0 · 14 installs · 12/14 eval runs · karluiz
```

Nothing when `eval_total === 0` — an empty `0/0 eval runs` would read as a
failure rather than as an absence.

**"eval runs", not "evals" — see the correction below.** The wording is load-
bearing, not a style choice.

## Testing

| Where | What |
|---|---|
| `crates/canon` | `parse_registry_source`: happy path, missing `@`, `local:` source, malformed org/name |
| `covenant-server` | pure validation of the request body (empty list, >200 entries, empty / oversized `eval_id`) |
| `covenant-server` | DB-backed via `#[sqlx::test(migrations = "./migrations")]`: re-running an eval **replaces** its row rather than adding one, two members' results both count, and the aggregate query returns the right `(passed, total)` |
| `ui` | registry card meta line with and without an eval aggregate |

The upsert is the property the whole design rests on, and it is a property of
the `ON CONFLICT` clause — a pure unit test cannot observe it. `org_defaults.rs`
already establishes the `#[sqlx::test]` pattern (spin up a scratch database,
run the migrations, seed a user + org + package), so this costs a `seed()`
helper, not a new harness.

## Correction — what the number actually means (2026-08-01, post-implementation)

The final whole-branch review caught a false premise in this spec's Problem
section. Recorded here rather than edited away, because the reasoning matters
more than the tidy version.

The Problem section says the publisher "never finds out their skill fails two
thirds of the time." That sentence assumes every org member runs **the same
eval suite** against the package. They do not, and nothing in the product makes
them. Verified three ways:

- `install_from_dir` writes only `skill.toml` and `SKILL.md` into the installed
  skill directory (`crates/canon/src/install.rs:124-125`). It never touches
  `evals/`.
- `read_skill_package`, the publish source, reads only those same two files
  (`crates/canon/src/install.rs:172-176`), so `canon_publish` cannot carry
  evals even if they existed.
- Nothing in `crates/` ever *writes* an eval `.toml`. They are hand-authored,
  per machine, under `.covenant/canon/skills/<skill>/evals/` — and `.covenant/`
  is gitignored, so they do not even travel between clones of the same repo.

Two members' `e1` are therefore unrelated tests. Compounding it, the row key is
`(package_id, github_id, eval_id)`, so `count(*)` counts **(person × eval)
pairs**: two members each running seven evals render a total of 14 for a skill
that has seven.

Everything built here is still correct for what it stores — the aggregate is
version-scoped, the upsert replaces, the push is best-effort, and the judge's
reasoning stays local. What was wrong was only the label. Hence **"12/14 eval
runs"**: *of the 14 eval runs org members did against this version, 12 passed.*
That is literally true of the table's contents and claims no suite size.

The number becomes what this spec originally promised only once eval
definitions ship inside the package. That is the follow-up:
`2026-08-01-canon-package-evals-design.md`.

## Out of scope

- Impact-section comparison of local vs. org pass-rate (rejected above)
- Per-eval breakdown across orgs (rejected above)
- Evals for non-skill kinds — the runner does not support them
- History / trend of pass-rate over time — the PK deliberately forbids it
- An opt-out setting for the push
- **Distributing eval definitions with the package** — the follow-up above.
  Without it this feature reports run activity, not suite conformance.
