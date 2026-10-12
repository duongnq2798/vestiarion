import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asRole, asTenant, createDatabase, createOrg, createUser } from "./support/pglite";

/**
 * Migration 0103 (docs/superpowers/specs/2026-10-12-allocations-design.md L1, L5): money received on Arc applied to
 * receivables, as rows the tenant role only reads and adds. The database holds the invariants itself: never more from a
 * payment than it brought, never more on a receivable than it owes, never across currencies or customers, a fee only
 * beside a payment, a reversal that mirrors one row once, two people on the same payment never both succeeding, and
 * never an application beside a whole match. The receivable is settled and reopened in the same transaction.
 */

let db: PGlite;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
  // Re-runnable, as scripts/migrate.ts re-runs every file.
  await applyMigrations(db, (file) => file.startsWith("0103_"));
}, 60_000);

afterAll(async () => {
  await db.close();
});

const one = async (sql: string, params: unknown[]) => (await db.query<{ id: string }>(sql, params)).rows[0].id;

const ACME_ADDRESS = "0x2222222222222222222222222222222222222222";

/** A workspace with two clients. */
async function workspace(slug: string) {
  const orgId = await createOrg(db, slug);
  const acme = await one("insert into public.counterparties (org_id, name, role, address) values ($1, 'Acme Corp', 'client', $2) returning id", [orgId, ACME_ADDRESS]);
  const beacon = await one("insert into public.counterparties (org_id, name, role) values ($1, 'Beacon Labs', 'client') returning id", [orgId]);
  return { orgId, acme, beacon };
}

async function receivable(orgId: string, client: string, amount: number, fields: { currency?: string; status?: string; direction?: string } = {}) {
  return one(
    `insert into public.invoices (org_id, direction, counterparty_id, amount, currency, memo, due_date, status)
     values ($1, $2, $3, $4, $5, 'Invoice INV-1', '2026-10-15T12:00:00Z', $6) returning id`,
    [orgId, fields.direction ?? "receivable", client, amount, fields.currency ?? "USDC", fields.status ?? "pending"]
  );
}

let transfers = 0;
async function transfer(orgId: string, amount: number, fields: { token?: string; receivedAt?: string; hash?: string } = {}) {
  transfers += 1;
  return one(
    `insert into public.incoming_transfers (org_id, circle_tx_id, tx_hash, from_address, amount, token, chain, received_at)
     values ($1, $2, $3, $4, $5, $6, 'ARC-TESTNET', $7) returning id`,
    [orgId, `circle-${transfers}`, fields.hash ?? `0x${String(transfers).padStart(64, "0")}`, ACME_ADDRESS, amount, fields.token ?? "USDC", fields.receivedAt ?? "2026-10-12T09:00:00Z"]
  );
}

interface Row {
  kind?: "payment" | "fee" | "reversal";
  invoice: string;
  transfer?: string | null;
  amount: number;
  currency?: string;
  reverses?: string | null;
  reason?: string | null;
  basis?: string | null;
  seq?: number | null;
}

const COLUMNS = "org_id, kind, invoice_id, transfer_id, amount, currency, reverses, reason, basis, payment_seq";

function values(orgId: string, rows: Row[]): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const tuples = rows.map((row) => {
    const kind = row.kind ?? "payment";
    const fields = [
      orgId,
      kind,
      row.invoice,
      row.transfer ?? null,
      row.amount,
      row.currency ?? "USDC",
      row.reverses ?? null,
      row.reason ?? null,
      row.basis === undefined ? (kind === "payment" ? "person" : null) : row.basis,
      row.seq ?? null,
    ];
    const start = params.length;
    params.push(...fields);
    return `(${fields.map((_, index) => `$${start + index + 1}`).join(", ")})`;
  });
  return { sql: `insert into public.receivable_allocations (${COLUMNS}) values ${tuples.join(", ")} returning id`, params };
}

/** Rows written in one insert, as one press of Apply writes them; their ids in order. */
async function allocate(orgId: string, ...rows: Row[]): Promise<string[]> {
  const { sql, params } = values(orgId, rows);
  return (await db.query<{ id: string }>(sql, params)).rows.map((row) => row.id);
}

