# Operator-derived tab names follow inference

**Date:** 2026-07-11
**Status:** Design approved, proceeding to plan
**Branch:** `feat/operator-tab-name-inference`

## Problem

When an operator (AOM) starts working a tab, the tab bar freezes on a long,
slug-shaped name — e.g. `07-10-cdlc-memory-kind-design` — and never changes for
the rest of the session. That name reads badly in the narrow tab bar and, worse,
it *pins*: the live tab-title inference that normally keeps a tab's name fresh
("fixing tab titles" → "running tests") is running the whole time but is
completely masked.

The user's intent, verbatim: renaming the **executor agent's session** is fine
and should stay; but the **tab** should keep evolving the way it does under
normal tab-title inference, instead of locking onto the operator-derived slug.

## Background — the tab naming model (current behavior)

A tab's visible name is chosen by `tabDisplayName` (`ui/src/tabs/manager.ts:545`):

```ts
function tabDisplayName(t: Tab): string {
  return t.customName?.trim() || t.defaultTitle;
}
```

Two slots, one precedence rule:

- **`customName`** — the "user set this name on purpose" slot. When non-empty it
  **always wins**. Persisted as `custom_name` in the tab manifest.
- **`defaultTitle`** — the "auto" slot. Seeded at tab creation to the cwd
  basename (`defaultTitle: cwdBasename(initialCwd)`, `manager.ts:4262`) and
  **continuously overwritten by inference**. Persisted as `default_title` (a
  display hint so a reopened tab shows a real name instead of "Tab N").

### The inference loop that keeps `defaultTitle` fresh

The Rust summarizer runs a screen-based titler for tabs where an interactive
agent holds the PTY foreground (`crates/app/src/summarizer.rs`). On an interval
(`AGENT_TITLE_INTERVAL`), `regenerate_agent_title` reads the live screen and
emits a `title_suggested` session event. The frontend handles it at
`manager.ts:3521`:

```ts
} else if (event.kind === "title_suggested") {
  // AI-generated activity label. Only update the auto title;
  // a user-set customName always wins (see tabDisplayName).
  if (tabRef.current && event.title.trim().length > 0) {
    tabRef.current.defaultTitle = event.title.trim();
    this.renderTabbar();
  }
}
```

So inference writes **`defaultTitle`** and deliberately yields to `customName`.
ACP tabs (no PTY) get the equivalent seed from their first user prompt
(`manager.ts:~4808`, "Same precedence as title_suggested: customName wins").

### The two writers that break it

Both write an operator-*derived* (not user-authored) name into the **wrong
slot** — `customName` — so it outranks the inference that is still running:

1. **Mission slug** — `applyMissionTabNames()` (`manager.ts:2512`), called once
   when AOM turns on (`main.ts:1902`). For every tab with a mission attached and
   no user name, it sets `tab.customName = slugFromMissionPath(mission.path)`.
   `slugFromMissionPath` (`manager.ts:7641`) strips the numeric date prefix and
   kebab-cases the spec filename → `07-10-cdlc-memory-kind-design`. **This is the
   exact path that produced the screenshot.**

2. **Task title** — `spawnTabForTask()` (`main.ts:735`) opens a tab for a Task
   with `customName: task.title.slice(0, 32)`, e.g. `Implement Task 1 — add…`.

The executor **session** rename is a *separate, third* path we are **not**
touching: `operator.rs` injects `/rename <slug>\r` (or `/name` for pi) into the
executor so Claude/pi renames its own session (`crates/app/src/operator.rs:3811`+).
That rename surfaces to the tab, if at all, only as an inferred screen title →
`defaultTitle` — i.e. through the auto slot, which is fine.

## Goal

Operator-derived tab names become **seeds in the auto slot**, not pins in the
user slot. A tab shows the derived name immediately (readable), then evolves with
inference exactly like any other tab. A name the user set by hand still wins
forever. The executor session rename is untouched.

## Design

**Approach A — write derived names to `defaultTitle`, never `customName`.**

Because inference already writes `defaultTitle` and already yields to
`customName`, routing the derived name into `defaultTitle` gives the desired
precedence for free — `user rename > inference > derived seed` — with no new
state, flag, or slot. (Rejected: a dedicated `derivedName` slot with its own
precedence — redundant, since inference overwriting `defaultTitle` already
achieves it; and tracking an "auto vs user" flag on `customName` — conflates the
two slots and is fragile.)

### Change 1 — `applyMissionTabNames()` seeds `defaultTitle`

`ui/src/tabs/manager.ts:2512`. Keep the guard that protects a user-set name;
change the target slot:

```ts
for (const tab of this.tabs) {
  const mission = activePane(tab).mission;
  if (!mission) continue;
  if (tab.customName && tab.customName.trim().length > 0) continue; // user name wins
  const slug = slugFromMissionPath(mission.path);
  if (!slug) continue;
  tab.defaultTitle = slug;   // was: tab.customName = slug
  touched = true;
}
```

