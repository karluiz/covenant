# Continue with… Harness Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From a pane that already has a live executor, let the user right-click → **Continue with…** → pick another PTY spawn, open a new tab in the same placement, and inject a brief + last-5-blocks context into that harness.

**Architecture:** Pure prompt/eligibility helpers in `ui/src/continue-with.ts`. Pane context menu gains a submenu gated on `pane.executor`, wired via a `TabManager` callback (same pattern as `runDefaultAgent`). `main.ts` orchestrates: `readSessionExcerpt` → `createTab` with `buildSpawnCmdline` (no new worktree) → wait for dest executor (or timeout) → `sendPromptToSession`.

**Tech Stack:** TypeScript (strict), Vitest, existing Tauri commands (`read_session_excerpt`, `spawns_list`), no new Rust.

**Spec:** `docs/superpowers/specs/2026-08-05-continue-with-harness-design.md`

## Global Constraints

- **Gate:** menu item only when `pane.executor` is truthy.
- **Destinations:** `listSpawns()` filtered to non-ACP (`!spec.acp`) PTY spawns whose `detectExecutor([command,...args].join(" "))` is not equal to the source `pane.executor`. If the list is empty after filter, omit the menu item.
- **Always a new tab.** Never write into the source PTY. Never call `resolveLaunch` / never create a fresh worktree — reuse `pane.cwd` (and tab `groupId` / `color`) as-is.
- **Prompt delivery:** launch via `buildSpawnCmdline` as `initialCommand`; deliver the continue text with `sendPromptToSession` (bracketed paste). Do **not** `shellQuote` the excerpt into argv.
- **Caps:** `N = 5` blocks; total prompt clipped to `MAX_CONTINUE_PROMPT_CHARS = 14_000`.
- **Secrets:** rely on `readSessionExcerpt` / backend tails — do not re-mask in the frontend.
- TypeScript `strict`; no `as any` without a justifying comment. UI copy English. No native tooltips.
- Tests from **repo root**: `npx vitest run ui/src/continue-with.test.ts`, `npx tsc --noEmit -p tsconfig.json`. Never `git add -A` in a linked worktree (stages `node_modules` symlink) — stage paths explicitly. Conventional Commits, one commit per task.

## File map

| File | Responsibility |
|---|---|
| `ui/src/continue-with.ts` | `buildContinuePrompt`, `eligibleContinueSpawns`, `clipContinuePrompt`, `waitForExecutor` |
| `ui/src/continue-with.test.ts` | Unit tests for the above |
| `ui/src/tabs/manager.ts` | Context-menu submenu + `continueWithHarness` callback |
| `ui/src/main.ts` | Wire callback: excerpt → createTab → wait → sendPrompt → toasts |

---

### Task 1: Pure continue-with helpers + tests

**Files:**
- Create: `ui/src/continue-with.ts`
- Create: `ui/src/continue-with.test.ts`

**Interfaces:**
- Consumes: `SpawnSpec` from `ui/src/spawns/types.ts`; `detectExecutor` from `ui/src/executor.ts`; `SessionExcerpt` shape from `ui/src/api.ts` (or a local structural type mirroring `recent`).
- Produces:
  - `MAX_CONTINUE_PROMPT_CHARS = 14_000`
  - `CONTINUE_BLOCK_COUNT = 5`
  - `CONTINUE_INJECT_TIMEOUT_MS = 8_000`
  - `CONTINUE_INJECT_POLL_MS = 200`
  - `buildContinuePrompt(input: ContinuePromptInput): string`
  - `clipContinuePrompt(text: string, maxChars?: number): string`
  - `eligibleContinueSpawns(specs: SpawnSpec[], sourceExecutor: string): SpawnSpec[]`
  - `waitForExecutor(opts: { getExecutor: () => string | null; timeoutMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void> }): Promise<boolean>`

```ts
export interface ContinuePromptInput {
  sourceExecutor: string;
  destLabel: string;
  cwd: string;
  branch: string | null;
  recent: Array<{ command: string; exit_code: number | null; tail: string }>;
}
```

- [ ] **Step 1: Write the failing tests**

