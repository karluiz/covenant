import { describe, it, expect } from "vitest";
// Same node:fs idiom as ui/src/theme/light-surfaces.test.ts — Vite's CSS
// transform makes `?raw` imports empty, so read the file off disk.
// @ts-expect-error node:fs is untyped under this tsconfig
import { readFileSync } from "node:fs";

describe("tasker styles cascade", () => {
  it("base .tasker-kv rule precedes the -notes/-subs align overrides", () => {
    // @ts-expect-error process is a nodejs global, untyped here
    const css: string = readFileSync(`${process.cwd()}/ui/src/tasker/styles.css`, "utf-8");
    const base = css.indexOf(".tasker-kv {");
    const notes = css.indexOf(".tasker-kv-notes {");
    const subs = css.indexOf(".tasker-kv-subs {");
    expect(base).toBeGreaterThan(-1);
    expect(notes).toBeGreaterThan(-1);
    expect(subs).toBeGreaterThan(-1);
    // Equal specificity: if the base rule (align-items: center) comes after
    // the stretch overrides, subtask rows center and long titles bleed past
    // the sheet's left edge.
    expect(base).toBeLessThan(notes);
    expect(base).toBeLessThan(subs);
  });
});
