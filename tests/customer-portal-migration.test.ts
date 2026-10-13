import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asRole, asServiceRole, asTenant, createDatabase, createOrg, createUser } from "./support/pglite";

/**
 * Migration 0109 (docs/superpowers/specs/2026-10-13-customer-portal-design.md P2-P6): a customer's statement link, kept
 * only as the SHA-256 of its secret, one live per customer, expiring and stopped once; what the customer said through it
 * (a claim of payment, a promise, a dispute, a pay link asked for), added only by the service role's checked functions,
 * closed once by the workspace; the thread under each, whose customer side only those functions write; and the lookup,
 * which names nothing of an expired link and answers null for a stopped one.
 */

let db: PGlite;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
  // Re-runnable, as scripts/migrate.ts re-runs every file.
  await applyMigrations(db, (file) => file.startsWith("0109_"));
}, 60_000);

afterAll(async () => {
  await db.close();
});

let counter = 0;
const nextHash = () => (++counter).toString(16).padStart(64, "0");

async function customer(orgId: string, name = "Acme Corp", role = "client"): Promise<string> {
  return (await db.query<{ id: string }>("insert into public.counterparties (org_id, name, role) values ($1, $2, $3) returning id", [orgId, name, role])).rows[0].id;
}

async function receivable(orgId: string, counterpartyId: string, fields: { status?: string; amount?: number; direction?: string } = {}): Promise<string> {
  return (
    await db.query<{ id: string }>(
      "insert into public.invoices (org_id, direction, counterparty_id, amount, due_date, status) values ($1, $2, $3, $4, now(), $5) returning id",
      [orgId, fields.direction ?? "receivable", counterpartyId, fields.amount ?? 100, fields.status ?? "pending"]
    )
  ).rows[0].id;
}

async function link(orgId: string, counterpartyId: string, hash = nextHash(), expiresIn = "30 days"): Promise<{ id: string; hash: string }> {
  const id = (
    await db.query<{ id: string }>(
      `insert into public.customer_portal_links (org_id, counterparty_id, token_hash, expires_at) values ($1, $2, $3, now() + $4::interval) returning id`,
      [orgId, counterpartyId, hash, expiresIn]
    )
  ).rows[0].id;
  return { id, hash };
}

type Submission = { kind: string; paidOn?: string | null; reference?: string | null; amount?: number | null; promisedOn?: string | null; message?: string | null };

const submit = (hash: string, invoiceId: string, s: Submission) =>
  asServiceRole(db, async (tx) =>
    (
      await tx.query<{ out: Record<string, unknown> }>("select public.customer_portal_submit($1, $2, $3, $4, $5, $6, $7, $8) as out", [
        hash,
        invoiceId,
        s.kind,
        s.paidOn ?? null,
        s.reference ?? null,
        s.amount ?? null,
        s.promisedOn ?? null,
        s.message ?? null,
      ])
    ).rows[0].out
  );

const reply = (hash: string, requestId: string, message: string) =>
  asServiceRole(db, async (tx) => (await tx.query<{ out: Record<string, unknown> }>("select public.customer_portal_reply($1, $2, $3) as out", [hash, requestId, message])).rows[0].out);

const lookUp = (hash: string) =>
  asServiceRole(db, async (tx) => (await tx.query<{ found: Record<string, unknown> | null }>("select public.customer_portal_by_token($1) as found", [hash])).rows[0].found);

const today = () => new Date().toISOString().slice(0, 10);
const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