Create `ui/src/continue-with.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import {
  buildContinuePrompt,
  clipContinuePrompt,
  eligibleContinueSpawns,
  waitForExecutor,
  MAX_CONTINUE_PROMPT_CHARS,
} from "./continue-with";
import type { SpawnSpec } from "./spawns/types";

function spec(over: Partial<SpawnSpec> & Pick<SpawnSpec, "id" | "command">): SpawnSpec {
  return {
    label: over.label ?? over.id,
    icon: null,
    args: over.args ?? [],
    env: {},
    cwd: null,
    default: false,
    ...over,
  };
}

describe("buildContinuePrompt", () => {
  it("includes source, dest, cwd, branch, blocks oldest-first, and instruction", () => {
    const text = buildContinuePrompt({
      sourceExecutor: "claude",
      destLabel: "Cursor",
      cwd: "/repo/wt",
      branch: "agent/foo",
      recent: [
        { command: "ls", exit_code: 0, tail: "a\n" },
        { command: "cargo test", exit_code: 1, tail: "FAIL\n" },
      ],
    });
    expect(text).toContain("Source: claude · cwd /repo/wt · branch agent/foo");
    expect(text).toContain("continue with Cursor");
    expect(text.indexOf("$ ls")).toBeLessThan(text.indexOf("$ cargo test"));
    expect(text).toContain("(exit 1)");
    expect(text).toContain("FAIL");
    expect(text).toMatch(/Pick up where the previous harness left off/);
  });

  it("omits branch segment when branch is null", () => {
    const text = buildContinuePrompt({
      sourceExecutor: "claude",
      destLabel: "Codex",
      cwd: "/r",
      branch: null,
      recent: [],
    });
    expect(text).toContain("Source: claude · cwd /r");
    expect(text).not.toContain("branch");
  });

  it("still produces a usable brief when recent is empty", () => {
    const text = buildContinuePrompt({
      sourceExecutor: "claude",
      destLabel: "Codex",
      cwd: "/r",
      branch: null,
      recent: [],
    });
    expect(text).toContain("Continue this work from another harness");
    expect(text).toContain("cwd /r");
  });
});

describe("clipContinuePrompt", () => {
  it("returns text unchanged under the cap", () => {
    expect(clipContinuePrompt("hi", 100)).toBe("hi");
  });

  it("truncates from the middle context and notes truncation", () => {
    const huge = "x".repeat(MAX_CONTINUE_PROMPT_CHARS + 500);
    const out = clipContinuePrompt(huge);
    expect(out.length).toBeLessThanOrEqual(MAX_CONTINUE_PROMPT_CHARS);
    expect(out).toContain("[truncated]");
  });
});

describe("eligibleContinueSpawns", () => {
  it("drops ACP specs and the current executor", () => {
    const list = eligibleContinueSpawns(
      [
        spec({ id: "1", command: "claude", label: "Claude" }),
        spec({ id: "2", command: "agent", label: "Cursor" }),
        spec({ id: "3", command: "codex", label: "Codex", acp: true }),
        spec({ id: "4", command: "gh", args: ["copilot"], label: "Copilot" }),
      ],
      "claude",
    );
    expect(list.map((s) => s.id)).toEqual(["2", "4"]);
  });

  it("returns empty when nothing remains", () => {
    expect(
      eligibleContinueSpawns([spec({ id: "1", command: "claude" })], "claude"),
    ).toEqual([]);
  });
});

describe("waitForExecutor", () => {
  it("resolves true when getExecutor becomes non-null", async () => {
    let n = 0;
    const ok = await waitForExecutor({
      getExecutor: () => (++n >= 3 ? "cursor" : null),
      timeoutMs: 1000,
      pollMs: 1,
      sleep: async () => {},
    });
    expect(ok).toBe(true);
  });

  it("resolves false on timeout", async () => {
    const ok = await waitForExecutor({
      getExecutor: () => null,
      timeoutMs: 5,
      pollMs: 1,
      sleep: async () => {},
    });
    expect(ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

Run: `npx vitest run ui/src/continue-with.test.ts`

Expected: FAIL — module `./continue-with` not found / exports missing.

- [ ] **Step 3: Implement `ui/src/continue-with.ts`**

```ts
import { detectExecutor } from "./executor";
import type { SpawnSpec } from "./spawns/types";

export const MAX_CONTINUE_PROMPT_CHARS = 14_000;
export const CONTINUE_BLOCK_COUNT = 5;
export const CONTINUE_INJECT_TIMEOUT_MS = 8_000;
export const CONTINUE_INJECT_POLL_MS = 200;

export interface ContinuePromptInput {
  sourceExecutor: string;
  destLabel: string;
  cwd: string;
  branch: string | null;
  recent: Array<{ command: string; exit_code: number | null; tail: string }>;
}

