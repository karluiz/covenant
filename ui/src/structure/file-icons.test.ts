import { describe, it, expect } from "vitest";
import { resolveFileIcon, resolveFolderIcon } from "./file-icons";

describe("resolveFileIcon — exact filenames", () => {
  it("package.json → package color", () => {
    const r = resolveFileIcon("package.json");
    expect(r.color).toBe("#9a8b3c");
    expect(r.svg).toContain("<svg");
  });
  it("package-lock.json is treated as a lockfile", () => {
    expect(resolveFileIcon("package-lock.json").color).toBe("#7d8590");
  });
  it("Dockerfile (any case) → config gray", () => {
    expect(resolveFileIcon("Dockerfile").color).toBe("#7d8590");
    expect(resolveFileIcon("dockerfile").color).toBe("#7d8590");
  });
  it("README.md → markdown color", () => {
    expect(resolveFileIcon("README.md").color).toBe("#8a93a0");
  });
  it(".gitignore → config gray", () => {
    expect(resolveFileIcon(".gitignore").color).toBe("#7d8590");
  });
  it(".env → config gray", () => {
    expect(resolveFileIcon(".env").color).toBe("#7d8590");
  });
});

describe("resolveFileIcon — compound extensions", () => {
  it(".d.ts → ts color", () => {
    expect(resolveFileIcon("next-env.d.ts").color).toBe("#4d7eaa");
  });
  it("next.config.js → js color", () => {
    expect(resolveFileIcon("next.config.js").color).toBe("#b8a13e");
  });
});

describe("resolveFileIcon — simple extensions", () => {
  it.each([
    ["firebase.ts", "#4d7eaa"],
    ["i18n.js", "#b8a13e"],
    ["main.rs", "#c07a52"],
    ["components.json", "#9a8b3c"],
    ["build.css", "#5a8fb0"],
    ["app.py", "#5a86a8"],
    ["logo.svg", "#9a6fa0"],
    ["query.sql", "#4f9aa8"],
  ])("%s → %s", (name, color) => {
    expect(resolveFileIcon(name).color).toBe(color);
  });
});

describe("resolveFileIcon — dotfile & fallback", () => {
  it(".eslintignore → config gear gray", () => {
    expect(resolveFileIcon(".eslintignore").color).toBe("#7d8590");
  });
  it(".prettierignore → config gear gray", () => {
    expect(resolveFileIcon(".prettierignore").color).toBe("#7d8590");
  });
  it("txt is mapped; unknown extension → fallback gray", () => {
    expect(resolveFileIcon("outdated_packages.txt").color).toBe("#8a93a0");
    expect(resolveFileIcon("mystery.xyz").color).toBe("#6e7681");
  });
});

describe("resolveFolderIcon", () => {
  it("known folder .github → glyph; src open differs from src closed", () => {
    const closed = resolveFolderIcon(".github", false);
    expect(closed.svg).toContain("<svg");
    expect(resolveFolderIcon("src", true).svg).not.toBe(
      resolveFolderIcon("src", false).svg,
    );
  });
  it("unknown folder open vs closed returns different svg", () => {
    expect(resolveFolderIcon("whatever", true).svg).not.toBe(
      resolveFolderIcon("whatever", false).svg,
    );
  });
  it("unknown folder has a tint color", () => {
    expect(resolveFolderIcon("whatever", false).color).toBe("#6f7681");
  });
});
