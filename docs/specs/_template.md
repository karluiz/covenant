# <Feature ID> — <Name>

> Template for actionable feature specs that AOM can execute on.
> The vision lives in `../next-features.md` — this is operational scope.
>
> Delete this blockquote when copying.

## Goal

One sentence. The user-visible problem this resolves. Not the
implementation — the outcome. Example: "Open an in-app reference
without leaving Covenant when I forget what AOM does."

## Out of scope

Bullets. What looks related but is NOT this task. The agent uses this
to recognize when it's drifting and should escalate. Be aggressive
here — the broader this list, the safer the run.

- <thing the agent might be tempted to also build>
- <related feature that lives in a different spec>
- <improvement / refactor that's adjacent but separate>

## Acceptance criteria

3–5 bullets, each observable (testable by hand or automated). The
agent uses this to know when to stop. The user uses this to verify on
wake.

- [ ] <user can do X via Y>
- [ ] <command Z passes / produces W>
- [ ] <regression Q does not happen>

## File boundaries

Hint at the blast radius. The agent should respect these unless the
acceptance criteria force otherwise (in which case: escalate, don't
silently expand).

- **Create**: `<path>` (≤ N files / ≤ N lines)
- **Touch**: `<path>` (≤ N lines)
- **DO NOT touch**: `<path>` (and explanation if non-obvious)

## Complexity

`small` (1 AOM session) | `medium` (2–3 sessions) | `large` (multiple
nights — break it down further before passing to AOM).

## Open questions

If any. The agent must NOT decide these silently — escalate instead.
List them so the morning report shows them as awaiting your call.

- <decision the agent shouldn't make alone>

## AOM run notes (filled by agent or user during/after run)

Empty when the spec is fresh. Populated as evidence:
- Branch used: `feature/<id>`
- AOM session row: <id>
- Notable decisions: <bullets>
- Open issues for follow-up: <bullets>
