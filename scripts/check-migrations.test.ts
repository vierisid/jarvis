import { describe, expect, test } from "bun:test";
import { contractKind, scanContent, OK_MARKER } from "./check-migrations.ts";

describe("check-migrations contractKind", () => {
  test("flags contracting DDL", () => {
    expect(contractKind("db.run('ALTER TABLE t DROP COLUMN c')")).toBe("DROP COLUMN");
    expect(contractKind("db.run('DROP TABLE t')")).toBe("DROP TABLE");
    expect(contractKind("db.run('ALTER TABLE t RENAME COLUMN a TO b')")).toBe("RENAME COLUMN");
    expect(contractKind("db.run('ALTER TABLE t RENAME TO t2')")).toBe("RENAME TABLE");
    expect(contractKind("db.run('ALTER TABLE t ADD COLUMN c TEXT NOT NULL')")).toBe(
      "ADD COLUMN NOT NULL without DEFAULT",
    );
  });

  test("allows additive DDL", () => {
    expect(contractKind("db.run('ALTER TABLE t ADD COLUMN c TEXT')")).toBeNull();
    expect(contractKind("db.run(`ALTER TABLE t ADD COLUMN c TEXT NOT NULL DEFAULT ''`)")).toBeNull();
    expect(contractKind("db.run('CREATE TABLE IF NOT EXISTS t (id INTEGER)')")).toBeNull();
    expect(contractKind("db.run('CREATE INDEX IF NOT EXISTS i ON t(c)')")).toBeNull();
  });

  test("scanContent reports un-acknowledged contracts but honors the marker", () => {
    const bad = "db.run('ALTER TABLE t DROP COLUMN c')";
    expect(scanContent("f.ts", bad)).toHaveLength(1);
    expect(scanContent("f.ts", `${bad} // ${OK_MARKER}: reader gone`)).toHaveLength(0);
  });
});
