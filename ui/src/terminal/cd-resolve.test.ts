import { describe, it, expect } from "vitest";
import { homeFromCwd, resolveCdArg, filterDirs, parseCdLine } from "./cd-resolve";
import type { DirEntry } from "../api";

describe("parseCdLine", () => {
  it("bare 'cd ' (trailing space) triggers with empty arg", () => expect(parseCdLine("cd ")).toBe(""));
  it("captures the path arg", () => expect(parseCdLine("cd src/comp")).toBe("src/comp"));
  it("'cd' without a space is not a trigger", () => expect(parseCdLine("cd")).toBeNull());
  it("does not match other commands starting with cd", () => expect(parseCdLine("cdk deploy")).toBeNull());
  it("non-cd line is null", () => expect(parseCdLine("ls -la")).toBeNull());
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
});
