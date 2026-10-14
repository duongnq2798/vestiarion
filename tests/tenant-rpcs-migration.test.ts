import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TENANT_RPCS } from "@/lib/dal";
import { applyMigrations, asRole, asTenant, createDatabase, createOrg } from "./support/pglite";

/**
 * Every function the tenant data layer may call takes the workspace. `db().rpc` (src/lib/dal) adds `p_org_id` to every
 * call, and PostgREST matches a function by its argument names: one without `p_org_id` is never found (PGRST202), as
 * 0116's `pipedrive_connector_ready()` was, which made the Pipedrive card say it was not set up (fixed by 0117).
 */

let db: PGlite;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
}, 60_000);

afterAll(async () => {
  await db.close();
});

describe("tenant functions", () => {
  it("each has a version taking p_org_id, the argument the data layer always sends", async () => {
    const rows = (
      await db.query<{ name: string; args: string }>(
        `select p.proname as name, pg_get_function_identity_arguments(p.oid) as args
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = any($1::text[])`,
        [[...TENANT_RPCS]]
      )
    ).rows;
    for (const name of TENANT_RPCS) {
      const versions = rows.filter((row) => row.name === name).map((row) => row.args);
      expect(versions.length, `${name} exists`).toBeGreaterThan(0);
      expect(
        versions.some((args) => /(^|, )p_org_id uuid/.test(args)),
        `${name} takes p_org_id (has: ${versions.join(" | ") || "none"})`
      ).toBe(true);
    }
  });

  it("answers pipedrive_connector_ready with the workspace, to the tenant role only", async () => {
    const orgId = await createOrg(db, "tenant-rpcs-pipedrive-ready");
    const ready = await asTenant(db, orgId, async (tx) =>
      (await tx.query<{ ready: boolean }>("select public.pipedrive_connector_ready(p_org_id => $1::uuid) as ready", [orgId])).rows[0].ready
    );
    expect(ready).toBe(true);
    await expect(asRole(db, "anon", (tx) => tx.query("select public.pipedrive_connector_ready(p_org_id => $1::uuid)", [orgId]))).rejects.toThrow(
      /permission denied/
    );
  });
});