The guard still reads `customName` (a user rename must win). The write moves to
`defaultTitle` so the next `title_suggested` overwrites it. Update the method's
doc comment: it seeds the auto title, it does not pin a name.

### Change 2 — `createTab` accepts a `defaultTitle` seed

`ui/src/tabs/manager.ts:3185` opts and `:4262` construction. Add one optional
field so callers can seed the auto slot at construction (before the first
render), falling back to the cwd basename:

```ts
async createTab(opts?: {
  customName?: string | null;
  defaultTitle?: string | null;   // NEW — auto-slot seed; inference overwrites
  color?: string | null;
  // …
}): Promise<Tab | null>
```

```ts
const tab: Tab = {
  // …
  defaultTitle: opts?.defaultTitle?.trim() || cwdBasename(initialCwd),
  customName: opts?.customName ?? null,
  // …
};
```

### Change 3 — `spawnTabForTask()` passes the task title as the seed

`ui/src/main.ts:735`. Move the task title from the pin slot to the new seed:

```ts
const tab = await manager.createTab({
  defaultTitle: task.title.slice(0, 32),  // was: customName: `${task.title.slice(0, 32)}`
  cwd,
  groupId,
  color,
});
```

### Resulting behavior

| Scenario | Tab shows |
|---|---|
| Operator attaches, mission present | slug seed → **evolves** with inference |
| Tab opened for a Task | task title seed → **evolves** with inference |
| User renames the tab by hand | user name, wins forever (unchanged) |
| Executor `/rename` its session | unchanged — session renamed; tab still infers |
| Reopen a persisted tab | `default_title` hint, then re-infers (not pinned) |

## Edge cases & nuances

- **Seed vs. an already-inferred title.** `applyMissionTabNames` runs at
  AOM-enable, early, when `defaultTitle` is still the cold-start cwd basename, so
  seeding it is the intended readable name. If inference had already produced a
  title, the seed briefly regresses it until the next interval tick overwrites
  it. Acceptable; mark with a `ponytail:` comment naming the ceiling.
- **Empty / whitespace seed.** `defaultTitle` must never become empty (it is the
  fallback). Both writers already guard: `slugFromMissionPath` returning `""` is
  skipped (`if (!slug) continue`), and the `createTab` seed uses
  `opts?.defaultTitle?.trim() || cwdBasename(...)`.
- **Persistence migration.** Existing tabs saved with the mission slug in
  `custom_name` will still show that name (customName wins) until the user
  clears it or the tab is recreated. No migration is written — the pin simply
  stops being *created* going forward. Called out as a non-goal below.
- **ACP / no-PTY task tabs.** A task tab that runs an ACP executor gets its
  auto title from the first prompt rather than the screen titler; the task-title
  seed holds until then. Same precedence, consistent result.

## Testing

`ui/src/canon` is unaffected; all tests live in `ui/src/tabs/manager.test.ts`
(jsdom):

1. `applyMissionTabNames` on a tab with a mission and no user name sets
   **`defaultTitle`** to the mission slug and leaves `customName` null.
2. After that seed, dispatching a `title_suggested` event updates the **visible
   name** to the inferred title — proving inference wins over the seed.
3. `applyMissionTabNames` does **not** touch a tab whose `customName` is set by
   the user.
4. `createTab({ defaultTitle })` yields a tab whose visible name is the seed;
   `createTab({ customName })` still pins (regression guard for the slot split).

No Rust changes, so no crate tests. Run from repo root: `npm test`.

## Non-goals (later / rejected)

- **Back-migrating already-pinned tabs.** Tabs previously saved with a slug in
  `custom_name` keep showing it; we only stop creating the pin. A one-shot
  migration (move slug-shaped `custom_name` → `default_title`) is out of scope.
- **A dedicated derived-name slot / precedence flag.** Redundant with inference
  already owning `defaultTitle`.
- **Touching the executor session rename** (`operator.rs` `/rename`). Explicitly
  kept as-is per the user.
- **Changing the inference cadence or the titler prompt.** Out of scope.

## File touch-list

- `ui/src/tabs/manager.ts` — `applyMissionTabNames` writes `defaultTitle` (+ doc
  comment); `createTab` opts gain `defaultTitle?`; construction seeds it.
- `ui/src/main.ts` — `spawnTabForTask` passes `defaultTitle` instead of
  `customName`.
- `ui/src/tabs/manager.test.ts` — the four assertions above.

## Ponytail boundaries

- `// ponytail:` seed lives in `defaultTitle`; no new slot — inference already
  owns that field and already yields to `customName`, so precedence is free.
- `// ponytail:` seeding may briefly regress an already-inferred title to the
  mission slug at AOM-enable; the next titler tick corrects it. Add a guard
  ("seed only if defaultTitle is still cold-start") only if that flash is ever
  reported.
- `// ponytail:` no persistence migration for already-pinned tabs; recreate or
  rename to clear. Add a migration only if stale pins become a real complaint.