export function buildContinuePrompt(input: ContinuePromptInput): string {
  const sourceLine = input.branch
    ? `Source: ${input.sourceExecutor} · cwd ${input.cwd} · branch ${input.branch}`
    : `Source: ${input.sourceExecutor} · cwd ${input.cwd}`;

  const blocks: string[] = [];
  for (const b of input.recent) {
    const exit = b.exit_code === null ? "?" : String(b.exit_code);
    blocks.push(`$ ${b.command}  (exit ${exit})`);
    const tail = b.tail.trimEnd();
    if (tail) blocks.push(tail);
    blocks.push("");
  }

  const context =
    blocks.length > 0
      ? blocks.join("\n").trimEnd()
      : "(no recent finished blocks)";

  return [
    "Continue this work from another harness.",
    "",
    sourceLine,
    `Why: user asked to continue with ${input.destLabel}.`,
    "",
    "## Recent terminal context (oldest → newest)",
    context,
    "",
    "## Instruction",
    "Pick up where the previous harness left off. Prefer the existing worktree/branch; don't re-scaffold. Summarize what you understood, then continue.",
  ].join("\n");
}

export function clipContinuePrompt(
  text: string,
  maxChars: number = MAX_CONTINUE_PROMPT_CHARS,
): string {
  if (text.length <= maxChars) return text;
  const keep = Math.max(0, maxChars - "\n\n[truncated]\n".length);
  return text.slice(0, keep) + "\n\n[truncated]\n";
}

export function eligibleContinueSpawns(
  specs: SpawnSpec[],
  sourceExecutor: string,
): SpawnSpec[] {
  return specs.filter((s) => {
    if (!s.command) return false;
    if (s.acp) return false;
    const name = detectExecutor([s.command, ...s.args].join(" "));
    if (!name) return true; // unknown cmdline — still offer (user's spawn)
    return name !== sourceExecutor;
  });
}

export async function waitForExecutor(opts: {
  getExecutor: () => string | null;
  timeoutMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? CONTINUE_INJECT_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? CONTINUE_INJECT_POLL_MS;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (opts.getExecutor()) return true;
    await sleep(pollMs);
  }
  return !!opts.getExecutor();
}
```

- [ ] **Step 4: Run tests — expect PASS**

Run: `npx vitest run ui/src/continue-with.test.ts`

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/continue-with.ts ui/src/continue-with.test.ts
git commit -m "$(cat <<'EOF'
feat(continue-with): prompt builder + spawn eligibility helpers

Pure helpers for Continue with… — template, clip, filter, wait-for-executor.
EOF
)"
```

---

### Task 2: Pane context-menu submenu

**Files:**
- Modify: `ui/src/tabs/manager.ts` (near `showPaneContextMenu` / `runDefaultAgent` callback fields ~2328 and the Start ACP block ~2156–2184)

**Interfaces:**
- Consumes: `eligibleContinueSpawns`, `SpawnSpec`, `brandIconSvg`, `detectExecutor`, `Icons`.
- Produces:
  - `TabManager.continueWithHarness: ((args: ContinueWithArgs) => void) | null = null`
  - `TabManager.listContinueSpawns: (() => Promise<SpawnSpec[]>) | null = null`

```ts
export interface ContinueWithArgs {
  sourceSessionId: string;
  sourceExecutor: string;
  cwd: string;
  groupId: string | null;
  color: string | null;
  dest: SpawnSpec;
}
```

(Define `ContinueWithArgs` in `continue-with.ts` and re-export, or inline next to the callback in `manager.ts` — prefer exporting from `continue-with.ts` so main + manager share one type.)

- [ ] **Step 1: Export `ContinueWithArgs` from `continue-with.ts`**

Add to `ui/src/continue-with.ts`:

```ts
export interface ContinueWithArgs {
  sourceSessionId: string;
  sourceExecutor: string;
  cwd: string;
  groupId: string | null;
  color: string | null;
  dest: SpawnSpec;
}
```

- [ ] **Step 2: Add callbacks on `TabManager`**

Next to `runDefaultAgent` (~2328):

```ts
  /// Pane menu → Continue with… — hand context to another PTY harness.
  public continueWithHarness: ((args: ContinueWithArgs) => void) | null = null;
  /// Supplies the user's spawn list for the Continue with… submenu.
  public listContinueSpawns: (() => Promise<SpawnSpec[]>) | null = null;
```