const invoiceOf = async (id: string) =>
  (
    await db.query<{ status: string; settled_at: Date | null; tx_ref: string | null }>("select status, settled_at, tx_ref from public.invoices where id = $1", [id])
  ).rows[0];

describe("receivable_allocations (0103): applying a payment", () => {
  it("keeps a part payment, and the receivable stays open with the rest owed", async () => {
    const { orgId, acme } = await workspace("alloc-part");
    const invoice = await receivable(orgId, acme, 900);
    const paid = await transfer(orgId, 300);
    await allocate(orgId, { invoice, transfer: paid, amount: 300 });
    expect((await invoiceOf(invoice)).status).toBe("pending");
    const seq = (await db.query<{ payment_seq: number }>("select payment_seq from public.receivable_allocations where transfer_id = $1", [paid])).rows;
    expect(seq).toEqual([{ payment_seq: 1 }]);
  });

  it("applies one payment to three receivables in one insert, and settles each with the payment's transaction", async () => {
    const { orgId, acme } = await workspace("alloc-lump");
    const [a, b, c] = [await receivable(orgId, acme, 300), await receivable(orgId, acme, 200), await receivable(orgId, acme, 400)];
    const paid = await transfer(orgId, 900, { hash: `0x${"ab".repeat(32)}`, receivedAt: "2026-10-12T10:00:00Z" });
    await allocate(orgId, { invoice: a, transfer: paid, amount: 300 }, { invoice: b, transfer: paid, amount: 200 }, { invoice: c, transfer: paid, amount: 400 });
    for (const id of [a, b, c]) {
      const settled = await invoiceOf(id);
      expect(settled.status).toBe("received");
      expect(settled.tx_ref).toBe(`0x${"ab".repeat(32)}`);
      expect(settled.settled_at?.toISOString()).toBe("2026-10-12T10:00:00.000Z");
    }
    const seqs = (await db.query<{ payment_seq: number }>("select payment_seq from public.receivable_allocations where transfer_id = $1 order by payment_seq", [paid])).rows;
    expect(seqs.map((row) => row.payment_seq)).toEqual([1, 2, 3]);
  });

  it("settles a receivable from several payments, with the latest one's transaction", async () => {
    const { orgId, acme } = await workspace("alloc-several");
    const invoice = await receivable(orgId, acme, 500);
    const first = await transfer(orgId, 200, { receivedAt: "2026-10-10T09:00:00Z" });
    const second = await transfer(orgId, 300, { receivedAt: "2026-10-11T09:00:00Z", hash: `0x${"cd".repeat(32)}` });
    await allocate(orgId, { invoice, transfer: first, amount: 200 });
    expect((await invoiceOf(invoice)).status).toBe("pending");
    await allocate(orgId, { invoice, transfer: second, amount: 300 });
    expect(await invoiceOf(invoice)).toMatchObject({ status: "received", tx_ref: `0x${"cd".repeat(32)}` });
  });

  it("never applies more than the payment brought", async () => {
    const { orgId, acme } = await workspace("alloc-over-payment");
    const [a, b] = [await receivable(orgId, acme, 100), await receivable(orgId, acme, 100)];
    const paid = await transfer(orgId, 100);
    await allocate(orgId, { invoice: a, transfer: paid, amount: 60 });
    await expect(allocate(orgId, { invoice: b, transfer: paid, amount: 50 })).rejects.toThrow(/allocation_exceeds_payment/);
    await allocate(orgId, { invoice: b, transfer: paid, amount: 40 });
  });

  it("never applies more than a receivable owes: the rest stays on the payment", async () => {
    const { orgId, acme } = await workspace("alloc-over-receivable");
    const invoice = await receivable(orgId, acme, 100);
    const paid = await transfer(orgId, 150);
    await expect(allocate(orgId, { invoice, transfer: paid, amount: 150 })).rejects.toThrow(/allocation_exceeds_receivable/);
    await allocate(orgId, { invoice, transfer: paid, amount: 100 });
    expect((await invoiceOf(invoice)).status).toBe("received");
    const applied = (await db.query<{ sum: string }>("select sum(amount)::text as sum from public.receivable_allocations where transfer_id = $1", [paid])).rows[0].sum;
    expect(Number(applied)).toBe(100);
  });

  it("never adds across currencies", async () => {
    const { orgId, acme } = await workspace("alloc-currency");
    const eurc = await receivable(orgId, acme, 100, { currency: "EURC" });
    const usdc = await transfer(orgId, 100);
    await expect(allocate(orgId, { invoice: eurc, transfer: usdc, amount: 100, currency: "USDC" })).rejects.toThrow(/allocation_currency/);
    await expect(allocate(orgId, { invoice: eurc, transfer: usdc, amount: 100, currency: "EURC" })).rejects.toThrow(/allocation_currency/);
    await expect(allocate(orgId, { invoice: eurc, transfer: usdc, amount: 100, currency: "EUR" })).rejects.toThrow(/allocation_currency|receivable_allocations_currency_check/);
  });

  it("applies one payment to one customer's receivables", async () => {
    const { orgId, acme, beacon } = await workspace("alloc-customer");
    const [mine, theirs] = [await receivable(orgId, acme, 100), await receivable(orgId, beacon, 100)];
    const paid = await transfer(orgId, 200);
    await allocate(orgId, { invoice: mine, transfer: paid, amount: 100 });
    await expect(allocate(orgId, { invoice: theirs, transfer: paid, amount: 100 })).rejects.toThrow(/allocation_other_customer/);
  });

  it("applies only to an open receivable", async () => {
    const { orgId, acme } = await workspace("alloc-open");
    const payable = await receivable(orgId, acme, 100, { direction: "payable" });
    const received = await receivable(orgId, acme, 100, { status: "received" });
    const rejected = await receivable(orgId, acme, 100, { status: "rejected" });
    const paid = await transfer(orgId, 100);
    await expect(allocate(orgId, { invoice: payable, transfer: paid, amount: 100 })).rejects.toThrow(/allocation_not_a_receivable/);
    await expect(allocate(orgId, { invoice: received, transfer: paid, amount: 100 })).rejects.toThrow(/allocation_receivable_closed/);
    await expect(allocate(orgId, { invoice: rejected, transfer: paid, amount: 100 })).rejects.toThrow(/allocation_receivable_closed/);
  });

  it("never applies beside a whole match, on either side", async () => {
    const { orgId, acme } = await workspace("alloc-whole");
    const [claimed, other] = [await receivable(orgId, acme, 100), await receivable(orgId, acme, 100)];
    const whole = await transfer(orgId, 100);
    await db.query("update public.incoming_transfers set invoice_id = $2, matched_by = 'sender' where id = $1", [whole, claimed]);
    await expect(allocate(orgId, { invoice: other, transfer: whole, amount: 50 })).rejects.toThrow(/allocation_payment_matched/);
    const fresh = await transfer(orgId, 100);
    await expect(allocate(orgId, { invoice: claimed, transfer: fresh, amount: 50 })).rejects.toThrow(/allocation_receivable_matched/);
  });

  it("keeps the shape of each kind", async () => {
    const { orgId, acme } = await workspace("alloc-shape");
    const invoice = await receivable(orgId, acme, 100);
    const paid = await transfer(orgId, 100);
    await expect(allocate(orgId, { invoice, transfer: null, amount: 10 })).rejects.toThrow(/receivable_allocations_shape/);
    await expect(allocate(orgId, { invoice, transfer: paid, amount: 10, basis: null })).rejects.toThrow(/receivable_allocations_shape/);
    await expect(allocate(orgId, { invoice, transfer: paid, amount: 0 })).rejects.toThrow(/receivable_allocations_amount_check/);
    await expect(allocate(orgId, { invoice, transfer: paid, amount: 10, basis: "guess" })).rejects.toThrow(/receivable_allocations_basis_check/);
  });

  it("refers only to a receivable and a payment of its own workspace", async () => {
    const mine = await workspace("alloc-own");
    const theirs = await workspace("alloc-theirs");
    const invoice = await receivable(mine.orgId, mine.acme, 100);
    const elsewhere = await transfer(theirs.orgId, 100);
    await expect(allocate(mine.orgId, { invoice, transfer: elsewhere, amount: 100 })).rejects.toThrow(/allocation_no_payment|receivable_allocations_transfer_fkey/);
    const theirInvoice = await receivable(theirs.orgId, theirs.acme, 100);
    const paid = await transfer(mine.orgId, 100);
    await expect(allocate(mine.orgId, { invoice: theirInvoice, transfer: paid, amount: 100 })).rejects.toThrow(/allocation_not_a_receivable|receivable_allocations_invoice_fkey/);
  });
});

