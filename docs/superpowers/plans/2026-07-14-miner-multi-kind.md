# Context Miner Multi-Kind Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a single Context Miner run route curated findings to four CDLC kinds — skill, memory, command, subagent — instead of always compiling to one skill.

**Architecture:** The agent tags each finding with a `suggested_kind` (defaulted from its category). The curation UI carries a per-finding `kind` the user can re-route. Compile groups accepted findings by kind and dispatches to a writer per kind, all writing markdown under `.covenant/canon/{skills,memory,commands,agents}/`.

**Tech Stack:** Rust (`karl_agent`, `karl_canon`, `karl_app` Tauri commands), TypeScript (`ui/src/canon/miner`), Vitest, `cargo test`.

## Global Constraints

- Kinds in scope: `skill`, `memory`, `command`, `subagent`. Operators, MCP, specs are out.
- Default category→kind mapping: `domain_rule`,`glossary`→memory; `workflow`→command; `convention`,`pattern`,`gotcha`→skill.
- `subagent` is never auto-suggested by the agent; it is only reachable via manual re-route in curation.
- New finding category `workflow` added; `CATEGORIES` = `["convention","pattern","gotcha","domain_rule","glossary","workflow"]`.
- Slug for memory/command/subagent = kebab of finding title, deduped against existing files in target dir (`-2`, `-3` on collision). The form's package name only names the skill bucket.
- Skill-only findings must produce byte-identical output to today.
- Rust: `thiserror` in libs, no `unwrap()` outside tests. TS: `strict`, no `as any` without comment.
- Commit per task (Conventional Commits).

---

### Task 1: Add `workflow` category + `kind` field + `suggested_kind` schema (agent crate)

**Files:**
- Modify: `crates/agent/src/context_miner.rs`
- Test: same file (`#[cfg(test)] mod tests` — add if absent)

**Interfaces:**
- Produces: `MinerFinding` gains `pub kind: String` (serialized `kind`, values `skill|memory|command|subagent`). `pub fn default_kind(category: &str) -> &'static str`. `CATEGORIES` includes `"workflow"`. `emit_finding` schema gains optional `suggested_kind` enum.

- [ ] **Step 1: Write the failing test**

Add to the tests module in `crates/agent/src/context_miner.rs`:

```rust
#[test]
fn default_kind_maps_categories() {
    assert_eq!(default_kind("domain_rule"), "memory");
    assert_eq!(default_kind("glossary"), "memory");
    assert_eq!(default_kind("workflow"), "command");
    assert_eq!(default_kind("convention"), "skill");
    assert_eq!(default_kind("pattern"), "skill");
    assert_eq!(default_kind("gotcha"), "skill");
    assert_eq!(default_kind("nonsense"), "skill");
}

#[test]
fn parse_finding_fills_kind_from_category_when_absent() {
    let v = json!({ "category": "domain_rule", "title": "PEP check", "body_md": "Do X." });
    let f = parse_finding(&v).expect("valid finding");
    assert_eq!(f.kind, "memory");
}

#[test]
fn parse_finding_honors_suggested_kind_but_never_subagent() {
    let v = json!({ "category": "pattern", "title": "T", "body_md": "B", "suggested_kind": "memory" });
    assert_eq!(parse_finding(&v).unwrap().kind, "memory");
    let sub = json!({ "category": "pattern", "title": "T", "body_md": "B", "suggested_kind": "subagent" });
    // agent may never route to subagent; falls back to category default
    assert_eq!(parse_finding(&sub).unwrap().kind, "skill");
}

#[test]
fn workflow_is_a_valid_category() {
    let v = json!({ "category": "workflow", "title": "Run tests", "body_md": "npm test from root." });
    assert!(parse_finding(&v).is_some());
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p karl_agent context_miner`
Expected: FAIL — `default_kind` not found, `f.kind` no field.

- [ ] **Step 3: Write minimal implementation**

In `crates/agent/src/context_miner.rs`:

Change line 12:
```rust
pub const CATEGORIES: &[&str] =
    &["convention", "pattern", "gotcha", "domain_rule", "glossary", "workflow"];
```

Add `kind` to the struct (after the `confidence` field, before the closing brace of `MinerFinding`):
```rust
    #[serde(default)]
    pub kind: String,
```

