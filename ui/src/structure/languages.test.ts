import { describe, it, expect } from "vitest";
import { sqlDialectFor, isDotenvPath, languageForPath } from "./languages";

describe("isDotenvPath", () => {
  it("matches bare .env", () => {
    expect(isDotenvPath("/x/raven-prep/clever-hub/.env")).toBe(true);
  });

  it("matches .env.<stage> variants", () => {
    expect(isDotenvPath(".env.local")).toBe(true);
    expect(isDotenvPath("/a/.env.production")).toBe(true);
    expect(isDotenvPath(".env.example")).toBe(true);
  });

  it("matches *.env files", () => {
    expect(isDotenvPath("config.env")).toBe(true);
    expect(isDotenvPath("/srv/prod.env")).toBe(true);
  });

  it("does not match unrelated dotfiles or names", () => {
    expect(isDotenvPath(".environment")).toBe(false);
    expect(isDotenvPath(".zshrc")).toBe(false);
    expect(isDotenvPath("env.ts")).toBe(false);
    expect(isDotenvPath("/x/server.rs")).toBe(false);
  });

  it("languageForPath resolves a grammar for .env (not null)", () => {
    expect(languageForPath("/x/clever-hub/.env")).not.toBeNull();
    expect(languageForPath(".env.local")).not.toBeNull();
  });
});

describe("languageForPath grammars", () => {
  it("resolves YAML for .yml/.yaml (covers Ansible playbooks)", () => {
    expect(languageForPath("playbook.yml")).not.toBeNull();
    expect(languageForPath("site.yaml")).not.toBeNull();
  });

  it("resolves HCL for Terraform files", () => {
    expect(languageForPath("main.tf")).not.toBeNull();
    expect(languageForPath("prod.tfvars")).not.toBeNull();
    expect(languageForPath("config.hcl")).not.toBeNull();
  });

  it("resolves PowerShell for .ps1/.psm1/.psd1", () => {
    expect(languageForPath("sign-windows.ps1")).not.toBeNull();
    expect(languageForPath("module.psm1")).not.toBeNull();
    expect(languageForPath("manifest.psd1")).not.toBeNull();
  });

  it("resolves clike family for .java/.kt/.c/.cpp", () => {
    expect(languageForPath("Main.java")).not.toBeNull();
    expect(languageForPath("Build.kts")).not.toBeNull();
    expect(languageForPath("pty.c")).not.toBeNull();
    expect(languageForPath("term.hpp")).not.toBeNull();
  });

  it("resolves Go for .go", () => {
    expect(languageForPath("main.go")).not.toBeNull();
  });

  it("resolves properties for ini-style configs, by ext and by name", () => {
    expect(languageForPath("setup.ini")).not.toBeNull();
    expect(languageForPath("app.properties")).not.toBeNull();
    expect(languageForPath("sshd.conf")).not.toBeNull();
    expect(languageForPath(".gitconfig")).not.toBeNull();
    expect(languageForPath(".editorconfig")).not.toBeNull();
  });

  it("resolves diff for .diff/.patch", () => {
    expect(languageForPath("fix.diff")).not.toBeNull();
    expect(languageForPath("0001-fix.patch")).not.toBeNull();
  });

  it("resolves nginx for nginx.conf by basename", () => {
    expect(languageForPath("/etc/nginx/nginx.conf")).not.toBeNull();
  });

  it("returns null for unknown extensions", () => {
    expect(languageForPath("x.unknownext")).toBeNull();
  });
});

describe("sqlDialectFor", () => {
  it("returns PostgreSQL for .psql extension regardless of content", () => {
    expect(sqlDialectFor("/x/foo.psql", "SELECT 1;").name).toBe("PostgreSQL");
  });

  it("returns MySQL for .mysql extension", () => {
    expect(sqlDialectFor("/x/foo.mysql", "SELECT 1;").name).toBe("MySQL");
  });

  it("honors explicit -- dialect: marker in head", () => {
    const head = "-- dialect: sqlite\nSELECT * FROM t;";
    expect(sqlDialectFor("/x/foo.sql", head).name).toBe("SQLite");
  });

  it("marker is case-insensitive and tolerates whitespace", () => {
    const head = "  --   Dialect:   MSSQL  \nSELECT 1;";
    expect(sqlDialectFor("/x/foo.sql", head).name).toBe("MSSQL");
  });

  it("ignores dialect marker past first ~20 lines", () => {
    const head = "\n".repeat(25) + "-- dialect: postgres\n";
    expect(sqlDialectFor("/x/foo.sql", head).name).toBe("StandardSQL");
  });

  it("heuristic: RETURNING → PostgreSQL", () => {
    expect(
      sqlDialectFor("/x/q.sql", "INSERT INTO t(a) VALUES(1) RETURNING id;").name,
    ).toBe("PostgreSQL");
  });

  it("heuristic: AUTO_INCREMENT → MySQL", () => {
    expect(
      sqlDialectFor(
        "/x/q.sql",
        "CREATE TABLE t (id INT AUTO_INCREMENT PRIMARY KEY);",
      ).name,
    ).toBe("MySQL");
  });

  it("heuristic: IDENTITY(1,1) → MSSQL", () => {
    expect(
      sqlDialectFor("/x/q.sql", "CREATE TABLE t (id INT IDENTITY(1,1));").name,
    ).toBe("MSSQL");
  });

  it("heuristic: PRAGMA → SQLite", () => {
    expect(sqlDialectFor("/x/q.sql", "PRAGMA foreign_keys = ON;").name).toBe(
      "SQLite",
    );
  });

  it("fallback: plain SQL → StandardSQL", () => {
    expect(sqlDialectFor("/x/q.sql", "SELECT 1;").name).toBe("StandardSQL");
  });

  it("missing head defaults to StandardSQL for generic .sql", () => {
    expect(sqlDialectFor("/x/q.sql", "").name).toBe("StandardSQL");
  });

  it("ignores dialect keywords inside line comments", () => {
    const head =
      "-- NOTE: MySQL does not support RETURNING\nINSERT INTO t(a) VALUES (1);";
    expect(sqlDialectFor("/x/q.sql", head).name).toBe("StandardSQL");
  });

  it("heuristic: lowercase autoincrement → SQLite (case-insensitive)", () => {
    expect(
      sqlDialectFor("/x/q.sql", "CREATE TABLE t (id INTEGER PRIMARY KEY autoincrement);").name,
    ).toBe("SQLite");
  });
});