describe("receivable_allocations (0103): fees", () => {
  it("records a difference as a fee, with a reason, beside a payment, and settles the receivable", async () => {
    const { orgId, acme } = await workspace("alloc-fee");
    const invoice = await receivable(orgId, acme, 100);
    const paid = await transfer(orgId, 99.7);
    await expect(allocate(orgId, { kind: "fee", invoice, amount: 0.3, reason: "Transfer fee" })).rejects.toThrow(/allocation_fee_without_payment/);
    await expect(allocate(orgId, { invoice, transfer: paid, amount: 99.7 }, { kind: "fee", invoice, amount: 0.3 })).rejects.toThrow(/receivable_allocations_shape/);
    await allocate(orgId, { invoice, transfer: paid, amount: 99.7 }, { kind: "fee", invoice, amount: 0.3, reason: "Transfer fee" });
    expect((await invoiceOf(invoice)).status).toBe("received");
  });

  it("never records more as a fee than is owed", async () => {
    const { orgId, acme } = await workspace("alloc-fee-over");
    const invoice = await receivable(orgId, acme, 100);
    const paid = await transfer(orgId, 99);
    await allocate(orgId, { invoice, transfer: paid, amount: 99 });
    await expect(allocate(orgId, { kind: "fee", invoice, amount: 2, reason: "Fee" })).rejects.toThrow(/allocation_exceeds_receivable/);
  });
});

