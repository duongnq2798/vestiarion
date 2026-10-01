import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asRole, asServiceRole, asTenant, createDatabase, createOrg } from "./support/pglite";

/**
 * Migration 0050 (docs/superpowers/specs/2026-10-01-receivables-on-arc-design.md §4): a pay link per
 * receivable, stored only as a hash; each inbound transfer recorded once; and the public page's read,
 * which shows only what the client needs to pay (R2).
 */

let db: PGlite;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
}, 60_000);

afterAll(async () => {
  await db.close();
});

const one = async (sql: string, params: unknown[]) => (await db.query<{ id: string }>(sql, params)).rows[0].id;

/** A workspace with a client, an operating wallet on Arc testnet, and a receivable from the client. */
async function workspace(slug: string, fields: { address?: string | null; direction?: "receivable" | "payable"; status?: string } = {}) {
  const orgId = await createOrg(db, slug);
  await db.query("update public.orgs set name = $2 where id = $1", [orgId, `${slug} Studio`]);
  const client = await one("insert into public.counterparties (org_id, name, role) values ($1, 'Acme Corp', 'client') returning id", [orgId]);
  await db.query(
    "insert into public.accounts (org_id, name, kind, chain, address) values ($1, 'Operating', 'operating', 'ARC-TESTNET', $2)",
    [orgId, fields.address === undefined ? "0x1111111111111111111111111111111111111111" : fields.address]
  );
  const invoiceId = await one(
    `insert into public.invoices (org_id, direction, counterparty_id, amount, currency, memo, due_date, status)
     values ($1, $2, $3, 12.5, 'USDC', 'October retainer', '2026-10-15T12:00:00Z', $4) returning id`,
    [orgId, fields.direction ?? "receivable", client, fields.status ?? "pending"]
  );
  return { orgId, client, invoiceId };
}

const link = (orgId: string, invoiceId: string, hash: string) =>
  db.query("insert into public.receivable_links (org_id, invoice_id, token_hash) values ($1, $2, $3)", [orgId, invoiceId, hash]);

const transfer = (orgId: string, circleTxId: string) =>
  db.query(
    `insert into public.incoming_transfers (org_id, circle_tx_id, tx_hash, from_address, amount, token, chain, received_at)
     values ($1, $2, '0xabc', '0x2222222222222222222222222222222222222222', 12.5, 'USDC', 'ARC-TESTNET', now())`,
    [orgId, circleTxId]
  );

const preview = (hash: string) =>
  asServiceRole(db, async (tx) => (await tx.query<{ found: Record<string, unknown> | null }>("select public.pay_link_preview($1) as found", [hash])).rows[0].found);

describe("receivable_links (0050)", () => {
  it("holds one link per receivable, stored only as a SHA-256", async () => {
    const { orgId, invoiceId } = await workspace("ar-links");
    await link(orgId, invoiceId, "a".repeat(64));
    await expect(link(orgId, invoiceId, "b".repeat(64))).rejects.toThrow(/receivable_links_invoice_key/);
    const other = await workspace("ar-links-2");
    await expect(link(other.orgId, other.invoiceId, "not-a-hash")).rejects.toThrow(/receivable_links_token_hash_check/);
    await expect(link(other.orgId, other.invoiceId, "a".repeat(64))).rejects.toThrow(/receivable_links_token_hash_key/);
  });

  it("refers only to an invoice of its own workspace, and goes with it", async () => {
    const mine = await workspace("ar-own");
    const theirs = await workspace("ar-theirs");
    await expect(link(mine.orgId, theirs.invoiceId, "c".repeat(64))).rejects.toThrow(/receivable_links_invoice_id_org_fkey/);
    await link(mine.orgId, mine.invoiceId, "d".repeat(64));
    await db.query("delete from public.invoices where id = $1", [mine.invoiceId]);
    expect((await db.query("select 1 from public.receivable_links where invoice_id = $1", [mine.invoiceId])).rows).toHaveLength(0);
  });

  it("is seen and written only by its own workspace's tenant requests", async () => {
    const mine = await workspace("ar-tenant-a");
    const theirs = await workspace("ar-tenant-b");
    await link(mine.orgId, mine.invoiceId, "e".repeat(64));
    await link(theirs.orgId, theirs.invoiceId, "f".repeat(64));
    const seen = await asTenant(db, mine.orgId, async (tx) => (await tx.query<{ token_hash: string }>("select token_hash from public.receivable_links")).rows);
    expect(seen.map((row) => row.token_hash)).toEqual(["e".repeat(64)]);
    await expect(
      asTenant(db, mine.orgId, (tx) =>
        tx.query("insert into public.receivable_links (org_id, invoice_id, token_hash) values ($1, $2, $3)", [theirs.orgId, theirs.invoiceId, "9".repeat(64)])
      )
    ).rejects.toThrow(/row-level security/);
    await expect(asRole(db, "anon", (tx) => tx.query("select 1 from public.receivable_links"))).rejects.toThrow(/permission denied/);
  });
});

