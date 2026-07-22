import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    // `landing/` is its own npm project with its own runners (`vitest run`
    // for src, Playwright for tests/). Swept up by the default include, its
    // unit tests fail on deps that only exist under `landing/node_modules`
    // and its `.spec.ts` files are Playwright suites vitest cannot run.
    // Worktree dirs (all three conventions — see AGENTS.md "Worktrees")
    // hold full checkouts whose ui/src duplicates this suite. Swept up, a
    // root `vitest run` becomes a ~16x multi-minute run that reports stale
    // worktrees' failures as if they were main's.
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "landing/**",
      ".covenant/**",
      ".claude/**",
      ".worktrees/**",
    ],
  },
});
