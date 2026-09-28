import { describe, expect, it } from "vitest";
import { selectMigrations } from "@/lib/platform/migrations";

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