describe("incoming_transfers (0050)", () => {
  it("records a Circle transfer once per workspace", async () => {
    const { orgId } = await workspace("ar-in");
    await transfer(orgId, "circle-tx-1");
    await expect(transfer(orgId, "circle-tx-1")).rejects.toThrow(/incoming_transfers_circle_tx_key/);
  });

  it("keeps a transfer when the invoice it settled is deleted, unmatched", async () => {
    const { orgId, invoiceId } = await workspace("ar-in-keep");
    await transfer(orgId, "circle-tx-keep");
    await db.query("update public.incoming_transfers set invoice_id = $2, matched_by = 'amount' where org_id = $1", [orgId, invoiceId]);
    await db.query("delete from public.invoices where id = $1", [invoiceId]);
    const row = (await db.query<{ invoice_id: string | null }>("select invoice_id from public.incoming_transfers where org_id = $1", [orgId])).rows[0];
    expect(row.invoice_id).toBeNull();
  });

  it("is seen only by its own workspace's tenant requests", async () => {
    const mine = await workspace("ar-in-a");
    const theirs = await workspace("ar-in-b");
    await transfer(mine.orgId, "tx-a");
    await transfer(theirs.orgId, "tx-b");
    const seen = await asTenant(db, mine.orgId, async (tx) => (await tx.query<{ circle_tx_id: string }>("select circle_tx_id from public.incoming_transfers")).rows);
    expect(seen.map((row) => row.circle_tx_id)).toEqual(["tx-a"]);
  });
});

describe("pay_link_preview (0050)", () => {
  it("shows what the client needs to pay an open receivable, and where", async () => {
    const { orgId, invoiceId } = await workspace("ar-preview");
    await link(orgId, invoiceId, "1".repeat(64));
    expect(await preview("1".repeat(64))).toEqual({
      orgId,
      invoiceId,
      orgName: "ar-preview Studio",
      clientName: "Acme Corp",
      amount: 12.5,
      currency: "USDC",
      dueDate: "2026-10-15",
      memo: "October retainer",
      status: "open",
      payTo: "0x1111111111111111111111111111111111111111",
      chain: "ARC-TESTNET",
    });
  });

  it("says a receivable was received, so the page can thank the client", async () => {
    const { orgId, invoiceId } = await workspace("ar-preview-paid", { status: "received" });
    await link(orgId, invoiceId, "2".repeat(64));
    expect(await preview("2".repeat(64))).toMatchObject({ status: "received" });
  });

  it("has no address to show while the workspace has no operating wallet address", async () => {
    const { orgId, invoiceId } = await workspace("ar-preview-noaddr", { address: null });
    await link(orgId, invoiceId, "3".repeat(64));
    expect(await preview("3".repeat(64))).toMatchObject({ payTo: null });
  });

  it("finds nothing for a revoked link, an unknown one, a payable or a rejected receivable", async () => {
    const revoked = await workspace("ar-preview-revoked");
    await link(revoked.orgId, revoked.invoiceId, "4".repeat(64));
    await db.query("update public.receivable_links set revoked_at = now() where token_hash = $1", ["4".repeat(64)]);
    expect(await preview("4".repeat(64))).toBeNull();
    expect(await preview("5".repeat(64))).toBeNull();
    const payable = await workspace("ar-preview-payable", { direction: "payable" });
    await link(payable.orgId, payable.invoiceId, "6".repeat(64));
    expect(await preview("6".repeat(64))).toBeNull();
    const rejected = await workspace("ar-preview-rejected", { status: "rejected" });
    await link(rejected.orgId, rejected.invoiceId, "7".repeat(64));
    expect(await preview("7".repeat(64))).toBeNull();
  });

  it("runs for the service role only", async () => {
    for (const role of ["anon", "authenticated"] as const) {
      await expect(asRole(db, role, (tx) => tx.query("select public.pay_link_preview($1)", ["1".repeat(64)]))).rejects.toThrow(/permission denied/);
    }
  });
});
