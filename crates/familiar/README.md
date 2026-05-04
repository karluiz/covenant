# karl-familiar

Per-operator AI companion: persistent memory, named identity, configurable style,
approved-directive flow.

See `docs/superpowers/specs/2026-05-04-familiars-design.md` for the design.
See `docs/superpowers/plans/2026-05-04-familiars.md` for the implementation plan.

## Modules

- `identity` — `Familiar`, `FamiliarId`, `Style`, `FamiliarConfig`
- `memory` — SQLite store: events, summaries, missions, chat, directives, costs
- `observer` — drains `SessionEvent` bus, persists, triggers eager summarization
- `summarizer` — Haiku eager + Sonnet lazy, behind a mockable `Llm` trait
- `prompts` — system prompt builder with style variants
- `agent` — chat loop, parses `<<DIRECTIVE>>...<</DIRECTIVE>>` proposals
- `directive` — types + safety check (DefaultSafety blocklist)
- `manager` — `FamiliarManager` registry + lifecycle + approval flow
- `cost` — daily-cap gate + frozen-mode
- `error` — crate error type

## Storage

`~/.karlTerminal/familiars/<familiar_id>.sqlite`

## Tests

`cargo test -p karl-familiar` — unit + integration (`tests/observer.rs`).
