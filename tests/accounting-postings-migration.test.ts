import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asRole, asTenant, createDatabase, createOrg, createUser } from "./support/pglite";

/**
 * Migration 0106 (docs/superpowers/specs/2026-10-12-accounting-writeback-design.md W1, W2, W6): a booking of a payment
 * made on Arc, drafted once per payable and provider, with what it writes fixed once drafted, its state moving only
 * along the review's transitions, and the reality rule held by the database itself: a booking reaches sending, sent or
 * confirmed only for a payment on Arc mainnet outside shadow mode, or into an organisation read as a demo one.
 */

let db: PGlite;
let person: string;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
  // Re-runnable, as scripts/migrate.ts re-runs every file.
  await applyMigrations(db, (file) => file.startsWith("0106_"));
  person = await createUser(db, "owner-books@example.com");
}, 60_000);

afterAll(async () => {
  await db.close();
});

const HASH = `0x${"ab".repeat(32)}`;
const FINGERPRINT = "f".repeat(64);
const ACCOUNT = JSON.stringify({ id: "acc-1", code: "090", name: "Arc USDC wallet", currency: "USD" });

interface World {
  orgId: string;
  connectionId: string;
  invoiceId: string;
}

async function world(slug: string): Promise<World> {
  const orgId = await createOrg(db, slug);
  const connectionId = (
    await db.query<{ id: string }>(
      `insert into public.accounting_connections (org_id, provider, external_org_id, external_org_name, consent_version, consented_at, window_from)
       values ($1, 'xero', 'tenant-1', 'Demo Company (Global)', 'xero-2026-10-12', now(), '2026-07-14') returning id`,
      [orgId]
    )
  ).rows[0].id;
  const counterpartyId = (await db.query<{ id: string }>("insert into public.counterparties (org_id, name, role) values ($1, 'Net Connect', 'vendor') returning id", [orgId])).rows[0].id;
  const invoiceId = (
    await db.query<{ id: string }>(
      "insert into public.invoices (org_id, direction, counterparty_id, amount, due_date, status, tx_ref) values ($1, 'payable', $2, 54.13, now(), 'paid', $3) returning id",
      [orgId, counterpartyId, HASH]
    )
  ).rows[0].id;
  return { orgId, connectionId, invoiceId };
}

async function draft(w: World, fields: { network?: string; shadow?: boolean; demo?: boolean | null; state?: string; provider?: string } = {}): Promise<string> {
  return (
    await db.query<{ id: string }>(
      `insert into public.accounting_postings (org_id, connection_id, provider, external_org_id, invoice_id, bill_external_id, amount, currency, paid_on,
         reference, network, shadow, paid_amount, paid_token, network_fee, organisation_demo, state)
       values ($1, $2, $3, 'tenant-1', $4, 'bill-1', 54.13, 'USD', '2026-10-12', $5, $6, $7, 54.13, 'USDC', 0.002, $8, $9) returning id`,
      [w.orgId, w.connectionId, fields.provider ?? "xero", w.invoiceId, HASH, fields.network ?? "arc-testnet", fields.shadow ?? true, fields.demo ?? null, fields.state ?? "draft"]
    )
  ).rows[0].id;
}

/** The payable's payment, confirmed on Arc: on Arc mainnet, the workspace is moved there first (0075 takes an intent's network from it). */
async function paid(w: World, network: "arc-testnet" | "arc-mainnet" = "arc-testnet", invoiceId = w.invoiceId): Promise<void> {
  if (network === "arc-mainnet") await db.query("update public.orgs set network = 'arc-mainnet' where id = $1", [w.orgId]);
  await db.query(
    `insert into public.payment_intents (org_id, source_type, source_id, idempotency_key, provider, provider_mode, amount, destination, status, tx_hash, confirmed_at)
     values ($1, 'invoice', $2, gen_random_uuid()::text, 'circle', 'live', 54.13, '0xAAA', 'confirmed', $3, now())`,
    [w.orgId, invoiceId, HASH]
  );
}

