import { readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { selectMigrations } from "@/lib/platform/migrations";

const MIGRATIONS_DIR = path.join(process.cwd(), "supabase", "migrations");

const FILES = ["0001_init.sql", "0015_tenancy.sql", "0016_org_scoped_rpcs.sql", "0017_org_scope_contract.sql"];

describe("selectMigrations", () => {
  it("applies everything when no bound is given", () => {
    expect(selectMigrations(FILES, undefined)).toEqual(FILES);
  });

  it("stops after the file the bound names by its number", () => {
    expect(selectMigrations(FILES, "0016")).toEqual(FILES.slice(0, 3));
  });

  it("accepts the full file name as the bound", () => {
    expect(selectMigrations(FILES, "0015_tenancy.sql")).toEqual(FILES.slice(0, 2));
  });

  it("refuses a bound that names no migration, rather than applying everything", () => {
    expect(() => selectMigrations(FILES, "0099")).toThrow(/no migration matches --through 0099/);
  });

  it("refuses a bound that names more than one migration", () => {
    expect(() => selectMigrations(FILES, "001")).toThrow(/matches more than one migration/);
  });
});

describe("supabase/migrations", () => {
  const files = readdirSync(MIGRATIONS_DIR).filter((file) => file.endsWith(".sql"));

  it("names every migration by a four-digit number, then words", () => {
    for (const file of files) expect(file).toMatch(/^\d{4}_[a-z0-9_]+\.sql$/);
  });

  it("gives no two migrations the same number, so --through always names one (two branches merged the same number)", () => {
    const byNumber = new Map<string, string[]>();
    for (const file of files) byNumber.set(file.slice(0, 4), [...(byNumber.get(file.slice(0, 4)) ?? []), file]);
    expect([...byNumber.values()].filter((same) => same.length > 1)).toEqual([]);
    for (const number of byNumber.keys()) expect(() => selectMigrations(files, number)).not.toThrow();
  });
});
