import { describe, it, expect } from "vitest";
import { homeFromCwd, resolveCdArg, filterDirs, parsePathLine, frecency } from "./cd-resolve";
import type { DirEntry } from "../api";

describe("parsePathLine", () => {
  const arg = (l: string): string | null => parsePathLine(l)?.arg ?? null;

  it("bare 'cd ' (trailing space) triggers with empty arg", () => expect(arg("cd ")).toBe(""));
  it("captures the path arg", () => expect(arg("cd src/comp")).toBe("src/comp"));
  it("'cd' without a space is not a trigger", () => expect(parsePathLine("cd")).toBeNull());
  it("does not match other commands starting with cd", () => expect(parsePathLine("cdk deploy")).toBeNull());
  it("an unlisted verb is null", () => expect(parsePathLine("git status")).toBeNull());

  it("completes the LAST token, keeping the rest of the line", () => {
    expect(parsePathLine("cp src/a dst/b")).toEqual({
      arg: "dst/b",
      linePrefix: "cp src/a ",
      dirsOnly: false,
    });
  });
  it("a flag is not a path", () => expect(parsePathLine("ls -la")).toBeNull());
  it("flags before the path don't block it", () =>
    expect(parsePathLine("ls -la src/")).toMatchObject({ arg: "src/", linePrefix: "ls -la " }));
  it("an escaped space is one token, unescaped for matching", () =>
    expect(parsePathLine("cd my\\ dir")).toEqual({
      arg: "my dir",
      linePrefix: "cd ",
      dirsOnly: true,
    }));
  it("cd wants directories, cat does not", () => {
    expect(parsePathLine("cd x")?.dirsOnly).toBe(true);
    expect(parsePathLine("cat x")?.dirsOnly).toBe(false);
  });
});

describe("frecency", () => {
  const NOW = 1_700_000_000_000;
  const hAgo = (h: number): number => NOW - h * 3_600_000;

  it("recent beats often-but-old", () =>
    expect(frecency(1, hAgo(0.5), NOW)).toBeGreaterThan(frecency(3, hAgo(200), NOW)));
  it("count breaks ties inside a bucket", () =>
    expect(frecency(5, hAgo(2), NOW)).toBeGreaterThan(frecency(1, hAgo(3), NOW)));
  it("a future timestamp doesn't blow up the weight", () =>
    expect(frecency(1, NOW + 10_000, NOW)).toBe(4));
});

const dir = (name: string): DirEntry => ({ name, path: `/x/${name}`, kind: "dir", is_symlink: false });
const file = (name: string): DirEntry => ({ name, path: `/x/${name}`, kind: "file", is_symlink: false });

describe("homeFromCwd", () => {
  it("extracts macOS home", () => expect(homeFromCwd("/Users/karl/Sources/app")).toBe("/Users/karl"));
  it("extracts linux home", () => expect(homeFromCwd("/home/karl/x")).toBe("/home/karl"));
  it("returns null for non-home paths", () => expect(homeFromCwd("/opt/app")).toBeNull());
  it("returns null for null cwd", () => expect(homeFromCwd(null)).toBeNull());
});

describe("resolveCdArg", () => {
  const cwd = "/Users/karl/proj";
  const home = "/Users/karl";
  it("empty arg lists cwd", () => expect(resolveCdArg("", cwd, home)).toEqual({ listDir: cwd, prefix: "" }));
  it("bare prefix lists cwd, filters", () => expect(resolveCdArg("Doc", cwd, home)).toEqual({ listDir: cwd, prefix: "Doc" }));
  it("relative subdir splits at last slash", () => expect(resolveCdArg("src/comp", cwd, home)).toEqual({ listDir: "/Users/karl/proj/src", prefix: "comp" }));
  it("trailing slash lists that dir, empty prefix", () => expect(resolveCdArg("src/", cwd, home)).toEqual({ listDir: "/Users/karl/proj/src", prefix: "" }));
  it("absolute path", () => expect(resolveCdArg("/etc/ne", cwd, home)).toEqual({ listDir: "/etc", prefix: "ne" }));
  it("absolute root prefix", () => expect(resolveCdArg("/et", cwd, home)).toEqual({ listDir: "/", prefix: "et" }));
  it("tilde expands to home", () => expect(resolveCdArg("~/Doc", cwd, home)).toEqual({ listDir: home, prefix: "Doc" }));
  it("bare tilde lists home", () => expect(resolveCdArg("~", cwd, home)).toEqual({ listDir: home, prefix: "" }));
  it("null when no cwd and relative", () => expect(resolveCdArg("src", null, null)).toBeNull());
  it("null when tilde but no home", () => expect(resolveCdArg("~/x", cwd, null)).toBeNull());
});

describe("filterDirs", () => {
  const entries = [dir("Apps"), dir("apple"), file("app.txt"), dir("Desktop")];
  it("dirs only, case-insensitive prefix", () => expect(filterDirs(entries, "app").map((e) => e.name)).toEqual(["Apps", "apple"]));
  it("empty prefix returns all dirs", () => expect(filterDirs(entries, "").map((e) => e.name)).toEqual(["Apps", "apple", "Desktop"]));
  it("matches mid-name, prefix hits ranked first", () => {
    const es = [dir("soporte-ti-knowledgebase"), dir("knowledge"), file("knowledge.md")];
    expect(filterDirs(es, "knowledge").map((e) => e.name)).toEqual([
      "knowledge", // starts with it
      "soporte-ti-knowledgebase", // …then the mid-name hit, unreachable before
    ]);
  });
  it("non-matching names are still dropped", () =>
    expect(filterDirs(entries, "zzz")).toEqual([]));
  it("dirsOnly: false keeps files", () =>
    expect(filterDirs(entries, "app", { dirsOnly: false }).map((e) => e.name)).toEqual([
      "Apps", "apple", "app.txt",
    ]));
  it("rank orders within a match group, never across it", () => {
    const es = [dir("apps"), dir("api"), dir("legacy-app")];
    const score = new Map([["legacy-app", 99], ["api", 5]]);
    expect(
      filterDirs(es, "ap", { rank: (e) => score.get(e.name) ?? 0 }).map((e) => e.name),
    ).toEqual([
      "api", // prefix match, ranked 5
      "apps", // prefix match, unranked
      "legacy-app", // mid-name: frecency 99 still can't jump a prefix hit
    ]);
  });
});