const claim = (id: string, demo: boolean | null = null) =>
  db.query(
    `update public.accounting_postings set state = 'sending', account = $2::jsonb, fingerprint = $3, approved_by = $4, approved_at = now(),
       sending_until = now() + interval '2 minutes', attempts = attempts + 1, organisation_demo = coalesce($5, organisation_demo) where id = $1`,
    [id, ACCOUNT, FINGERPRINT, person, demo]
  );

describe("accounting_postings", () => {
  it("keeps one booking per payable and provider", async () => {
    const w = await world("books-one");
    await draft(w);
    await expect(draft(w)).rejects.toThrow(/accounting_postings_one_per_payable/);
    // QuickBooks is another provider: the core's key names it.
    expect(await draft(w, { provider: "quickbooks" })).toBeTruthy();
  });

  it("is drafted, or refused at once, never inserted further along", async () => {
    const w = await world("books-insert");
    await expect(draft(w, { state: "sent" })).rejects.toThrow(/accounting_posting_insert/);
    expect(await draft(w, { state: "refused" })).toBeTruthy();
  });

  it("keeps what a booking writes fixed once drafted", async () => {
    const w = await world("books-fixed");
    const id = await draft(w);
    for (const change of ["amount = 1", "currency = 'EUR'", "paid_on = '2026-10-13'", `reference = '0x${"cd".repeat(32)}'`, "network = 'arc-mainnet'", "shadow = false", "bill_external_id = 'bill-2'"]) {
      await expect(db.query(`update public.accounting_postings set ${change} where id = $1`, [id]), change).rejects.toThrow(/accounting_posting_fixed/);
    }
  });

  it("holds the reality rule: a testnet or shadow payment goes no further than a draft unless the organisation is a demo one", async () => {
    const w = await world("books-reality");
    const id = await draft(w, { network: "arc-testnet", shadow: true, demo: false });
    await expect(claim(id)).rejects.toThrow(/accounting_postings_reality_check/);
    await claim(id, true);
    expect((await db.query<{ state: string }>("select state from public.accounting_postings where id = $1", [id])).rows[0].state).toBe("sending");
  });

  it("lets a payment on Arc mainnet outside shadow mode go to any organisation", async () => {
    const w = await world("books-mainnet");
    await paid(w, "arc-mainnet");
    const id = await draft(w, { network: "arc-mainnet", shadow: false, demo: false });
    await claim(id);
    await db.query("update public.accounting_postings set state = 'sent', external_payment_id = 'pay-1', sent_at = now() where id = $1", [id]);
    await db.query("update public.accounting_postings set state = 'confirmed', confirmed_at = now() where id = $1", [id]);
    expect((await db.query<{ state: string }>("select state from public.accounting_postings where id = $1", [id])).rows[0].state).toBe("confirmed");
  });

  it("refuses a shadow payment on Arc mainnet into a real organisation too", async () => {
    const w = await world("books-mainnet-shadow");
    await paid(w, "arc-mainnet");
    const id = await draft(w, { network: "arc-mainnet", shadow: true, demo: false });
    await expect(claim(id)).rejects.toThrow(/accounting_postings_reality_check/);
  });

  it("takes the payment's network from its own payment on Arc, never from what the draft says", async () => {
    const onTestnet = await world("books-network-testnet");
    await paid(onTestnet, "arc-testnet");
    const claimed = await draft(onTestnet, { network: "arc-mainnet", shadow: false, demo: false });
    expect((await db.query<{ network: string }>("select network from public.accounting_postings where id = $1", [claimed])).rows[0].network).toBe("arc-testnet");
    await expect(claim(claimed)).rejects.toThrow(/accounting_postings_reality_check/);
    // A payable with no payment on Arc mainnet at all is not one either.
    const unpaid = await world("books-network-none");
    const none = await draft(unpaid, { network: "arc-mainnet", shadow: false, demo: false });
    await expect(claim(none)).rejects.toThrow(/accounting_postings_reality_check/);
    // As the app drafts it, in its workspace's own scope: a payment made on Arc mainnet stays one.
    const onMainnet = await world("books-network-mainnet-tenant");
    await paid(onMainnet, "arc-mainnet");
    const drafted = await asTenant(db, onMainnet.orgId, (tx) =>
      tx.query<{ network: string; shadow: boolean }>(
        `insert into public.accounting_postings (org_id, connection_id, provider, external_org_id, invoice_id, bill_external_id, amount, currency, paid_on,
           reference, network, shadow, paid_amount, paid_token)
         values ($1, $2, 'xero', 'tenant-1', $3, 'bill-1', 54.13, 'USD', '2026-10-12', $4, 'arc-mainnet', false, 54.13, 'USDC') returning network, shadow`,
        [onMainnet.orgId, onMainnet.connectionId, onMainnet.invoiceId, HASH]
      )
    );
    expect(drafted.rows[0]).toEqual({ network: "arc-mainnet", shadow: false });
  });

  it("takes shadow mode from the workspace and the bill, never from what the draft says", async () => {
    // The workspace is in shadow mode.
    const inShadow = await world("books-shadow-workspace");
    await paid(inShadow, "arc-mainnet");
    await db.query("insert into public.shadow_modes (org_id, currency) values ($1, 'USDC')", [inShadow.orgId]);
    const fromWorkspace = await draft(inShadow, { network: "arc-mainnet", shadow: false, demo: false });
    expect((await db.query<{ shadow: boolean }>("select shadow from public.accounting_postings where id = $1", [fromWorkspace])).rows[0].shadow).toBe(true);
    await expect(claim(fromWorkspace)).rejects.toThrow(/accounting_postings_reality_check/);
    // The bill keeps an original currency, only ever set in shadow mode.
    const kept = await world("books-shadow-bill");
    await paid(kept, "arc-mainnet");
    await db.query("update public.invoices set original_currency = 'EUR', original_amount = 50, fx_rate = 1.0826, fx_source = 'test', fx_at = now() where id = $1", [kept.invoiceId]);
    const fromBill = await draft(kept, { network: "arc-mainnet", shadow: false, demo: false });
    await expect(claim(fromBill)).rejects.toThrow(/accounting_postings_reality_check/);
  });

  it("moves only along the review's transitions, and never out of confirmed or refused", async () => {
    const w = await world("books-transitions");
    const id = await draft(w, { demo: true });
    await expect(db.query("update public.accounting_postings set state = 'sent', external_payment_id = 'p', account = $2::jsonb, fingerprint = $3 where id = $1", [id, ACCOUNT, FINGERPRINT])).rejects.toThrow(
      /accounting_posting_transition/
    );
    await claim(id);
    // A send that found the bill changed goes back to a draft, and may be claimed again.
    await db.query("update public.accounting_postings set state = 'draft', sending_until = null where id = $1", [id]);
    await claim(id);
    await db.query("update public.accounting_postings set state = 'failed', reason = 'no_answer', message = 'Xero did not answer.', sending_until = null where id = $1", [id]);
    await claim(id);
    await expect(db.query("update public.accounting_postings set state = 'sent' where id = $1", [id])).rejects.toThrow(/accounting_postings_sent_check/);
    await db.query("update public.accounting_postings set state = 'sent', external_payment_id = 'pay-2', sent_at = now() where id = $1", [id]);
    await expect(db.query("update public.accounting_postings set state = 'confirmed' where id = $1", [id])).rejects.toThrow(/accounting_postings_confirmed_check/);
    await db.query("update public.accounting_postings set state = 'confirmed', confirmed_at = now() where id = $1", [id]);
    await expect(db.query("update public.accounting_postings set message = 'changed' where id = $1", [id])).rejects.toThrow(/accounting_posting_final/);
    const refused = await draft(await world("books-refused"));
    await db.query("update public.accounting_postings set state = 'refused', reason = 'reality', message = 'Not booked.' where id = $1", [refused]);
    await expect(db.query("update public.accounting_postings set state = 'draft' where id = $1", [refused])).rejects.toThrow(/accounting_posting_final/);
  });

  it("names one provider payment once per connection", async () => {
    const w = await world("books-payment-once");
    await paid(w, "arc-mainnet");
    const first = await draft(w, { network: "arc-mainnet", shadow: false });
    await claim(first);
    await db.query("update public.accounting_postings set state = 'sent', external_payment_id = 'pay-3', sent_at = now() where id = $1", [first]);
    // Another payable of the same workspace and connection cannot claim the same payment.
    const counterpartyId = (await db.query<{ id: string }>("select counterparty_id as id from public.invoices where id = $1", [w.invoiceId])).rows[0].id;
    const secondInvoice = (
      await db.query<{ id: string }>("insert into public.invoices (org_id, direction, counterparty_id, amount, due_date, status) values ($1, 'payable', $2, 5, now(), 'paid') returning id", [w.orgId, counterpartyId])
    ).rows[0].id;
    await paid(w, "arc-mainnet", secondInvoice);
    const second = await draft({ ...w, invoiceId: secondInvoice }, { network: "arc-mainnet", shadow: false });
    await claim(second);
    await expect(db.query("update public.accounting_postings set state = 'sent', external_payment_id = 'pay-3', sent_at = now() where id = $1", [second])).rejects.toThrow(
      /accounting_postings_payment_key/
    );
  });

  it("keeps a booking in its payable's workspace", async () => {
    const a = await world("books-own-a");
    const b = await world("books-own-b");
    await expect(draft({ orgId: a.orgId, connectionId: a.connectionId, invoiceId: b.invoiceId })).rejects.toThrow(/accounting_postings_invoice_fkey/);
    await expect(draft({ orgId: a.orgId, connectionId: b.connectionId, invoiceId: a.invoiceId })).rejects.toThrow(/accounting_postings_connection_fkey/);
  });

  it("is read and written by its own workspace only, never deleted by the tenant role, and closed to the browser roles", async () => {
    const a = await world("books-tenant-a");
    const b = await world("books-tenant-b");
    await draft(a);
    const theirs = await draft(b);
    const seen = await asTenant(db, a.orgId, async (tx) => (await tx.query<{ org_id: string }>("select org_id from public.accounting_postings")).rows);
    expect(seen.map((row) => row.org_id)).toEqual([a.orgId]);
    const updated = await asTenant(db, a.orgId, (tx) => tx.query("update public.accounting_postings set message = 'x' where id = $1", [theirs]));
    expect(updated.affectedRows ?? 0).toBe(0);
    await expect(asTenant(db, a.orgId, (tx) => tx.query("delete from public.accounting_postings where org_id = $1", [a.orgId]))).rejects.toThrow(/permission denied/);
    await expect(asRole(db, "authenticated", (tx) => tx.query("select 1 from public.accounting_postings"))).rejects.toThrow(/permission denied/);
  });

  it("goes with its payable and with its connection (the workspace's deletion: delete-org-migration)", async () => {
    const byInvoice = await world("books-cascade-invoice");
    await draft(byInvoice);
    await db.query("delete from public.invoices where id = $1", [byInvoice.invoiceId]);
    expect((await db.query("select 1 from public.accounting_postings where org_id = $1", [byInvoice.orgId])).rows).toHaveLength(0);
    const byConnection = await world("books-cascade-connection");
    await draft(byConnection);
    await db.query("delete from public.accounting_connections where id = $1", [byConnection.connectionId]);
    expect((await db.query("select 1 from public.accounting_postings where org_id = $1", [byConnection.orgId])).rows).toHaveLength(0);
  });

  it("lets the approver's account go from a final booking", async () => {
    const w = await world("books-approver-gone");
    await paid(w, "arc-mainnet");
    const id = await draft(w, { network: "arc-mainnet", shadow: false });
    await claim(id);
    await db.query("update public.accounting_postings set state = 'sent', external_payment_id = 'pay-9', sent_at = now() where id = $1", [id]);
    await db.query("update public.accounting_postings set state = 'confirmed', confirmed_at = now() where id = $1", [id]);
    const gone = await createUser(db, "leaving-books@example.com");
    await expect(db.query("update public.accounting_postings set approved_by = $2 where id = $1", [id, gone])).rejects.toThrow(/accounting_posting_final/);
    await db.query("update public.accounting_postings set approved_by = null where id = $1", [id]);
    expect((await db.query<{ approved_by: string | null }>("select approved_by from public.accounting_postings where id = $1", [id])).rows[0].approved_by).toBeNull();
  });
});