Add the mapping fn (top-level, near `default_confidence`):
```rust
/// Category → default destination kind. `subagent` is intentionally
/// unreachable here: the agent never promotes a finding to a persona; that
/// is a manual re-route in curation.
pub fn default_kind(category: &str) -> &'static str {
    match category {
        "domain_rule" | "glossary" => "memory",
        "workflow" => "command",
        _ => "skill",
    }
}
```

In `parse_finding`, after the existing validations and before `Some(f)`, normalize kind:
```rust
    // Fill/repair kind. Trust only skill|memory|command from the model
    // (`suggested_kind` deserialized into `f.kind` via serde alias); anything
    // else — including "subagent" — falls back to the category default.
    if !matches!(f.kind.as_str(), "skill" | "memory" | "command") {
        f.kind = default_kind(&f.category).to_string();
    }
```
Make `f` mutable: change `let f: MinerFinding` to `let mut f: MinerFinding`.

Add serde alias so the tool's `suggested_kind` key lands in `kind` (on the field):
```rust
    #[serde(default, alias = "suggested_kind")]
    pub kind: String,
```

In `miner_tool_specs()` add to the `emit_finding` properties:
```rust
                "suggested_kind": { "type": "string", "enum": ["skill", "memory", "command"], "description": "Where this finding belongs: skill (conventions/patterns/gotchas), memory (durable domain facts/glossary), or command (a repeatable workflow). Omit to let the category decide." },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p karl_agent context_miner`
Expected: PASS (all four new tests + existing).

- [ ] **Step 5: Commit**

```bash
git add crates/agent/src/context_miner.rs
git commit -m "feat(miner): finding kind + suggested_kind + workflow category"
```

---

### Task 2: Update the miner system prompt for kinds

**Files:**
- Modify: `crates/agent/src/context_miner.rs` (`system_prompt`)

**Interfaces:** none new — prompt copy only.

- [ ] **Step 1: Edit `system_prompt`**

Replace the categories sentence and add a kinds sentence. In the `format!` string, change the categories clause to include `workflow` and append routing guidance before the closing-summary sentence:

```rust
         {depth}\n\nCategories: convention (how code is written here), \
         pattern (recurring designs), gotcha (traps that bit or will bite), \
         domain_rule (business/regulatory rules encoded in the code), \
         glossary (project-specific terms), workflow (a repeatable dev \
         command sequence: build, test, deploy, migrate).\n\n\
         Set suggested_kind to route the finding: skill for \
         convention/pattern/gotcha, memory for durable domain_rule/glossary \
         facts, command for a workflow. Omit it to accept the default for the \
         category. You never create personas.\n\nWhen you have covered the \
         focus, reply with a short closing summary WITHOUT tool calls.",
```

- [ ] **Step 2: Verify it compiles**

Run: `cargo build -p karl_agent`
Expected: builds clean.

- [ ] **Step 3: Commit**

```bash
git add crates/agent/src/context_miner.rs
git commit -m "feat(miner): system prompt describes kinds and routing"
```

---

### Task 3: Per-kind writers in the canon compile module

**Files:**
- Modify: `crates/canon/src/compile.rs`
- Test: same file

**Interfaces:**
- Consumes: `CompiledFinding` gains `pub kind: String` (serialized `kind`).
- Produces:
  - `pub fn slugify(title: &str) -> String`
  - `pub fn write_memory_entry(repo_root, findings: &[CompiledFinding]) -> Result<Vec<PathBuf>, CanonError>`
  - `pub fn write_command_entry(repo_root, findings: &[CompiledFinding]) -> Result<Vec<PathBuf>, CanonError>`
  - `pub fn write_subagent_entry(repo_root, findings: &[CompiledFinding]) -> Result<Vec<PathBuf>, CanonError>`
  - existing `write_skill_package` unchanged in signature.

- [ ] **Step 1: Write the failing tests**

Add to `crates/canon/src/compile.rs` tests module (update the `finding` helper to set `kind`):

