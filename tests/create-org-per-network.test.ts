import crypto from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, createDatabase, createUser } from "./support/pglite";

/**
 * Migration 0081: at most 3 workspaces per person on each network, where 0020 allowed 3 in all, so a person with three
 * on Arc testnet can still open one on Arc mainnet. create_org takes the network and writes it on insert. The
 * five-argument create_org, kept for a deployment still running the code from before 0081, creates on Arc testnet
 * under the same count.
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

  it("keeps the five-argument create_org for code from before 0081: Arc testnet, under the same count", async () => {
    // Dana's one workspace is on Arc mainnet, so none of her three on Arc testnet is counted against it.
    for (const n of [1, 2, 3]) expect((await create(dana, `dana-test-${n}`)).network).toBe("arc-testnet");
    await expect(create(dana, "dana-test-4")).rejects.toThrow("org_limit_reached");
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
