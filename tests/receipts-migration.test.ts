import crypto from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, appendSignedForOrg, asRole, asServiceRole, asTenant, createDatabase, createOrg, seedOrgRows } from "./support/pglite";

/**
 * Migration 0046 (docs/superpowers/specs/2026-10-01-payment-receipts-design.md §4): one shared receipt
 * per paid invoice, its link stored only as a hash, seen and written only by its own workspace.
 */

let db: PGlite;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
}, 60_000);

afterAll(async () => {
  await db.close();
});

const HASH = "a".repeat(64);

/** A workspace's seeded invoice, without the receipt seedOrgRows gives it. */
async function seededInvoice(orgId: string, tag: string): Promise<string> {
  const { invoiceId } = await seedOrgRows(db, orgId, tag);
  await db.query("delete from public.payment_receipts where org_id = $1", [orgId]);
  return invoiceId;
}
const insert = (orgId: string, invoiceId: string, tokenHash = HASH) =>
  db.query(
    "insert into public.payment_receipts (org_id, invoice_id, entry_seq, public_keys, token_hash) values ($1, $2, 1, '{}'::jsonb, $3)",
    [orgId, invoiceId, tokenHash]
  );

describe("payment_receipts (0046)", () => {
  it("holds one receipt per invoice, with a link stored only as a SHA-256", async () => {
    const orgId = await createOrg(db, "receipts-co");
    const invoiceId = await seededInvoice(orgId, "receipts-co");
    await insert(orgId, invoiceId, "b".repeat(64));
    await expect(insert(orgId, invoiceId, "c".repeat(64))).rejects.toThrow(/payment_receipts_invoice_key/);
    const other = await createOrg(db, "receipts-bad");
    const otherInvoice = await seededInvoice(other, "receipts-bad");
    await expect(insert(other, otherInvoice, "not-a-hash")).rejects.toThrow(/payment_receipts_token_hash_check/);
    await expect(insert(other, otherInvoice, "b".repeat(64))).rejects.toThrow(/payment_receipts_token_hash_key/);
  });

  it("refers only to an invoice of its own workspace", async () => {
    const mine = await createOrg(db, "receipts-own");
    const theirs = await createOrg(db, "receipts-other");
    const theirInvoice = await seededInvoice(theirs, "receipts-other");
    await expect(insert(mine, theirInvoice, "d".repeat(64))).rejects.toThrow(/payment_receipts_invoice_id_org_fkey/);
  });

  it("is seen and written only by its own workspace's tenant requests", async () => {
    const mine = await createOrg(db, "receipts-mine");
    const theirs = await createOrg(db, "receipts-theirs");
    const myInvoice = await seededInvoice(mine, "receipts-mine");
    const theirInvoice = await seededInvoice(theirs, "receipts-theirs");
    await insert(mine, myInvoice, "e".repeat(64));
    await insert(theirs, theirInvoice, "f".repeat(64));
    const seen = await asTenant(db, mine, async (tx) => (await tx.query<{ token_hash: string }>("select token_hash from public.payment_receipts")).rows);
    expect(seen.map((row) => row.token_hash)).toEqual(["e".repeat(64)]);
    await expect(
      asTenant(db, mine, (tx) =>
        tx.query("insert into public.payment_receipts (org_id, invoice_id, entry_seq, public_keys, token_hash) values ($1, $2, 1, '{}'::jsonb, $3)", [
          theirs,
          theirInvoice,
          "9".repeat(64),
        ])
      )
    ).rejects.toThrow(/row-level security/);
  });

  it("goes with its invoice", async () => {
    const orgId = await createOrg(db, "receipts-cascade");
    const invoiceId = await seededInvoice(orgId, "receipts-cascade");
    await insert(orgId, invoiceId, "1".repeat(64));
    await db.query("delete from public.payment_intents where source_id = $1", [invoiceId]);
    await db.query("delete from public.invoices where id = $1", [invoiceId]);
    expect((await db.query("select 1 from public.payment_receipts where invoice_id = $1", [invoiceId])).rows).toHaveLength(0);
  });
});

describe("payment_receipt_by_token (0046)", () => {
  const key = crypto.generateKeyPairSync("ed25519").privateKey;
  const read = (tokenHash: string) =>
    asServiceRole(db, async (tx) => (await tx.query<{ found: Record<string, unknown> | null }>("select public.payment_receipt_by_token($1) as found", [tokenHash])).rows[0].found);

  async function shared(slug: string, recordsSeq?: (decisionSeq: number) => number) {
    const orgId = await createOrg(db, slug);
    const invoiceId = await seededInvoice(orgId, slug);
    const decision = await appendSignedForOrg(db, orgId, { actor: "agent", domain: "ap", action: "ap_pay", summary: "PAY invoice from Northwind for 2 USDC", detail: { invoiceId } }, key);
    const seq = recordsSeq ? recordsSeq(Number(decision.seq)) : Number(decision.seq);
    const receipt = await appendSignedForOrg(
      db, orgId,
      { actor: "human", domain: "ap", action: "receipt_shared", summary: "Receipt: 2 USDC paid on Arbitrum Sepolia", detail: { receipt: { amount: 2 }, records: { seq, hash: decision.hash } } },
      key
    );
    const tokenHash = crypto.createHash("sha256").update(slug).digest("hex");
    await db.query(
      "insert into public.payment_receipts (org_id, invoice_id, entry_seq, public_keys, token_hash) values ($1, $2, $3, $4::jsonb, $5)",
      [orgId, invoiceId, receipt.seq, JSON.stringify({ k1: "pem" }), tokenHash]
    );
    return { orgId, tokenHash, decision, receipt };
  }

  it("answers a live link with the receipt entry, the entry it names, and the keys; nothing about who", async () => {
    const { tokenHash, decision, receipt } = await shared("receipt-read");
    const found = await read(tokenHash);
    expect(found).toMatchObject({
      publicKeys: { k1: "pem" },
      entry: { seq: Number(receipt.seq), action: "receipt_shared", body_hash: receipt.body_hash, signature: receipt.signature, prev_hash: receipt.prev_hash, hash: receipt.hash },
      records: { seq: Number(decision.seq), hash: decision.hash },
    });
    expect(Object.keys(found!.entry as object).sort()).toEqual(["action", "actor", "body_hash", "detail", "domain", "hash", "prev_hash", "seq", "signature", "signing_key_id", "summary", "ts"]);
    expect(found).not.toHaveProperty("orgId");
  });

  it("answers nothing for a revoked or unknown link", async () => {
    const { orgId, tokenHash } = await shared("receipt-revoked");
    await db.query("update public.payment_receipts set revoked_at = now() where org_id = $1", [orgId]);
    expect(await read(tokenHash)).toBeNull();
    expect(await read("0".repeat(64))).toBeNull();
  });

  it("never answers with another workspace's entry for the seq a receipt names", async () => {
    const foreign = await shared("receipt-foreign-source");
    const { tokenHash } = await shared("receipt-foreign", () => Number(foreign.decision.seq));
    expect((await read(tokenHash))?.records).toBeNull();
  });

  it("is the service role's alone", async () => {
    await expect(asRole(db, "anon", (tx) => tx.query("select public.payment_receipt_by_token($1)", ["0".repeat(64)]))).rejects.toThrow(/permission denied/);
    await expect(asRole(db, "authenticated", (tx) => tx.query("select public.payment_receipt_by_token($1)", ["0".repeat(64)]))).rejects.toThrow(/permission denied/);
  });
});

describe("re-running 0046", () => {
  it("applies again without error", async () => {
    await applyMigrations(db, (file) => file.startsWith("0046"));
  });
});