describe("receivable_allocations (0103): reversals", () => {
  it("mirrors one row once, frees the payment and reopens the receivable", async () => {
    const { orgId, acme } = await workspace("alloc-reverse");
    const [first, second] = [await receivable(orgId, acme, 100), await receivable(orgId, acme, 100)];
    const paid = await transfer(orgId, 100);
    const [applied] = await allocate(orgId, { invoice: first, transfer: paid, amount: 100 });
    expect((await invoiceOf(first)).status).toBe("received");

    await expect(allocate(orgId, { kind: "reversal", invoice: first, transfer: paid, amount: 50, reverses: applied, reason: "Wrong invoice" })).rejects.toThrow(
      /allocation_reversal_mismatch/
    );
    await expect(allocate(orgId, { kind: "reversal", invoice: first, transfer: paid, amount: 100, reverses: applied })).rejects.toThrow(/receivable_allocations_shape/);
    const [reversal] = await allocate(orgId, { kind: "reversal", invoice: first, transfer: paid, amount: 100, reverses: applied, reason: "Wrong invoice", basis: null });
    expect(await invoiceOf(first)).toMatchObject({ status: "pending", settled_at: null, tx_ref: null });

    await expect(allocate(orgId, { kind: "reversal", invoice: first, transfer: paid, amount: 100, reverses: applied, reason: "Again", basis: null })).rejects.toThrow(
      /receivable_allocations_one_reversal/
    );
    await expect(allocate(orgId, { kind: "reversal", invoice: first, transfer: paid, amount: 100, reverses: reversal, reason: "Undo", basis: null })).rejects.toThrow(
      /allocation_not_reversible/
    );
    // The payment is free again: the right receivable takes it.
    await allocate(orgId, { invoice: second, transfer: paid, amount: 100 });
    expect((await invoiceOf(second)).status).toBe("received");
  });

  it("never leaves a fee without the payment beside it, and takes the fee first in one insert", async () => {
    const { orgId, acme } = await workspace("alloc-reverse-fee");
    const invoice = await receivable(orgId, acme, 100);
    const paid = await transfer(orgId, 99.7);
    const [payment, fee] = await allocate(orgId, { invoice, transfer: paid, amount: 99.7 }, { kind: "fee", invoice, amount: 0.3, reason: "Transfer fee" });
    await expect(allocate(orgId, { kind: "reversal", invoice, transfer: paid, amount: 99.7, reverses: payment, reason: "Not theirs", basis: null })).rejects.toThrow(
      /allocation_fee_left/
    );
    await allocate(
      orgId,
      { kind: "reversal", invoice, amount: 0.3, reverses: fee, reason: "Not theirs", basis: null },
      { kind: "reversal", invoice, transfer: paid, amount: 99.7, reverses: payment, reason: "Not theirs", basis: null }
    );
    expect((await invoiceOf(invoice)).status).toBe("pending");
  });
});