```rust
    fn finding_k(cat: &str, title: &str, kind: &str) -> CompiledFinding {
        CompiledFinding {
            category: cat.into(), title: title.into(),
            body_md: format!("Always do {title}."),
            evidence: vec!["src/lib.rs:12".into()],
            confidence: "high".into(), kind: kind.into(),
        }
    }

    #[test]
    fn slugify_kebabs_and_trims() {
        assert_eq!(slugify("PEP screening required!"), "pep-screening-required");
        assert_eq!(slugify("  Multiple   spaces  "), "multiple-spaces");
    }

    #[test]
    fn memory_writes_one_file_per_finding_with_description() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let paths = write_memory_entry(root, &[
            finding_k("domain_rule", "PEP check", "memory"),
            finding_k("glossary", "KYC term", "memory"),
        ]).unwrap();
        assert_eq!(paths.len(), 2);
        let pep = std::fs::read_to_string(root.join(".covenant/canon/memory/pep-check.md")).unwrap();
        assert!(pep.contains("description: PEP check"), "frontmatter: {pep}");
        assert!(pep.contains("Always do PEP check."));
        assert!(root.join(".covenant/canon/memory/kyc-term.md").exists());
    }

    #[test]
    fn memory_dedupes_colliding_slugs() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let paths = write_memory_entry(root, &[
            finding_k("domain_rule", "Same Title", "memory"),
            finding_k("glossary", "Same Title", "memory"),
        ]).unwrap();
        assert!(paths[0].ends_with("same-title.md"));
        assert!(paths[1].ends_with("same-title-2.md"));
    }

    #[test]
    fn command_and_subagent_write_to_their_dirs() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write_command_entry(root, &[finding_k("workflow", "Run tests", "command")]).unwrap();
        write_subagent_entry(root, &[finding_k("convention", "Reviewer", "subagent")]).unwrap();
        assert!(root.join(".covenant/canon/commands/run-tests.md").exists());
        assert!(root.join(".covenant/canon/agents/reviewer.md").exists());
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p karl_canon compile`
Expected: FAIL — `kind` field missing, writer fns undefined.

- [ ] **Step 3: Write minimal implementation**

Add `kind` to `CompiledFinding` (after `confidence`):
```rust
    #[serde(default)]
    pub kind: String,
```

Add helpers at module level:
```rust
/// Kebab-case a finding title into a filename slug.
pub fn slugify(title: &str) -> String {
    let mut out = String::new();
    let mut prev_dash = false;
    for ch in title.trim().chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            prev_dash = false;
        } else if !prev_dash && !out.is_empty() {
            out.push('-');
            prev_dash = true;
        }
    }
    out.trim_matches('-').to_string()
}

/// Slug not already used on disk or in `taken`; suffixes -2, -3, … on collision.
fn unique_slug(dir: &Path, base: &str, taken: &mut std::collections::HashSet<String>) -> String {
    let base = if base.is_empty() { "entry".to_string() } else { base.to_string() };
    let mut candidate = base.clone();
    let mut n = 1;
    while taken.contains(&candidate) || dir.join(format!("{candidate}.md")).exists() {
        n += 1;
        candidate = format!("{base}-{n}");
    }
    taken.insert(candidate.clone());
    candidate
}

fn write_md_entries(dir: &Path, findings: &[CompiledFinding]) -> Result<Vec<PathBuf>, CanonError> {
    std::fs::create_dir_all(dir)?;
    let mut taken = std::collections::HashSet::new();
    let mut out = Vec::new();
    for f in findings {
        let slug = unique_slug(dir, &slugify(&f.title), &mut taken);
        let mut md = format!("---\ndescription: {}\n---\n\n# {}\n\n{}\n", f.title, f.title, f.body_md.trim());
        if !f.evidence.is_empty() {
            let refs: Vec<String> = f.evidence.iter().map(|e| format!("`{e}`")).collect();
            md.push_str(&format!("\nEvidence: {}\n", refs.join(", ")));
        }
        let path = dir.join(format!("{slug}.md"));
        std::fs::write(&path, md)?;
        out.push(path);
    }
    Ok(out)
}

pub fn write_memory_entry(repo_root: &Path, findings: &[CompiledFinding]) -> Result<Vec<PathBuf>, CanonError> {
    write_md_entries(&canon_dir(repo_root).join("memory"), findings)
}
pub fn write_command_entry(repo_root: &Path, findings: &[CompiledFinding]) -> Result<Vec<PathBuf>, CanonError> {
    write_md_entries(&canon_dir(repo_root).join("commands"), findings)
}
pub fn write_subagent_entry(repo_root: &Path, findings: &[CompiledFinding]) -> Result<Vec<PathBuf>, CanonError> {
    write_md_entries(&canon_dir(repo_root).join("agents"), findings)
}
```