Import `ContinueWithArgs` and `SpawnSpec` (and `eligibleContinueSpawns`) at the top of `manager.ts`.

- [ ] **Step 3: Render the submenu in `showPaneContextMenu`**

After the **Start ACP** `addSubmenu(...)` block (~2184), and only when `sessionId && pane?.executor && this.continueWithHarness && this.listContinueSpawns`:

```ts
    if (sessionId && pane?.executor && this.continueWithHarness && this.listContinueSpawns) {
      const sourceExecutor = pane.executor;
      const continueCb = this.continueWithHarness;
      const listFn = this.listContinueSpawns;
      const cwd = pane.cwd ?? this.activeCwd() ?? "";
      let continueSpecs: SpawnSpec[] = [];
      try {
        continueSpecs = eligibleContinueSpawns(await listFn(), sourceExecutor);
      } catch {
        continueSpecs = [];
      }
      if (continueSpecs.length > 0) {
        addSubmenu(
          "Continue with…",
          continueSpecs.map((s) => {
            const execName =
              detectExecutor([s.command, ...s.args].join(" ")) ?? s.label;
            return {
              label: s.label,
              icon: brandIconSvg(execName, 16) ?? Icons.sparkles(),
              action: () =>
                continueCb({
                  sourceSessionId: sessionId,
                  sourceExecutor,
                  cwd,
                  groupId,
                  color: tab.color,
                  dest: s,
                }),
            };
          }),
          Icons.refresh(), // or Icons.sparkles() if refresh feels wrong — match nearby icons
        );
      }
    }
```

Use an existing icon that reads as “hand off / switch” if `Icons.refresh()` is odd in this menu — `Icons.sparkles()` is fine as fallback (same as Start ACP parent).

Note: `showPaneContextMenu` is already `async`; awaiting `listFn()` here matches the existing awaits for commands/prompts.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`

Expected: PASS (callbacks still null until Task 3).

- [ ] **Step 5: Commit**

```bash
git add ui/src/continue-with.ts ui/src/tabs/manager.ts
git commit -m "$(cat <<'EOF'
feat(ui): Continue with… pane context submenu

Gated on live pane.executor; lists eligible non-ACP spawns via callback.
EOF
)"
```

---

### Task 3: Wire orchestration in `main.ts`

**Files:**
- Modify: `ui/src/main.ts` (near spawn chip / `runSpawn` wiring ~1360–1580)

**Interfaces:**
- Consumes: `ContinueWithArgs`, `buildContinuePrompt`, `clipContinuePrompt`, `CONTINUE_BLOCK_COUNT`, `waitForExecutor` from `continue-with.ts`; `readSessionExcerpt`, `gitRepoSummary` from `api.ts`; `listSpawns`, `buildSpawnCmdline`; `sendPromptToSession` from `project-notes/paste.ts`; `pushInfoToast`; `claudeTheme()` (already in scope where spawns are wired).
- Produces: wired `manager.listContinueSpawns` + `manager.continueWithHarness`.

- [ ] **Step 1: Import helpers**

At the top of `main.ts` with the other imports:

```ts
import {
  buildContinuePrompt,
  clipContinuePrompt,
  CONTINUE_BLOCK_COUNT,
  waitForExecutor,
  type ContinuePromptInput,
  type ContinueWithArgs,
} from "./continue-with";
import { sendPromptToSession } from "./project-notes/paste";
```

(`readSessionExcerpt` / `gitRepoSummary` — import from `./api` if not already. `buildSpawnCmdline` / `listSpawns` / `claudeTheme` already in the spawn-wiring scope.)

- [ ] **Step 2: Assign `listContinueSpawns`**

Inside the block where `listSpawns` / `runSpawn` are set up (after `manager.defaultAgentCmdline` is fine):

```ts
    manager.listContinueSpawns = () => listSpawns();
