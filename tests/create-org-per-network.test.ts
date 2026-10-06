import crypto from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, createDatabase, createUser } from "./support/pglite";

/**
 * Migration 0081: at most 3 workspaces per person on each network, where 0020 allowed 3 in all, so a person with three
 * on Arc testnet can still open one on Arc mainnet. create_org takes the network and writes it on insert. 0020's
 * five-argument create_org is left as it was for the code from before 0081, which counts every network.
 */

interface Created {
  id: string;
  network: string;
  mode: string;
}

let db: PGlite;
let dana: string;
let erin: string;

async function create(userId: string, slug: string, network?: string): Promise<Created> {
  const args = [crypto.randomUUID(), userId, slug, slug, JSON.stringify({ k: "x" })];
  const result =
    network === undefined
      ? await db.query<Created>("select * from public.create_org($1, $2, $3, $4, $5::jsonb)", args)
      : await db.query<Created>("select * from public.create_org($1, $2, $3, $4, $5::jsonb, $6)", [...args, network]);
  return result.rows[0];
}

async function createOrgFunctions(): Promise<Array<{ args: string; defaults: number; language: string }>> {
  const result = await db.query<{ args: string; defaults: number; language: string }>(
    `select pg_get_function_identity_arguments(p.oid) as args, p.pronargdefaults::int as defaults, l.lanname as language
       from pg_proc p join pg_language l on l.oid = p.prolang
      where p.proname = 'create_org' and p.pronamespace = 'public'::regnamespace
      order by p.pronargs`
  );
  return result.rows;
}

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
  dana = await createUser(db, "dana@example.com");
  erin = await createUser(db, "erin@example.com");
}, 60_000);

afterAll(async () => {
  await db.close();
});

describe("create_org on a network (0081)", () => {
  it("writes the workspace's network on insert, in sandbox mode", async () => {
    expect(await create(dana, "dana-main-1", "arc-mainnet")).toMatchObject({ network: "arc-mainnet", mode: "sandbox" });
  });

  it("lets a person with three workspaces on Arc testnet open three more on Arc mainnet, and no more on either", async () => {
    for (const n of [1, 2, 3]) await create(erin, `erin-test-${n}`, "arc-testnet");
    for (const n of [1, 2, 3]) expect((await create(erin, `erin-main-${n}`, "arc-mainnet")).network).toBe("arc-mainnet");
    await expect(create(erin, "erin-main-4", "arc-mainnet")).rejects.toThrow("org_limit_reached: at most 3 workspaces per person on arc-mainnet");
    await expect(create(erin, "erin-test-4", "arc-testnet")).rejects.toThrow("org_limit_reached: at most 3 workspaces per person on arc-testnet");
  });

  it("leaves 0020's five-argument create_org to the code from before 0081, counting every network", async () => {
    // That code creates on Arc testnet and moves the row to Arc mainnet after (final review I1). Counted on Arc testnet
    // alone, its count would never grow, and a tab still on the old deployment could open mainnet workspaces without
    // end; counted across networks, it stops at 3 in all, as before 0081.
    const gale = await createUser(db, "gale@example.com");
    for (const n of [1, 2, 3]) {
      const row = await create(gale, `gale-old-${n}`);
      await db.query("update public.orgs set network = 'arc-mainnet' where id = $1", [row.id]);
    }
    await expect(create(gale, "gale-old-4")).rejects.toThrow("org_limit_reached");
  });

  it("keeps exactly two create_org functions, neither with a default, so PostgREST matches a call by its keys alone", async () => {
    expect(await createOrgFunctions()).toEqual([
      { args: "p_org_id uuid, p_user_id uuid, p_name text, p_slug text, p_ledger_key_enc jsonb", defaults: 0, language: "plpgsql" },
      { args: "p_org_id uuid, p_user_id uuid, p_name text, p_slug text, p_ledger_key_enc jsonb, p_network text", defaults: 0, language: "plpgsql" },
    ]);
  });

  it("ends in the same state after db:migrate replays every file", async () => {
    await applyMigrations(db);
    expect(await createOrgFunctions()).toHaveLength(2);
    const hana = await createUser(db, "hana@example.com");
    for (const n of [1, 2, 3]) await create(hana, `hana-test-${n}`, "arc-testnet");
    expect((await create(hana, "hana-main-1", "arc-mainnet")).network).toBe("arc-mainnet");
    await expect(create(hana, "hana-old-1")).rejects.toThrow("org_limit_reached");
  });

  it("refuses a network that is not one", async () => {
    const frank = await createUser(db, "frank@example.com");
    await expect(create(frank, "frank-elsewhere", "eth-mainnet")).rejects.toThrow(/orgs_network_check|violates check constraint/);
  });

  it("is executable only by the service role", async () => {
    const roles = ["anon", "authenticated", "vestiarion_tenant", "service_role"];
    const result = await db.query<{ role: string; ok: boolean }>(
      `select r.role, has_function_privilege(r.role, 'public.create_org(uuid,uuid,text,text,jsonb,text)', 'execute') as ok
         from unnest($1::text[]) as r(role)`,
      [roles]
    );
    expect(Object.fromEntries(result.rows.map((row) => [row.role, row.ok]))).toEqual({
      anon: false,
      authenticated: false,
      vestiarion_tenant: false,
      service_role: true,
    });
  });
});
