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
    exclude: ["**/node_modules/**", "**/dist/**", "landing/**"],
  },
});