describe("customer_portal_links (0109)", () => {
  it("keeps a link's hash and expiry, for a customer only, one live per customer", async () => {
    const orgId = await createOrg(db, "portal-links");
    const client = await customer(orgId);
    const vendor = await customer(orgId, "Paper Co", "vendor");
    const first = await link(orgId, client);
    await expect(link(orgId, vendor)).rejects.toThrow(/customer_portal_not_client/);
    await expect(link(orgId, client)).rejects.toThrow(/customer_portal_links_one_live/);
    await db.query("update public.customer_portal_links set revoked_at = now() where id = $1", [first.id]);
    await link(orgId, client);
  });

  it("takes only a 64-character hex hash, once, and an expiry within about 90 days", async () => {
    const orgId = await createOrg(db, "portal-hash");
    const a = await customer(orgId, "A");
    const b = await customer(orgId, "B");
    const c = await customer(orgId, "C");
    const taken = await link(orgId, a);
    await expect(link(orgId, b, taken.hash)).rejects.toThrow(/customer_portal_links_token_hash_key/);
    await expect(link(orgId, b, "vxc_not-a-hash")).rejects.toThrow(/customer_portal_links_token_hash_check/);
    await expect(link(orgId, b, "AB".repeat(32))).rejects.toThrow(/customer_portal_links_token_hash_check/);
    await expect(link(orgId, b, nextHash(), "92 days")).rejects.toThrow(/customer_portal_links_expiry_check/);
    await expect(link(orgId, b, nextHash(), "-1 hour")).rejects.toThrow(/customer_portal_links_expiry_check/);
    await link(orgId, c, nextHash(), "90 days");
  });

  it("lets the tenant stop its own link once, and change nothing else of it", async () => {
    const orgId = await createOrg(db, "portal-revoke");
    const person = await createUser(db, "owner-portal@example.com");
    const { id } = await link(orgId, await customer(orgId));
    await asTenant(db, orgId, (tx) => tx.query("update public.customer_portal_links set revoked_at = now(), revoked_by = $2 where id = $1", [id, person]));
    const revoked = (await db.query<{ revoked_by: string }>("select revoked_by from public.customer_portal_links where id = $1", [id])).rows[0];
    expect(revoked.revoked_by).toBe(person);
    await expect(asTenant(db, orgId, (tx) => tx.query("update public.customer_portal_links set revoked_at = null where id = $1", [id]))).rejects.toThrow(/customer_portal_link_revoked/);
    await expect(asTenant(db, orgId, (tx) => tx.query("update public.customer_portal_links set expires_at = now() + interval '80 days' where id = $1", [id]))).rejects.toThrow(/permission denied/);
    await expect(asTenant(db, orgId, (tx) => tx.query("update public.customer_portal_links set token_hash = $2 where id = $1", [id, nextHash()]))).rejects.toThrow(/permission denied/);
    await expect(asTenant(db, orgId, (tx) => tx.query("delete from public.customer_portal_links where id = $1", [id]))).rejects.toThrow(/permission denied/);
  });

  it("is seen, made and stopped only by its own workspace", async () => {
    const mine = await createOrg(db, "portal-tenant-a");
    const theirs = await createOrg(db, "portal-tenant-b");
    const myClient = await customer(mine);
    const theirClient = await customer(theirs);
    const theirLink = await link(theirs, theirClient);
    const made = await asTenant(db, mine, async (tx) =>
      (await tx.query<{ id: string }>("insert into public.customer_portal_links (org_id, counterparty_id, token_hash, expires_at) values ($1, $2, $3, now() + interval '7 days') returning id", [mine, myClient, nextHash()])).rows
    );
    expect(made).toHaveLength(1);
    const seen = await asTenant(db, mine, async (tx) => (await tx.query<{ org_id: string }>("select org_id from public.customer_portal_links")).rows);
    expect(seen.every((row) => row.org_id === mine)).toBe(true);
    // Another workspace's customer cannot be linked, whatever the row says.
    await expect(
      asTenant(db, mine, (tx) => tx.query("insert into public.customer_portal_links (org_id, counterparty_id, token_hash, expires_at) values ($1, $2, $3, now() + interval '7 days')", [mine, theirClient, nextHash()]))
    ).rejects.toThrow(/customer_portal_not_client|customer_portal_links_counterparty_fkey/);
    const stopped = await asTenant(db, mine, (tx) => tx.query("update public.customer_portal_links set revoked_at = now() where id = $1", [theirLink.id]));
    expect(stopped.affectedRows ?? 0).toBe(0);
    for (const role of ["anon", "authenticated"] as const) {
      await expect(asRole(db, role, (tx) => tx.query("select 1 from public.customer_portal_links"))).rejects.toThrow(/permission denied/);
    }
  });

  it("takes from the tenant only what a new link needs: never the day it was made", async () => {
    // The expiry is bounded by created_at: a tenant that could write created_at could make a link that works for years.
    const orgId = await createOrg(db, "portal-created-at");
    const client = await customer(orgId);
    await expect(
      asTenant(db, orgId, (tx) =>
        tx.query(
          "insert into public.customer_portal_links (org_id, counterparty_id, token_hash, created_at, expires_at) values ($1, $2, $3, now() + interval '5 years', now() + interval '5 years 30 days')",
          [orgId, client, nextHash()]
        )
      )
    ).rejects.toThrow(/permission denied/);
    const made = await asTenant(db, orgId, async (tx) =>
      (await tx.query<{ id: string }>("insert into public.customer_portal_links (org_id, counterparty_id, token_hash, expires_at) values ($1, $2, $3, now() + interval '30 days') returning id", [orgId, client, nextHash()])).rows
    );
    expect(made).toHaveLength(1);
  });

  it("gives the browser roles no use of its trigger functions", async () => {
    for (const fn of [
      "customer_portal_links_client()",
      "customer_portal_links_revoke_once()",
      "customer_requests_consistent()",
      "customer_requests_close_once()",
      "customer_request_messages_open()",
    ]) {
      for (const role of ["anon", "authenticated"]) {
        const granted = (await db.query<{ ok: boolean }>("select has_function_privilege($1, $2, 'execute') as ok", [role, `public.${fn}`])).rows[0].ok;
        expect(granted, `${role} on ${fn}`).toBe(false);
      }
    }
  });

  it("goes with its customer and its workspace", async () => {
    const orgId = await createOrg(db, "portal-cascade");
    const client = await customer(orgId);
    const { hash } = await link(orgId, client);
    await db.query("delete from public.counterparties where id = $1", [client]);
    expect((await db.query("select 1 from public.customer_portal_links where token_hash = $1", [hash])).rows).toHaveLength(0);
  });
});