Update the existing `finding()` helper calls in old tests to include `kind: "skill".into()` (or route them through `finding_k`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p karl_canon compile`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/canon/src/compile.rs
git commit -m "feat(canon): per-kind compile writers for memory/command/subagent"
```

---

### Task 4: Generalize the Tauri compile command

**Files:**
- Modify: `crates/app/src/canon_miner.rs`
- Modify: `crates/app/src/lib.rs` (command registration — rename in `generate_handler!`)
- Test: `crates/app/src/canon_miner.rs`

**Interfaces:**
- Consumes: `write_skill_package`, `write_memory_entry`, `write_command_entry`, `write_subagent_entry` from Task 3.
- Produces: `#[tauri::command] canon_compile_findings(repo_root, skill_name, findings: Vec<CompiledFinding>, overwrite) -> Result<CompileReport, String>` where `CompileReport { skills: Option<String>, memory: Vec<String>, commands: Vec<String>, agents: Vec<String> }` (serialized camelCase). Replaces `canon_compile_skill`.

- [ ] **Step 1: Write the failing test**

Add to the tests module in `crates/app/src/canon_miner.rs`:

```rust
    #[test]
    fn split_by_kind_groups_findings() {
        use karl_canon::compile::CompiledFinding;
        let f = |kind: &str| CompiledFinding {
            category: "pattern".into(), title: format!("t {kind}"),
            body_md: "b".into(), evidence: vec![], confidence: "high".into(), kind: kind.into(),
        };
        let all = vec![f("skill"), f("memory"), f("memory"), f("command"), f("subagent")];
        let g = super::split_by_kind(&all);
        assert_eq!(g.skills.len(), 1);
        assert_eq!(g.memory.len(), 2);
        assert_eq!(g.commands.len(), 1);
        assert_eq!(g.agents.len(), 1);
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p covenant split_by_kind`.
Expected: FAIL — `split_by_kind` undefined.

- [ ] **Step 3: Write minimal implementation**

In `crates/app/src/canon_miner.rs`, update the import and replace `canon_compile_skill`:

```rust
use karl_canon::compile::{
    write_command_entry, write_memory_entry, write_skill_package, write_subagent_entry,
    CompiledFinding,
};
use serde::Serialize;

#[derive(Default)]
pub(crate) struct KindGroups<'a> {
    pub skills: Vec<CompiledFinding>,
    pub memory: Vec<CompiledFinding>,
    pub commands: Vec<CompiledFinding>,
    pub agents: Vec<CompiledFinding>,
    _marker: std::marker::PhantomData<&'a ()>,
}

pub(crate) fn split_by_kind(findings: &[CompiledFinding]) -> KindGroups<'static> {
    let mut g = KindGroups::default();
    for f in findings {
        match f.kind.as_str() {
            "memory" => g.memory.push(f.clone()),
            "command" => g.commands.push(f.clone()),
            "subagent" => g.agents.push(f.clone()),
            _ => g.skills.push(f.clone()),
        }
    }
    g
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CompileReport {
    pub skills: Option<String>,
    pub memory: Vec<String>,
    pub commands: Vec<String>,
    pub agents: Vec<String>,
}

#[tauri::command]
pub async fn canon_compile_findings(
    repo_root: String,
    skill_name: String,
    findings: Vec<CompiledFinding>,
    overwrite: bool,
) -> Result<CompileReport, String> {
    let root = PathBuf::from(&repo_root);
    tokio::task::spawn_blocking(move || {
        let g = split_by_kind(&findings);
        let mut report = CompileReport::default();
        if !g.skills.is_empty() {
            let dir = write_skill_package(&root, &skill_name, None, &g.skills, overwrite)
                .map_err(|e| e.to_string())?;
            report.skills = Some(dir.to_string_lossy().into_owned());
        }
        let strvec = |v: Vec<std::path::PathBuf>| v.into_iter().map(|p| p.to_string_lossy().into_owned()).collect();
        if !g.memory.is_empty() {
            report.memory = strvec(write_memory_entry(&root, &g.memory).map_err(|e| e.to_string())?);
        }
        if !g.commands.is_empty() {
            report.commands = strvec(write_command_entry(&root, &g.commands).map_err(|e| e.to_string())?);
        }
        if !g.agents.is_empty() {
            report.agents = strvec(write_subagent_entry(&root, &g.agents).map_err(|e| e.to_string())?);
        }
        Ok::<_, String>(report)
    })
    .await
    .map_err(|e| e.to_string())?
}
```

Remove the old `canon_compile_skill` fn. In `crates/app/src/lib.rs`, change `canon_compile_skill` to `canon_compile_findings` inside `tauri::generate_handler!`.

Note: `KindGroups` lifetime param is dead weight — drop the `_marker`/`<'a>` and return `KindGroups` by value with owned `Vec<CompiledFinding>` fields. `// ponytail: no lifetimes, owned clones at curation scale`.

Simplify to:
```rust
#[derive(Default)]
pub(crate) struct KindGroups {
    pub skills: Vec<CompiledFinding>,
    pub memory: Vec<CompiledFinding>,
    pub commands: Vec<CompiledFinding>,
    pub agents: Vec<CompiledFinding>,
}
pub(crate) fn split_by_kind(findings: &[CompiledFinding]) -> KindGroups { /* as above, returns KindGroups */ }
```

- [ ] **Step 4: Run tests + build**

Run: `cargo test -p karl_canon compile && cargo build -p covenant`
Expected: PASS + builds (handler registration resolves).

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/canon_miner.rs crates/app/src/lib.rs
git commit -m "feat(app): canon_compile_findings routes accepted findings by kind"
```

---

### Task 5: Frontend types + API wrapper

**Files:**
- Modify: `ui/src/api.ts`

**Interfaces:**
- Produces: `MinerFinding` gains `kind: string`. `CompileReport` type. `canonCompileFindings(repoRoot, skillName, findings, overwrite): Promise<CompileReport>` replaces `canonCompileSkill`.

- [ ] **Step 1: Edit `ui/src/api.ts`**

```typescript
export interface MinerFinding {
  category: string;
  title: string;
  bodyMd: string;
  evidence: string[];
  confidence: string;
  kind: string;
}
export interface CompileReport {
  skills: string | null;
  memory: string[];
  commands: string[];
  agents: string[];
}
```

Replace `canonCompileSkill`:
```typescript
export async function canonCompileFindings(repoRoot: string, skillName: string, findings: MinerFinding[], overwrite: boolean): Promise<CompileReport> {
  return invoke<CompileReport>("canon_compile_findings", { repoRoot, skillName, findings, overwrite });
}
```

- [ ] **Step 2: Type-check**

Run: `npm run build` (from repo root) — expect it to fail later where `canonCompileSkill` is still referenced; that's fixed in Task 7. For now confirm no NEW type error inside api.ts.

- [ ] **Step 3: Commit**

```bash
git add ui/src/api.ts
git commit -m "feat(ui): MinerFinding.kind + canonCompileFindings API"
```

---

### Task 6: Reducer — finding kind, re-route action, grouped preview

**Files:**
- Modify: `ui/src/canon/miner/state.ts`
- Test: `ui/src/canon/miner/state.test.ts` (create)

**Interfaces:**
- Consumes: `MinerFinding.kind` (Task 5).
- Produces: `FindingCard.kind: string`; `setFindingKind(state, id, kind)`; `acceptedFindings` returns findings carrying `kind`; `compilePreview` groups by kind. `KIND_ORDER`/`KIND_LABELS` exported.

- [ ] **Step 1: Write the failing test**

Create `ui/src/canon/miner/state.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { createMinerState, reduceMinerEvent, setFindingKind, setFindingStatus, acceptedFindings } from "./state";
import type { MinerEvent } from "../../api";

function seed() {
  const s = createMinerState();
  const ev: MinerEvent = { kind: "finding", id: "a", finding: { category: "domain_rule", title: "PEP", bodyMd: "x", evidence: [], confidence: "high", kind: "memory" } };
  reduceMinerEvent(s, ev);
  return s;
}

describe("miner kind routing", () => {
  it("carries kind from the finding event", () => {
    const s = seed();
    expect(s.findings[0].kind).toBe("memory");
  });
  it("re-routes a finding kind", () => {
    const s = seed();
    setFindingKind(s, "a", "subagent");
    expect(s.findings[0].kind).toBe("subagent");
  });
  it("accepted findings expose their kind", () => {
    const s = seed();
    setFindingStatus(s, "a", "accepted");
    expect(acceptedFindings(s)[0].kind).toBe("memory");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- miner/state` (from repo root)
Expected: FAIL — `setFindingKind` undefined, `.kind` missing.

- [ ] **Step 3: Implement**

In `state.ts`:

Add `kind` to `FindingCard`:
```typescript
export interface FindingCard {
  id: string;
  finding: MinerFinding;
  kind: string;
  status: "pending" | "accepted" | "discarded";
  editedBody?: string;
}
```

In the `"finding"` case, seed kind from the finding:
```typescript
    case "finding":
      state.findings.push({ id: ev.id, finding: ev.finding, kind: ev.finding.kind || "skill", status: "pending" });
      break;
```

Add the action:
```typescript
export function setFindingKind(state: MinerState, id: string, kind: string): void {
  const c = state.findings.find((f) => f.id === id);
  if (c) c.kind = kind;
}
```

Update `acceptedFindings` to carry the re-routed kind:
```typescript
export function acceptedFindings(state: MinerState): MinerFinding[] {
  return state.findings
    .filter((c) => c.status === "accepted")
    .map((c) => ({ ...c.finding, kind: c.kind, bodyMd: c.editedBody ?? c.finding.bodyMd }));
}
```

Add category `workflow` to `CATEGORY_ORDER`:
```typescript
const CATEGORY_ORDER: [string, string][] = [
  ["convention", "Conventions"],
  ["pattern", "Patterns"],
  ["gotcha", "Gotchas"],
  ["domain_rule", "Domain rules"],
  ["glossary", "Glossary"],
  ["workflow", "Workflows"],
];
```

Add kind ordering + labels and rewrite `compilePreview` to group by destination kind:
```typescript
export const KIND_ORDER = ["skill", "memory", "command", "subagent"] as const;
export const KIND_LABELS: Record<string, string> = {
  skill: "Skill package", memory: "Memory", command: "Commands", subagent: "Subagents",
};

export function compilePreview(skillName: string, state: MinerState): string {
  const accepted = acceptedFindings(state);
  let md = "";
  for (const kind of KIND_ORDER) {
    const inKind = accepted.filter((f) => f.kind === kind);
    if (inKind.length === 0) continue;
    const target = kind === "skill" ? `.covenant/canon/skills/${skillName}/` : `.covenant/canon/${kind === "subagent" ? "agents" : kind === "command" ? "commands" : "memory"}/`;
    md += `# ${KIND_LABELS[kind]} → ${target}\n`;
    for (const f of inKind) {
      md += `\n## ${f.title}\n\n${(f.bodyMd).trim()}\n`;
      if (f.evidence.length > 0) md += `\nEvidence: ${f.evidence.map((e) => `\`${e}\``).join(", ")}\n`;
    }
    md += "\n";
  }
  return md || "No findings accepted yet.";
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -- miner/state`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/canon/miner/state.ts ui/src/canon/miner/state.test.ts
git commit -m "feat(ui): miner reducer carries per-finding kind + grouped preview"
```

---

### Task 7: Curation card kind selector + form copy + write wiring

**Files:**
- Modify: `ui/src/canon/miner/view.ts`

**Interfaces:**
- Consumes: `setFindingKind`, `KIND_ORDER`, `KIND_LABELS`, `acceptedFindings`, `compilePreview` (Task 6); `canonCompileFindings`, `CompileReport` (Task 5).

- [ ] **Step 1: Form copy**

In `showSetup()`:
- Line 246: `note.textContent = "Findings route to skills, memory, commands or subagents during curation.";`
- Line 249: field label `"Package name"`; keep placeholder `"e.g. testing-conventions"`.
- Line 287: `errorEl.textContent = "Enter a package name.";`

Add category label + workflow to the view constants (line 41-42 region):
```typescript
const CATEGORY_ORDER: string[] = ["convention", "pattern", "gotcha", "domain_rule", "glossary", "workflow"];
const CATEGORY_LABELS: Record<string, string> = {
  convention: "Conventions", pattern: "Patterns", gotcha: "Gotchas",
  domain_rule: "Domain rules", glossary: "Glossary", workflow: "Workflows",
};
```

- [ ] **Step 2: Kind selector on each card**

Import `setFindingKind`, `KIND_ORDER`, `KIND_LABELS` from `./state`, and `canonCompileFindings` from `../../api` (replace `canonCompileSkill`).

In `renderCard`, before `actions`, add a kind chip row (only for non-discarded cards):
```typescript
    const kindRow = document.createElement("div");
    kindRow.className = "canon-miner-kindrow";
    for (const k of KIND_ORDER) {
      const chip = document.createElement("button");
      chip.className = card.kind === k ? "canon-miner-kindchip is-active" : "canon-miner-kindchip";
      chip.textContent = KIND_LABELS[k];
      chip.addEventListener("click", () => {
        setFindingKind(this.state, id, k);
        this.renderCard(id);
        this.renderPreview();
      });
      kindRow.appendChild(chip);
    }
```
Append `kindRow` into the card: `wrapper.append(top, body, evidence, kindRow, actions);`

- [ ] **Step 3: Rewire `writeToRepo`**

```typescript
  private async writeToRepo(writeBtn: HTMLButtonElement, overwrite: boolean): Promise<void> {
    writeBtn.disabled = true;
    try {
      const findings = acceptedFindings(this.state);
      const report = await canonCompileFindings(this.opts.repoRoot, this.skillName, findings, overwrite);
      const parts: string[] = [];
      if (report.skills) parts.push("1 skill");
      if (report.memory.length) parts.push(`${report.memory.length} memory`);
      if (report.commands.length) parts.push(`${report.commands.length} command`);
      if (report.agents.length) parts.push(`${report.agents.length} subagent`);
      pushInfoToast({ message: `Written: ${parts.join(", ") || "nothing"}` });
      this.destroy();
    } catch (e) {
      const msg = String(e);
      if (!overwrite && msg.includes("already exists")) {
        this.showOverwriteConfirm(writeBtn);
      } else {
        pushInfoToast({ message: `Write failed: ${msg}` });
        writeBtn.disabled = false;
      }
    }
  }
```

Note: overwrite only guards the skill package (memory/command/subagent slugs auto-dedupe, never collide-error). The `already exists` branch still applies when skill findings hit an existing package. `// ponytail: only skills collision-guard; other kinds dedupe by slug`.

- [ ] **Step 4: Guard the write button**

`canWrite` at line 621 stays as-is (`acceptedFindings(...).length > 0 && done||stopped`). No change.

- [ ] **Step 5: Add minimal CSS**

Append to `ui/src/canon/miner` stylesheet (find the file: `grep -rl "canon-miner-card" ui/src/canon/**/*.css`) — reuse existing chip styling if present, else:
```css
.canon-miner-kindrow { display: flex; gap: 4px; flex-wrap: wrap; margin: 6px 0; }
.canon-miner-kindchip { font-size: 11px; padding: 2px 8px; border: 1px solid var(--border); background: transparent; color: var(--text-dim); cursor: pointer; border-radius: 0; }
.canon-miner-kindchip.is-active { background: var(--accent); color: var(--accent-contrast); border-color: var(--accent); }
```
(Match existing token names in that file; sharp corners per Tasker rule.)

- [ ] **Step 6: Type-check + build**

Run: `npm run build` (repo root)
Expected: PASS — no dangling `canonCompileSkill` reference.

- [ ] **Step 7: Commit**

```bash
git add ui/src/canon/miner/view.ts ui/src/canon/miner/*.css
git commit -m "feat(ui): per-finding kind selector, grouped preview, multi-kind write"
```

---

### Task 8: Full regression pass

- [ ] **Step 1: Rust**

Run: `cargo test -p karl_agent -p karl_canon -p covenant`
Expected: PASS.

- [ ] **Step 2: TS**

Run: `npm test -- miner && npm run build`
Expected: PASS.

- [ ] **Step 3: Commit any fixups**

```bash
git add -A
git commit -m "test(miner): multi-kind regression green"
```

---

## Self-Review

**Spec coverage:**
- Agent suggests kind + `workflow` category + default mapping → Task 1, 2. ✓
- Curation = routing (card selector, grouped preview) → Task 6, 7. ✓
- Compile per kind (4 writers, slug dedupe) → Task 3. ✓
- Generalized command returning per-kind paths → Task 4. ✓
- Form copy (package name, header line) → Task 7. ✓
- Skill-only == today → covered by keeping `write_skill_package` and `render_skill_md` untouched; grouped preview label differs but compiled skill bytes identical. ✓
- Testing per writer + parse + reducer → Tasks 1, 3, 6. ✓

**Placeholder scan:** none — all steps carry real code.

**Type consistency:** `MinerFinding.kind` (Rust `String` / TS `string`), `CompiledFinding.kind`, `CompileReport {skills, memory, commands, agents}` consistent across Tasks 3–7. `canon_compile_findings` name matches in Rust command, lib.rs handler, and api.ts wrapper.

**Open confirmations resolved:** slug-from-title (spec-approved). Skill overwrite is the only collision guard; other kinds dedupe silently — noted in Task 7.