describe("receivable_allocations (0103): two people at once", () => {
  it("lets one of two people who saw the same payment apply it; the other is refused as stale", async () => {
    const { orgId, acme } = await workspace("alloc-race");
    const [a, b] = [await receivable(orgId, acme, 30), await receivable(orgId, acme, 30)];
    const paid = await transfer(orgId, 100);
    // Both read the payment with no application yet (version 0), so both name number 1.
    await allocate(orgId, { invoice: a, transfer: paid, amount: 30, seq: 1 });
    await expect(allocate(orgId, { invoice: b, transfer: paid, amount: 30, seq: 1 })).rejects.toThrow(/allocation_stale/);
    // Having looked again, the second person names number 2.
    await allocate(orgId, { invoice: b, transfer: paid, amount: 30, seq: 2 });
  });

  it("refuses a second row with the same number even past the trigger: the unique index holds it", async () => {
    const { orgId, acme } = await workspace("alloc-race-index");
    const [a, b] = [await receivable(orgId, acme, 30), await receivable(orgId, acme, 30)];
    const paid = await transfer(orgId, 100);
    await allocate(orgId, { invoice: a, transfer: paid, amount: 30, seq: 1 });
    await db.exec("set session_replication_role = replica");
    try {
      await expect(allocate(orgId, { invoice: b, transfer: paid, amount: 30, seq: 1 })).rejects.toThrow(/receivable_allocations_payment_seq/);
    } finally {
      await db.exec("set session_replication_role = origin");
    }
  });

  // Every write takes the payment before the receivable. A reversal of a payment with its fee starts with the fee's row,
  // which names no payment: it takes the receivable's payments first, or it would hold the receivable while waiting on the
  // payment, and a person applying that payment to the same receivable would wait on it the other way round (deadlock).
  it("locks the payments applied to a receivable before the receivable when a fee is reversed", async () => {
    const { orgId, acme } = await workspace("alloc-lock-order");
    const invoice = await receivable(orgId, acme, 100);
    const paid = await transfer(orgId, 200);
    const [, fee] = await allocate(orgId, { invoice, transfer: paid, amount: 90 }, { kind: "fee", invoice, amount: 1, reason: "Transfer fee" });
    // A row this transaction locked carries its id as xmax.
    const lockedBy = await db.transaction(async (tx) => {
      const { sql, params } = values(orgId, [{ kind: "reversal", invoice, amount: 1, reverses: fee, reason: "Not a fee", basis: null }]);
      await tx.query(sql, params);
      const [row] = (await tx.query<{ locked: boolean }>("select xmax::text = (txid_current() % 4294967296)::text as locked from public.incoming_transfers where id = $1", [paid])).rows;
      await tx.rollback();
      return row.locked;
    });
    expect(lockedBy).toBe(true);
  });
});