describe("customer_portal_by_token (0109)", () => {
  it("returns a live link's customer, workspace and expiry", async () => {
    const orgId = await createOrg(db, "portal-lookup");
    await db.query("update public.orgs set name = 'Harbor Books' where id = $1", [orgId]);
    const client = await customer(orgId, "Acme Corp");
    const { id, hash } = await link(orgId, client);
    expect(await lookUp(hash)).toMatchObject({
      expired: false,
      linkId: id,
      orgId,
      counterpartyId: client,
      orgName: "Harbor Books",
      customerName: "Acme Corp",
      mode: "sandbox",
      network: "arc-testnet",
    });
  });

  it("names nothing of an expired link, and answers null for a stopped or unknown one", async () => {
    const orgId = await createOrg(db, "portal-dead");
    const a = await customer(orgId, "Expired Ltd");
    const expired = await link(orgId, a);
    await db.query("update public.customer_portal_links set created_at = now() - interval '40 days', expires_at = now() - interval '10 days' where id = $1", [expired.id]);
    const found = await lookUp(expired.hash);
    expect(found).toMatchObject({ expired: true });
    expect(Object.keys(found ?? {}).sort()).toEqual(["expired", "expiresAt"]);

    const b = await customer(orgId, "Stopped Ltd");
    const stopped = await link(orgId, b);
    await db.query("update public.customer_portal_links set revoked_at = now() where id = $1", [stopped.id]);
    expect(await lookUp(stopped.hash)).toBeNull();
    expect(await lookUp(nextHash())).toBeNull();
  });

  it("is the service role's alone, as are the writes", async () => {
    const orgId = await createOrg(db, "portal-callers");
    for (const call of [
      "select public.customer_portal_by_token('x')",
      "select public.customer_portal_submit('x', gen_random_uuid(), 'pay_link', null, null, null, null, null)",
      "select public.customer_portal_reply('x', gen_random_uuid(), 'hello')",
      "select public.customer_portal_live_link('x')",
    ]) {
      for (const role of ["anon", "authenticated"] as const) {
        await expect(asRole(db, role, (tx) => tx.query(call))).rejects.toThrow(/permission denied/);
      }
      await expect(asTenant(db, orgId, (tx) => tx.query(call))).rejects.toThrow(/permission denied/);
    }
  });
});

