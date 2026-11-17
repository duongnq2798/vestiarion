import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PLATFORM_TABLES } from "@/lib/dal";
import { applyMigrations, createDatabase } from "./support/pglite";

/**
 * The tables Supabase's advisor lists as "RLS enabled, no policy" are the service role's alone, on purpose
 * (ARCHITECTURE, "Platform tables"): the platform tables `platformDb()` reaches, and three that only SECURITY DEFINER
 * functions read. Row level security with no policy refuses every row to every other role, and none of those roles
 * holds a privilege on them. A new table either joins one of these lists or gets 0018's tenant policies.
 */

/** Read and written only inside SECURITY DEFINER functions, never through `platformDb().from()`. */
const DEFINER_ONLY_TABLES = ["deleted_orgs", "org_attribution", "platform_team"];

let db: PGlite;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
}, 120_000);

afterAll(async () => {
  await db.close();
});

interface TableRow {
  name: string;
  rls: boolean;
  policies: number;
}

const tables = async () =>
  (
    await db.query<TableRow>(`
      select c.relname as name, c.relrowsecurity as rls,
             (select count(*)::int from pg_catalog.pg_policy p where p.polrelid = c.oid) as policies
        from pg_catalog.pg_class c
       where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
       order by 1`)
  ).rows;

describe("tables with row level security and no policy", () => {
  it("has row level security on for every table in public", async () => {
    expect((await tables()).filter((table) => !table.rls).map((table) => table.name)).toEqual([]);
  });

  it("are exactly the platform tables and the definer-only ones", async () => {
    const unpoliced = (await tables()).filter((table) => table.policies === 0).map((table) => table.name);
    expect(unpoliced).toEqual([...PLATFORM_TABLES, ...DEFINER_ONLY_TABLES].sort());
    expect(unpoliced).toHaveLength(35);
  });

  it("grant nothing to anon, authenticated or the tenant role", async () => {
    const granted = await db.query<{ table: string; role: string; privilege: string }>(
      `select c.relname as table, r.role, p.privilege
         from pg_catalog.pg_class c
         cross join (values ('anon'), ('authenticated'), ('vestiarion_tenant')) r(role)
         cross join (values ('select'), ('insert'), ('update'), ('delete'), ('truncate'), ('references'), ('trigger')) p(privilege)
        where c.oid = any ($1::regclass[]) and has_table_privilege(r.role, c.oid, p.privilege)`,
      [[...PLATFORM_TABLES, ...DEFINER_ONLY_TABLES].map((name) => `public.${name}`)]
    );
    expect(granted.rows).toEqual([]);
  });
});