```

- [ ] **Step 3: Implement `continueWithHarness`**

```ts
    manager.continueWithHarness = (args: ContinueWithArgs): void => {
      void (async () => {
        const { dest } = args;
        if (!dest.command) return;

        let recent: ContinuePromptInput["recent"] = [];
        let excerptCwd = args.cwd;
        try {
          const excerpt = await readSessionExcerpt(
            args.sourceSessionId,
            CONTINUE_BLOCK_COUNT,
          );
          recent = excerpt.recent;
          if (excerpt.cwd) excerptCwd = excerpt.cwd;
        } catch {
          pushInfoToast({ message: "No recent blocks — launching with a minimal brief" });
        }

        let branch: string | null = null;
        try {
          if (excerptCwd) {
            branch = (await gitRepoSummary(excerptCwd)).current_branch;
          }
        } catch {
          /* omit branch */
        }

        const prompt = clipContinuePrompt(
          buildContinuePrompt({
            sourceExecutor: args.sourceExecutor,
            destLabel: dest.label,
            cwd: excerptCwd || args.cwd || "(unknown)",
            branch,
            recent,
          }),
        );

        const cmdline = buildSpawnCmdline(dest, claudeTheme()) + "\n";
        let tab;
        try {
          tab = await manager.createTab({
            cwd: args.cwd || null,
            groupId: args.groupId,
            color: args.color,
            defaultTitle: `Continue · ${dest.label}`,
            initialCommand: cmdline,
            scrubLaunch: true,
          });
        } catch (e) {
          pushInfoToast({
            message: `Couldn’t open tab: ${e instanceof Error ? e.message : String(e)}`,
          });
          return;
        }
        if (!tab) {
          pushInfoToast({ message: "Couldn’t open tab for Continue with…" });
          return;
        }

        const destSessionId = tab.panes[0]?.sessionId ?? null;
        if (!destSessionId) {
          pushInfoToast({ message: "Tab opened but session missing — paste context manually" });
          return;
        }

        manager.setActiveSpawnId(dest.id);
        requestAnimationFrame(() => manager.focusActive());

        const ready = await waitForExecutor({
          getExecutor: () => {
            const t = manager.getTab?.(tab.id) ?? tab;
            // Prefer live tab from manager if a getter exists; else close over `tab`
            // and read pane.executor (detection mutates the same pane object).
            return t.panes[0]?.executor ?? null;
          },
        });

        try {
          await sendPromptToSession(destSessionId, prompt);
          pushInfoToast({
            message: ready
              ? `Continuing with ${dest.label}`
              : `Continuing with ${dest.label} (agent may still be starting)`,
          });
        } catch (e) {
          pushInfoToast({
            message: `Tab ready — couldn’t send context: ${
              e instanceof Error ? e.message : String(e)
            }`,
          });
        }
      })();
    };
```

**Lookup note:** `TabManager` may not expose `getTab`. Prefer closing over the returned `tab` and reading `tab.panes[0]?.executor` — OSC detection mutates that pane in place. If the tab object is replaced on restore, find an existing public lookup (e.g. iterate `manager` tabs if there is `tabs` access, or add a one-liner `tabById(id: string): Tab | null` public method). Do **not** invent a large API — smallest possible.

If `ContinuePromptInput` is needed in the type position above, import the type or inline the `recent` array type.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`

Expected: PASS. Fix any missing imports / Tab lookup.

- [ ] **Step 5: Manual smoke (dev)**

1. `npm run tauri:dev` (or attach to running app).
2. In a group worktree tab, start Claude (or any PTY spawn).
3. Right-click pane → **Continue with…** → pick another harness (e.g. Cursor / Codex).
4. Confirm: new tab titled `Continue · …`, same cwd/group; source tab untouched; dest receives the continue prompt after launch.
5. Right-click an idle pane (no executor) → item absent.
6. Confirm secrets in recent output stay masked (use a fake `sk-…` in a finished block if easy).

- [ ] **Step 6: Commit**

```bash
git add ui/src/main.ts ui/src/tabs/manager.ts ui/src/continue-with.ts
git commit -m "$(cat <<'EOF'
feat(continue-with): wire Continue with… spawn + prompt inject

New tab same placement; excerpt context via sendPromptToSession after executor ready.
EOF
)"
```

---

## Spec coverage (self-review)

| Spec requirement | Task |
|---|---|
| Gate on `pane.executor` | 2 |
| New tab, same group/cwd/color, no new worktree | 3 |
| Eligible spawns: non-ACP, exclude current executor | 1 + 2 |
| Brief + N=5 blocks, clip, mask via excerpt | 1 + 3 |
| Launch cmdline + separate prompt paste | 3 |
| Toasts / best-effort errors | 3 |
| No quota detection / no ACP dest / no kill source | — out of scope, not implemented |

No TBD placeholders. Types (`ContinueWithArgs`, `ContinuePromptInput`) defined in Task 1 and reused in 2–3.
