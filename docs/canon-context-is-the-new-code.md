# Canon — Context Is the New Code

> Motive of creation. Read this to understand *why* Canon exists, not how it's wired.
> For the wiring, see `docs/cdlc-multi-export.md` and the `crates/cdlc` plans under `docs/superpowers/plans/`.

## The thesis we're building on

Patrick Debois (creator of DevOps, now at Tessl) gave a talk — **"Context Is the New Code"** ([QCon London 2026](https://qconlondon.com/presentation/mar2026/context-new-code) · [video](https://www.youtube.com/watch?v=bSG9wUYaHWU) · [Hg podcast](https://hgcapital.com/insights/orbit-podcast/patrick-debois-on-why-context-is-the-new-code)). The argument, compressed:

> We spent two decades building a rigorous lifecycle around **code** — version control, review, tests, CI/CD, observability in production. Now look at how we treat the **context** that drives AI coding agents: rules files copy-pasted from blog posts, prompts hand-edited in place, memory nobody audits. Teams that ship context on a vibe check are accruing the AI equivalent of technical debt. **The maturity of a company's CI/CD pipeline is the single best predictor of how well it will absorb AI.**

His corrective is the **Context Development Lifecycle (CDLC)** — four phases, borrowed wholesale from how we treat code:

| Phase | For code (we already do this) | For context (almost nobody does) |
|---|---|---|
| **Generate** | write / scaffold | author skills, memory, rules, souls — deliberately, not copy-paste |
| **Evaluate** | test, review | evals, LLM-as-a-judge, not "looks fine to me" |
| **Distribute** | package, publish, `npm install` | a registry so context is installed, versioned, and shared — not re-pasted |
| **Observe** | logs, metrics, tracing in prod | telemetry on which context actually moved the needle |

A second point he keeps returning to: context is **not** a private artifact. An agent only thrives on shared context, and that forces consensus — *"not only between the human and the agent, but the agent forces us to talk to other colleagues to have the same context."* Context is a **team asset**, versioned and governed like code.

## Why this is Canon's reason to exist

Canon is the CDLC made concrete inside Covenant. Debois described the discipline; Canon is the tooling that makes the discipline the path of least resistance — so treating context as a first-class engineering asset is *easier* than copy-pasting a prompt, not harder.

Everything in Covenant's ontology already agrees with him. A **soul** is not a config file — it's *"a decision the principal has already made,"* a delegation written down. That is exactly Debois's point: an `ALWAYS-YES` reflex is context that has been **authored, reviewed, and committed** rather than re-improvised every session. Covenant was already treating context as code before we had the name for it. Canon is where that conviction gets its lifecycle.

The one line that governs the whole product: **context is the new code, so it gets the same lifecycle as code — no exceptions, no vibe checks.**

## The four phases, mapped to what Canon actually ships

Canon isn't aspirational — each of Debois's phases already has a surface. This is the map:

### Generate — author context deliberately
- **Context Miner** (`docs/superpowers/plans/2026-07-05-cdlc-context-miner.md`) — mines a repo into candidate skills / memory / commands / subagents, then a curation UI turns them into CDLC artifacts. This is "generate" refusing to be copy-paste: the raw material comes from *your* codebase, curated, not pasted from a blog.
- **Souls / operators, Spec Author** — first-class authoring surfaces for the highest-value context (delegated judgment, specs). The Miner is bulk-generate; these are hand-generate.
- **Detection & Adoption** (`2026-07-17-canon-detection-adoption.md`) — Canon *detects* foreign skills/agents/commands/mcp already lying in a repo's executor dirs and one-click **adopts** them into the lifecycle. Generate, applied backwards: pull ungoverned context that already exists into the system instead of leaving it un-versioned.

### Evaluate — no ship on a vibe check
- **Eval Runner** (`2026-06-26-cdlc-eval-runner-plan-a.md`) — `claude -p` sandbox + **LLM-as-a-judge**, the exact mechanism Debois names. This is the phase most teams skip; it's the phase that separates compounding gains from a ceiling.

### Distribute — install context, don't re-paste it
- **Registry** (`registry.covenant.uno`, `docs/cdlc-multi-export.md`) — the full CDLC covers all five publishable kinds; context is **versioned, signed (`sha` + `signer`), and installed** rather than re-pasted. `.covenant/cdlc/cdlc.toml` is the lockfile — a `package.json` for context.
- **Projection** — installed context is projected into each executor's native instruction file inside idempotent managed blocks (`<!-- cdlc:start -->`). Regenerating twice is a zero diff. One source of truth, distributed to every harness (claude / codex / copilot / pi / hermes) automatically.
- **Org-scoped roster** (`2026-07-13-operators-to-canon.md`) — the "context is a team asset, forces consensus" point: Canon's roster is org-scoped, so the same context is shared across colleagues, not siloed per-developer.

### Observe — telemetry on what context earned its keep
- **Score / telemetry** (`crates/score`) — install and usage events flow through the existing telemetry pipe, and the **Metrics / Pulse dashboard** surfaces them. This is "observe in production" for context: which skills, which memory, which souls actually moved the needle — the feedback loop that tells the next Generate what to author.
- **Context Governance** (`2026-06-24-cdlc-context-governance-design.md`) — the lifecycle policy layer that closes observe → generate.

## The through-line

```
   GENERATE            EVALUATE           DISTRIBUTE           OBSERVE
  Context Miner   →   Eval Runner    →     Registry      →   Score / Pulse
  Souls / Specs       (LLM-judge)         + Projection        + Governance
  Detection                               + Org roster            │
      ▲                                                           │
      └───────────────────── feedback: observe tells generate ───┘
```

Debois's warning is the reason the loop has to close: *skip evaluate, and you're shipping AI technical debt; skip observe, and generate is flying blind.* Canon exists so that in Covenant, the lazy path **is** the rigorous path — the four phases are the default, not a 27-step rollout plan you have to opt into.

If a Canon feature doesn't serve one of these four phases (or the loop between them), it's out of scope. That's the test.

## Sources

- [Context Is the New Code — Patrick Debois, Tessl (video)](https://www.youtube.com/watch?v=bSG9wUYaHWU)
- [QCon London 2026 — Context Is the New Code](https://qconlondon.com/presentation/mar2026/context-new-code)
- [Patrick Debois on why context is the new code — Hg Orbit podcast](https://hgcapital.com/insights/orbit-podcast/patrick-debois-on-why-context-is-the-new-code)
- [AI Engineers: Context is the New Code — StartupHub.ai](https://www.startuphub.ai/ai-news/artificial-intelligence/2026/ai-engineers-context-is-the-new-code)
