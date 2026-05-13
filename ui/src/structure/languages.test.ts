import { describe, it, expect } from "vitest";
import { sqlDialectFor } from "./languages";

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
});