describe("customer_portal_submit (0109)", () => {
  async function setUp(tag: string) {
    const orgId = await createOrg(db, `portal-submit-${tag}`);
    const client = await customer(orgId, "Acme Corp");
    const other = await customer(orgId, "Other Customer");
    const invoiceId = await receivable(orgId, client, { amount: 1250 });
    const othersInvoice = await receivable(orgId, other, { amount: 900 });
    const { id: linkId, hash } = await link(orgId, client);
    return { orgId, client, other, invoiceId, othersInvoice, linkId, hash };
  }

  it("records that the customer says it paid, with its day, reference and amount, and settles nothing", async () => {
    const { orgId, invoiceId, hash, linkId, client } = await setUp("paid");
    const out = await submit(hash, invoiceId, { kind: "paid", paidOn: today(), reference: "  WIRE-2210  ", amount: 1250, message: "Sent from our bank." });
    expect(out).toMatchObject({ appended: false, superseded: [], orgId, linkId, counterpartyId: client, invoiceId });
    const row = (
      await db.query<{ kind: string; reference: string; amount: string; status: string }>("select kind, reference, amount, status from public.customer_requests where id = $1", [out.requestId])
    ).rows[0];
    expect(row).toMatchObject({ kind: "paid", reference: "WIRE-2210", status: "open" });
    expect(Number(row.amount)).toBe(1250);
    const invoice = (await db.query<{ status: string }>("select status from public.invoices where id = $1", [invoiceId])).rows[0];
    expect(invoice.status).toBe("pending");
    const messages = (await db.query<{ author: string; body: string; link_id: string }>("select author, body, link_id from public.customer_request_messages where request_id = $1", [out.requestId])).rows;
    expect(messages).toEqual([{ author: "customer", body: "Sent from our bank.", link_id: linkId }]);
  });

  it("replaces an open claim or promise of the same kind, and adds to an open dispute or pay link request", async () => {
    const { invoiceId, hash } = await setUp("again");
    const first = await submit(hash, invoiceId, { kind: "promise", promisedOn: inDays(5) });
    const second = await submit(hash, invoiceId, { kind: "promise", promisedOn: inDays(9) });
    expect(second.superseded).toEqual([first.requestId]);
    const old = (await db.query<{ status: string; outcome: string; closed_by: string | null }>("select status, outcome, closed_by from public.customer_requests where id = $1", [first.requestId])).rows[0];
    expect(old).toEqual({ status: "closed", outcome: "superseded", closed_by: null });

    const dispute = await submit(hash, invoiceId, { kind: "dispute", message: "We were charged twice for October." });
    const more = await submit(hash, invoiceId, { kind: "dispute", message: "Here is the second charge." });
    expect(more).toMatchObject({ requestId: dispute.requestId, appended: true });
    const count = (await db.query<{ n: number }>("select count(*)::int as n from public.customer_request_messages where request_id = $1", [dispute.requestId])).rows[0].n;
    expect(count).toBe(2);

    const ask = await submit(hash, invoiceId, { kind: "pay_link" });
    expect(await submit(hash, invoiceId, { kind: "pay_link" })).toMatchObject({ requestId: ask.requestId, appended: true });
  });

  it("says when asking again for a pay link wrote nothing, so nothing is signed or sent for it", async () => {
    // A second ask with no words adds no row, so the cap of 30 a day never counts it: the caller must not sign it either.
    const { invoiceId, hash } = await setUp("ask-again");
    const ask = await submit(hash, invoiceId, { kind: "pay_link" });
    expect(ask).toMatchObject({ appended: false, written: true });
    const again = await submit(hash, invoiceId, { kind: "pay_link" });
    expect(again).toMatchObject({ requestId: ask.requestId, appended: true, written: false, notify: false });
    const withWords = await submit(hash, invoiceId, { kind: "pay_link", message: "Still waiting for it." });
    expect(withWords).toMatchObject({ requestId: ask.requestId, appended: true, written: true });
  });

  it("asks for an email to finance at most once an hour per request", async () => {
    const { invoiceId, hash } = await setUp("notify");
    const dispute = await submit(hash, invoiceId, { kind: "dispute", message: "Wrong rate." });
    expect(dispute).toMatchObject({ notify: true });
    expect(await submit(hash, invoiceId, { kind: "dispute", message: "And the second charge." })).toMatchObject({ appended: true, notify: false });
    expect(await reply(hash, String(dispute.requestId), "Here is the contract.")).toMatchObject({ notify: false });
    await db.query("update public.customer_requests set notified_at = now() - interval '61 minutes' where id = $1", [dispute.requestId]);
    expect(await reply(hash, String(dispute.requestId), "Any news?")).toMatchObject({ notify: true });
    expect(await reply(hash, String(dispute.requestId), "Hello?")).toMatchObject({ notify: false });

    // A claim that replaces one told about within the hour is not told again; one replacing an older one is.
    const claim = await submit(hash, invoiceId, { kind: "paid", paidOn: today() });
    expect(claim).toMatchObject({ notify: true });
    const corrected = await submit(hash, invoiceId, { kind: "paid", paidOn: today(), reference: "WIRE-1" });
    expect(corrected).toMatchObject({ superseded: [claim.requestId], notify: false });
    await db.query("update public.customer_requests set notified_at = now() - interval '2 hours' where id = $1", [corrected.requestId]);
    expect(await submit(hash, invoiceId, { kind: "paid", paidOn: today(), reference: "WIRE-2" })).toMatchObject({ superseded: [corrected.requestId], notify: true });

    // The tenant role cannot move the stamp.
    const orgId = (await db.query<{ org_id: string }>("select org_id from public.customer_requests where id = $1", [dispute.requestId])).rows[0].org_id;
    await expect(asTenant(db, orgId, (tx) => tx.query("update public.customer_requests set notified_at = null where id = $1", [dispute.requestId]))).rejects.toThrow(/permission denied/);
  });

  it("refuses another customer's invoice, a payable, a closed invoice and an invoice of another workspace", async () => {
    const { invoiceId, othersInvoice, hash, orgId, client } = await setUp("scope");
    await expect(submit(hash, othersInvoice, { kind: "pay_link" })).rejects.toThrow(/customer_portal_invoice_not_found/);
    const payable = await receivable(orgId, client, { direction: "payable" });
    await expect(submit(hash, payable, { kind: "pay_link" })).rejects.toThrow(/customer_portal_invoice_not_found/);
    const received = await receivable(orgId, client, { status: "received" });
    await expect(submit(hash, received, { kind: "paid", paidOn: today() })).rejects.toThrow(/customer_portal_invoice_closed/);
    const elsewhere = await createOrg(db, "portal-submit-elsewhere");
    const elsewhereInvoice = await receivable(elsewhere, await customer(elsewhere));
    await expect(submit(hash, elsewhereInvoice, { kind: "pay_link" })).rejects.toThrow(/customer_portal_invoice_not_found/);
    expect((await submit(hash, invoiceId, { kind: "pay_link" })).invoiceId).toBe(invoiceId);
  });

  it("checks each kind's fields: a day paid not in the future, a promise within 90 days, a dispute's words", async () => {
    const { invoiceId, hash } = await setUp("fields");
    await expect(submit(hash, invoiceId, { kind: "paid" })).rejects.toThrow(/customer_portal_invalid: paid_on/);
    await expect(submit(hash, invoiceId, { kind: "paid", paidOn: inDays(5) })).rejects.toThrow(/customer_portal_invalid: paid_on/);
    await expect(submit(hash, invoiceId, { kind: "paid", paidOn: today(), amount: -1 })).rejects.toThrow(/customer_portal_invalid: amount/);
    await expect(submit(hash, invoiceId, { kind: "paid", paidOn: today(), reference: "x".repeat(121) })).rejects.toThrow(/customer_portal_invalid: reference/);
    await expect(submit(hash, invoiceId, { kind: "promise", promisedOn: inDays(-1) })).rejects.toThrow(/customer_portal_invalid: promised_on/);
    await expect(submit(hash, invoiceId, { kind: "promise", promisedOn: inDays(91) })).rejects.toThrow(/customer_portal_invalid: promised_on/);
    await expect(submit(hash, invoiceId, { kind: "dispute", message: "   " })).rejects.toThrow(/customer_portal_invalid: message/);
    await expect(submit(hash, invoiceId, { kind: "dispute", message: "x".repeat(2001) })).rejects.toThrow(/customer_portal_invalid: message/);
    await expect(submit(hash, invoiceId, { kind: "refund" })).rejects.toThrow(/customer_portal_invalid: kind/);
  });

  it("refuses an expired, stopped or unknown link, and stops a link at 30 a day", async () => {
    const { invoiceId, hash, linkId, orgId } = await setUp("dead");
    for (let i = 0; i < 15; i += 1) await submit(hash, invoiceId, { kind: "promise", promisedOn: inDays(3), message: `Promise ${i}` });
    await expect(submit(hash, invoiceId, { kind: "pay_link" })).rejects.toThrow(/customer_portal_limit/);

    const second = await setUp("dead-2");
    await db.query("update public.customer_portal_links set created_at = now() - interval '40 days', expires_at = now() - interval '1 minute' where id = $1", [second.linkId]);
    await expect(submit(second.hash, second.invoiceId, { kind: "pay_link" })).rejects.toThrow(/customer_portal_link_dead/);

    await db.query("update public.customer_portal_links set revoked_at = now() where id = $1", [linkId]);
    await expect(submit(hash, invoiceId, { kind: "pay_link" })).rejects.toThrow(/customer_portal_link_dead/);
    await expect(submit(nextHash(), invoiceId, { kind: "pay_link" })).rejects.toThrow(/customer_portal_link_dead/);
    expect(orgId).toBeTruthy();
  });

  it("works from a forwarded link the same way, and only for that link's customer", async () => {
    // A link is a bearer credential: whoever holds it acts as the customer, on that customer's invoices only.
    const { invoiceId, othersInvoice, hash } = await setUp("forwarded");
    const out = await submit(hash, invoiceId, { kind: "dispute", message: "Forwarded to our accounts team." });
    expect(out.invoiceId).toBe(invoiceId);
    await expect(submit(hash, othersInvoice, { kind: "dispute", message: "Not ours." })).rejects.toThrow(/customer_portal_invoice_not_found/);
  });
});