describe("incoming_transfers (0103): a whole match", () => {
  it("is refused on a payment already applied, or on a receivable already part paid", async () => {
    const { orgId, acme } = await workspace("whole-refused");
    const [partPaid, open] = [await receivable(orgId, acme, 100), await receivable(orgId, acme, 40)];
    const applied = await transfer(orgId, 40);
    await allocate(orgId, { invoice: partPaid, transfer: applied, amount: 40 });
    await expect(db.query("update public.incoming_transfers set invoice_id = $2, matched_by = 'sender' where id = $1", [applied, open])).rejects.toThrow(
      /transfer_partly_applied/
    );
    const other = await transfer(orgId, 100);
    await expect(db.query("update public.incoming_transfers set invoice_id = $2, matched_by = 'sender' where id = $1", [other, partPaid])).rejects.toThrow(
      /receivable_partly_paid/
    );
  });

  it("is allowed again once every application is reversed", async () => {
    const { orgId, acme } = await workspace("whole-after-reversal");
    const invoice = await receivable(orgId, acme, 40);
    const paid = await transfer(orgId, 40);
    const [applied] = await allocate(orgId, { invoice, transfer: paid, amount: 40 });
    await allocate(orgId, { kind: "reversal", invoice, transfer: paid, amount: 40, reverses: applied, reason: "Undo", basis: null });
    await db.query("update public.incoming_transfers set invoice_id = $2, matched_by = 'sender' where id = $1", [paid, invoice]);
    // Releasing a claim never checks anything.
    await db.query("update public.incoming_transfers set invoice_id = null, matched_by = null where id = $1", [paid]);
  });
});

describe("receivable_allocations (0103): tenancy", () => {
  it("is seen and added to only by its own workspace's tenant requests, never changed or removed", async () => {
    const mine = await workspace("alloc-tenant-a");
    const theirs = await workspace("alloc-tenant-b");
    const myInvoice = await receivable(mine.orgId, mine.acme, 100);
    const myPayment = await transfer(mine.orgId, 100);
    const theirInvoice = await receivable(theirs.orgId, theirs.acme, 100);
    const theirPayment = await transfer(theirs.orgId, 100);
    await allocate(theirs.orgId, { invoice: theirInvoice, transfer: theirPayment, amount: 50 });

    // A tenant request applies its own payment, and the trigger settles its receivable under row-level security.
    await asTenant(db, mine.orgId, async (tx) => {
      const { sql, params } = values(mine.orgId, [{ invoice: myInvoice, transfer: myPayment, amount: 100 }]);
      await tx.query(sql, params);
    });
    expect((await invoiceOf(myInvoice)).status).toBe("received");

    const seen = await asTenant(db, mine.orgId, async (tx) => (await tx.query<{ invoice_id: string }>("select invoice_id from public.receivable_allocations")).rows);
    expect(seen.map((row) => row.invoice_id)).toEqual([myInvoice]);
    await expect(
      asTenant(db, mine.orgId, async (tx) => {
        const { sql, params } = values(theirs.orgId, [{ invoice: theirInvoice, transfer: theirPayment, amount: 10 }]);
        await tx.query(sql, params);
      })
    ).rejects.toThrow(/row-level security|allocation_not_a_receivable|allocation_no_payment/);
    await expect(asTenant(db, mine.orgId, (tx) => tx.query("update public.receivable_allocations set amount = 1"))).rejects.toThrow(/permission denied/);
    await expect(asTenant(db, mine.orgId, (tx) => tx.query("delete from public.receivable_allocations"))).rejects.toThrow(/permission denied/);
    await expect(asRole(db, "anon", (tx) => tx.query("select 1 from public.receivable_allocations"))).rejects.toThrow(/permission denied/);
  });

  it("names who applied it, kept null when their account is deleted, and goes with its receivable", async () => {
    const { orgId, acme } = await workspace("alloc-cascade");
    const invoice = await receivable(orgId, acme, 100);
    const paid = await transfer(orgId, 100);
    const person = await createUser(db, "owner-alloc@example.com");
    const [id] = await allocate(orgId, { invoice, transfer: paid, amount: 40 });
    await db.query("update public.receivable_allocations set created_by = $2 where id = $1", [id, person]);
    await db.query("delete from auth.users where id = $1", [person]);
    expect((await db.query<{ created_by: string | null }>("select created_by from public.receivable_allocations where id = $1", [id])).rows[0].created_by).toBeNull();
    await db.query("delete from public.invoices where id = $1", [invoice]);
    expect((await db.query("select 1 from public.receivable_allocations where id = $1", [id])).rows).toHaveLength(0);
  });
});
