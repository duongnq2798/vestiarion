import crypto from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bodyHashOf } from "@/lib/ledger";
import { ledgerKeyId } from "@/lib/ledger-keys";
import {
  FOUNDING_ORG_ID as A, TENANT_TABLES, applyMigrations, asRole, asTenant, createDatabase, createOrg, seedOrgRows,
  type SeededRows,
} from "./support/pglite";

/**
 * Row-level security as PostgREST applies it: the role `vestiarion_tenant`,
 * with the request's claims in `request.jwt.claims`. Organization A is the
 * founding organization; B is a second one. Every table holds one row of each.
 */

let db: PGlite;
let B: string;
let rowsB: SeededRows;

const count = async (tx: { query: PGlite["query"] }, table: string) =>
  (await tx.query<{ n: number }>(`select count(*)::int as n from public.${table}`)).rows[0].n;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
  B = await createOrg(db, "northstar");
  await seedOrgRows(db, A, "a");
  rowsB = await seedOrgRows(db, B, "b");
}, 60_000);

afterAll(async () => {
  await db.close();
});

describe("request_org_id()", () => {
  it("is the claim's org_id, and null without one", async () => {
    expect(await asTenant(db, A, async (tx) => (await tx.query<{ v: string }>("select public.request_org_id() as v")).rows[0].v)).toBe(A);
    expect(await asTenant(db, null, async (tx) => (await tx.query<{ v: string | null }>("select public.request_org_id() as v")).rows[0].v)).toBeNull();
  });
});

describe.each(TENANT_TABLES)("%s", (table) => {
  it("shows a tenant its own rows and none of another organization's", async () => {
    expect(await asTenant(db, A, (tx) => count(tx, table))).toBeGreaterThan(0);
    const seen = await asTenant(db, A, async (tx) =>
      (await tx.query<{ org_id: string }>(`select distinct org_id from public.${table}`)).rows.map((row) => row.org_id));
    expect(seen).toEqual([A]);
  });

  it("shows a request whose token names no organization nothing", async () => {
    expect(await asTenant(db, null, (tx) => count(tx, table))).toBe(0);
  });

  it("gives the browser roles no access at all", async () => {
    for (const role of ["anon", "authenticated"] as const) {
      await expect(asRole(db, role, (tx) => count(tx, table))).rejects.toThrow(/permission denied/);
    }
  });

  it("cannot change or remove another organization's rows", async () => {
    const before = (await db.query<{ n: number }>(`select count(*)::int as n from public.${table} where org_id = $1`, [B])).rows[0].n;
    await asTenant(db, A, async (tx) => {
      await tx.query(`update public.${table} set org_id = org_id where org_id = $1`, [B]).catch(() => undefined);
      await tx.query(`delete from public.${table} where org_id = $1`, [B]).catch(() => undefined);
    });
    const after = (await db.query<{ n: number }>(`select count(*)::int as n from public.${table} where org_id = $1`, [B])).rows[0].n;
    expect(after).toBe(before);
  });
});

describe("history is append-only for the tenant role", () => {
  it.each(["ledger_entries", "cycle_snapshots"])("%s refuses UPDATE and DELETE even on the tenant's own rows", async (table) => {
    await expect(asTenant(db, A, (tx) => tx.query(`update public.${table} set org_id = org_id`))).rejects.toThrow(/permission denied/);
    await expect(asTenant(db, A, (tx) => tx.query(`delete from public.${table}`))).rejects.toThrow(/permission denied/);
  });
});

describe("writes name the tenant's own organization", () => {
  it("refuses a row for another organization", async () => {
    await expect(asTenant(db, A, (tx) =>
      tx.query("insert into counterparties (org_id, name, role) values ($1, 'x', 'vendor')", [B]))).rejects.toThrow(/row-level security/);
  });

  it("refuses moving a row to another organization", async () => {
    await expect(asTenant(db, A, (tx) =>
      tx.query("update counterparties set org_id = $1 where org_id = $2", [B, A]))).rejects.toThrow(/row-level security/);
  });

  it("accepts a row for its own organization", async () => {
    await asTenant(db, A, (tx) => tx.query("insert into forecasts (org_id, as_of, horizon_days, projected_inflow, projected_outflow, liquid_balance) values ($1, now(), 7, 0, 0, 0)", [A]));
  });
});

describe("the tenant RPCs under the tenant role", () => {
  function signed(summary: string) {
    const key = crypto.generateKeyPairSync("ed25519");
    const input = { actor: "system" as const, domain: "system" as const, action: "note", summary, detail: { summary } };
    const bodyHash = bodyHashOf(input);
    const signature = crypto.sign(null, Buffer.from(bodyHash, "hex"), key.privateKey).toString("hex");
    return [input.actor, input.domain, input.action, input.summary, JSON.stringify(input.detail), bodyHash, signature, ledgerKeyId(key.privateKey)];
  }
  const append = "select * from append_ledger_entry($1::uuid, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)";

  it("appends to the tenant's own chain", async () => {
    const row = await asTenant(db, A, async (tx) => (await tx.query<{ org_id: string }>(append, [A, ...signed("own")])).rows[0]);
    expect(row.org_id).toBe(A);
  });

  it("refuses appending to another organization's chain", async () => {
    await expect(asTenant(db, A, (tx) => tx.query(append, [B, ...signed("theirs")]))).rejects.toThrow();
  });

  it("refuses advancing another organization's clock", async () => {
    await expect(asTenant(db, A, (tx) => tx.query("select advance_sim_day($1::uuid)", [B]))).rejects.toThrow();
  });

  it("cannot claim another organization's payment", async () => {
    const claimed = await asTenant(db, A, async (tx) =>
      (await tx.query<{ id: string | null }>("select * from claim_payment_intent($1::uuid, $2)", [B, rowsB.idempotencyKey])).rows[0]);
    expect(claimed?.id ?? null).toBeNull();
  });

  it("reads no ledger entry of another organization by target", async () => {
    const rows = await asTenant(db, A, async (tx) =>
      (await tx.query("select * from ledger_entries_for_targets($1::uuid, array[$2::text])", [B, rowsB.invoiceId])).rows);
    expect(rows).toEqual([]);
  });

  it("stays closed to the browser roles", async () => {
    for (const role of ["anon", "authenticated"] as const) {
      await expect(asRole(db, role, (tx) => tx.query("select advance_sim_day($1::uuid)", [A]))).rejects.toThrow(/permission denied/);
    }
  });
});

describe("platform tables", () => {
  it.each(["orgs", "memberships", "invitations"])("%s is closed to the tenant role", async (table) => {
    await expect(asTenant(db, A, (tx) => count(tx, table))).rejects.toThrow(/permission denied/);
  });
});

describe("0018 is idempotent", () => {
  it("replays twice without error", async () => {
    await applyMigrations(db);
    await applyMigrations(db);
  });
});