describe("customer_portal_reply (0109)", () => {
  it("adds the customer's words under its own open request, and nowhere else", async () => {
    const orgId = await createOrg(db, "portal-reply");
    const client = await customer(orgId, "Acme Corp");
    const other = await customer(orgId, "Other Customer");
    const invoiceId = await receivable(orgId, client);
    const othersInvoice = await receivable(orgId, other);
    const mine = await link(orgId, client);
    const theirs = await link(orgId, other);
    const request = await submit(mine.hash, invoiceId, { kind: "dispute", message: "Wrong rate." });
    const theirRequest = await submit(theirs.hash, othersInvoice, { kind: "dispute", message: "Theirs." });

    expect(await reply(mine.hash, String(request.requestId), "Here is the contract.")).toMatchObject({ requestId: request.requestId, invoiceId, kind: "dispute" });
    await expect(reply(mine.hash, String(theirRequest.requestId), "Hello")).rejects.toThrow(/customer_portal_request_not_found/);
    await expect(reply(mine.hash, String(request.requestId), "  ")).rejects.toThrow(/customer_portal_invalid: message/);

    await db.query("update public.customer_requests set status = 'closed', outcome = 'resolved', closed_at = now() where id = $1", [request.requestId]);
    await expect(reply(mine.hash, String(request.requestId), "One more thing")).rejects.toThrow(/customer_request_closed/);
  });
});

describe("customer_requests and customer_request_messages under the tenant role (0109)", () => {
  async function opened(tag: string) {
    const orgId = await createOrg(db, `portal-tenant-${tag}`);
    const client = await customer(orgId);
    const invoiceId = await receivable(orgId, client);
    const { hash, id: linkId } = await link(orgId, client);
    const { requestId } = (await submit(hash, invoiceId, { kind: "dispute", message: "Not delivered." })) as { requestId: string };
    return { orgId, client, invoiceId, linkId, requestId };
  }

  it("reads and closes a request once, and changes nothing the customer said", async () => {
    const { orgId, requestId, client, invoiceId, linkId } = await opened("close");
    const person = await createUser(db, "finance-portal@example.com");
    await asTenant(db, orgId, (tx) =>
      tx.query("update public.customer_requests set status = 'closed', outcome = 'resolved', closed_at = now(), closed_by = $2 where id = $1", [requestId, person])
    );
    await expect(
      asTenant(db, orgId, (tx) => tx.query("update public.customer_requests set status = 'open', outcome = null, closed_at = null, closed_by = null where id = $1", [requestId]))
    ).rejects.toThrow(/customer_request_closed/);
    await expect(asTenant(db, orgId, (tx) => tx.query("update public.customer_requests set reference = 'x' where id = $1", [requestId]))).rejects.toThrow(/permission denied/);
    await expect(asTenant(db, orgId, (tx) => tx.query("delete from public.customer_requests where id = $1", [requestId]))).rejects.toThrow(/permission denied/);
    // The tenant cannot write a request as if the customer had.
    await expect(
      asTenant(db, orgId, (tx) =>
        tx.query("insert into public.customer_requests (org_id, link_id, counterparty_id, invoice_id, kind) values ($1, $2, $3, $4, 'pay_link')", [orgId, linkId, client, invoiceId])
      )
    ).rejects.toThrow(/permission denied/);
  });

  it("refuses a closed request without its outcome and day", async () => {
    const { orgId, requestId } = await opened("shape");
    await expect(asTenant(db, orgId, (tx) => tx.query("update public.customer_requests set status = 'closed' where id = $1", [requestId]))).rejects.toThrow(/customer_requests_closed_check/);
  });

  it("adds a reply as the business, never as the customer, and none to a closed request", async () => {
    const { orgId, requestId, linkId } = await opened("reply");
    const person = await createUser(db, "replier-portal@example.com");
    const written = await asTenant(db, orgId, async (tx) =>
      (await tx.query<{ author: string; link_id: string | null }>("insert into public.customer_request_messages (org_id, request_id, body, by) values ($1, $2, 'We are checking.', $3) returning author, link_id", [orgId, requestId, person])).rows
    );
    expect(written).toEqual([{ author: "business", link_id: null }]);
    await expect(
      asTenant(db, orgId, (tx) => tx.query("insert into public.customer_request_messages (org_id, request_id, body, author) values ($1, $2, 'Paid!', 'customer')", [orgId, requestId]))
    ).rejects.toThrow(/permission denied/);
    await expect(
      asTenant(db, orgId, (tx) => tx.query("insert into public.customer_request_messages (org_id, request_id, body, link_id) values ($1, $2, 'Paid!', $3)", [orgId, requestId, linkId]))
    ).rejects.toThrow(/permission denied/);
    await expect(asTenant(db, orgId, (tx) => tx.query("update public.customer_request_messages set body = 'changed'"))).rejects.toThrow(/permission denied/);
    await expect(asTenant(db, orgId, (tx) => tx.query("delete from public.customer_request_messages"))).rejects.toThrow(/permission denied/);
    await db.query("update public.customer_requests set status = 'closed', outcome = 'resolved', closed_at = now() where id = $1", [requestId]);
    await expect(
      asTenant(db, orgId, (tx) => tx.query("insert into public.customer_request_messages (org_id, request_id, body) values ($1, $2, 'Too late')", [orgId, requestId]))
    ).rejects.toThrow(/customer_request_closed/);
  });

  it("keeps each workspace's requests and messages its own", async () => {
    const a = await opened("iso-a");
    const b = await opened("iso-b");
    const seen = await asTenant(db, a.orgId, async (tx) => (await tx.query<{ org_id: string }>("select org_id from public.customer_requests")).rows);
    expect(seen.every((row) => row.org_id === a.orgId)).toBe(true);
    const messages = await asTenant(db, a.orgId, async (tx) => (await tx.query<{ org_id: string }>("select org_id from public.customer_request_messages")).rows);
    expect(messages.every((row) => row.org_id === a.orgId)).toBe(true);
    await expect(
      asTenant(db, a.orgId, (tx) => tx.query("insert into public.customer_request_messages (org_id, request_id, body) values ($1, $2, 'cross')", [a.orgId, b.requestId]))
    ).rejects.toThrow(/customer_request_closed|customer_request_messages_request_fkey/);
    const closed = await asTenant(db, a.orgId, (tx) => tx.query("update public.customer_requests set status = 'closed', outcome = 'resolved', closed_at = now() where id = $1", [b.requestId]));
    expect(closed.affectedRows ?? 0).toBe(0);
    for (const role of ["anon", "authenticated"] as const) {
      await expect(asRole(db, role, (tx) => tx.query("select 1 from public.customer_requests"))).rejects.toThrow(/permission denied/);
      await expect(asRole(db, role, (tx) => tx.query("select 1 from public.customer_request_messages"))).rejects.toThrow(/permission denied/);
    }
  });

  it("goes with its invoice", async () => {
    const { requestId, invoiceId } = await opened("cascade");
    await db.query("delete from public.invoices where id = $1", [invoiceId]);
    expect((await db.query("select 1 from public.customer_requests where id = $1", [requestId])).rows).toHaveLength(0);
    expect((await db.query("select 1 from public.customer_request_messages where request_id = $1", [requestId])).rows).toHaveLength(0);
  });
});
