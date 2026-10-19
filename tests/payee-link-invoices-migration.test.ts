import crypto from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asRole, asServiceRole, asTenant, createDatabase, createOrg, createUser } from "./support/pglite";

/**
 * Migration 0133 (docs/superpowers/specs/2026-10-19-payee-invoice-link-design.md P1, P2, P4-P6): a payee link's two
 * options, set by a function of their own; the payee's invoice as a draft sent for review, one per link, through a
 * function that locks the link and checks it is live; the drafts' table taking a source with no extension connection;
 * and the link's status saying what it asks and whether its payee may still choose where it is paid.
 */

let db: PGlite;
let user: string;
let orgA: string;
let orgB: string;

const hash = (n: number) => n.toString(16).padStart(64, "0");
const hex = () => crypto.randomBytes(32).toString("hex");
const ADDRESS = `0x${"ab".repeat(20)}`;

async function payee(orgId: string, name: string, role = "vendor"): Promise<string> {
  return (await db.query<{ id: string }>("insert into public.counterparties (org_id, name, role) values ($1, $2, $3) returning id", [orgId, name, role])).rows[0].id;
}

async function link(orgId: string, counterpartyId: string, n: number, expiresAt = "2099-01-01T00:00:00Z"): Promise<string> {
  return (await db.query<{ id: string }>("select id from public.create_payee_link($1, $2, $3, $4, $5::timestamptz)", [orgId, counterpartyId, hash(n), user, expiresAt])).rows[0].id;
}

const options = async (orgId: string, linkId: string, asksInvoice: boolean, offersChain: boolean) =>
  (await db.query<{ set: boolean }>("select public.set_payee_link_options($1, $2, $3, $4) as set", [orgId, linkId, asksInvoice, offersChain])).rows[0].set;

const day = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

type Submitted = { draftId: string; linkId: string; orgId: string; counterpartyId: string; orgName: string; payeeName: string };

async function submit(
  n: number,
  values: Partial<{ number: string; amount: string; due: string; note: string | null; kind: string | null; sha: string | null; text: string | null }> = {}
): Promise<Submitted> {
  const result = await db.query<{ answer: Submitted }>("select public.submit_payee_invoice($1, $2, $3, $4::date, $5, $6, $7, $8, $9) as answer", [
    hash(n),
    values.number ?? "INV-7",
    values.amount ?? "1250.50",
    values.due ?? day(14),
    values.note === undefined ? "Design work for October" : values.note,
    values.kind === undefined ? null : values.kind,
    values.sha === undefined ? null : values.sha,
    values.text === undefined ? null : values.text,
    hex(),
  ]);
  return result.rows[0].answer;
}

type Status = { asksInvoice: boolean; offersChain: boolean; invoiceSent: boolean; chainOpen: boolean; linkState: string } | null;
const status = async (n: number): Promise<Status> =>
  (await db.query<{ payee_link_status: Status }>("select public.payee_link_status($1)", [hash(n)])).rows[0].payee_link_status;

const linkRow = async (id: string) =>
  (await db.query<{ asks_invoice: boolean; offers_chain: boolean; invoice_at: string | null }>("select asks_invoice, offers_chain, invoice_at from public.payee_links where id = $1", [id])).rows[0];

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
  user = await createUser(db, "owner@acme.test");
  orgA = await createOrg(db, "acme");
  orgB = await createOrg(db, "other");
}, 60_000);

afterAll(async () => {
  await db.close();
});

describe("payee link options (0133)", () => {
  it("are off on a new link, as 0039 makes it", async () => {
    const id = await link(orgA, await payee(orgA, "Plain"), 1);
    expect(await linkRow(id)).toEqual({ asks_invoice: false, offers_chain: false, invoice_at: null });
  });

  it("are set on an unused link of the workspace only, never a used, revoked or another workspace's one", async () => {
    const vendor = await payee(orgA, "Options");
    const id = await link(orgA, vendor, 2);
    expect(await options(orgB, id, true, true)).toBe(false);
    expect(await options(orgA, id, true, true)).toBe(true);
    expect(await linkRow(id)).toMatchObject({ asks_invoice: true, offers_chain: true });

    const used = await link(orgA, vendor, 3);
    await db.query("select * from public.claim_payee_link($1)", [hash(3)]);
    expect(await options(orgA, used, true, false)).toBe(false);
    expect(await linkRow(used)).toMatchObject({ asks_invoice: false });

    const old = await link(orgA, vendor, 4);
    await link(orgA, vendor, 5); // revokes link 4
    expect(await options(orgA, old, true, false)).toBe(false);
  });
});

describe("submit_payee_invoice (0133)", () => {
  it("adds the invoice as a draft sent for review, for the link's payee, and stamps the link", async () => {
    const vendor = await payee(orgA, "Linh Tran Design");
    const id = await link(orgA, vendor, 10);
    await options(orgA, id, true, false);
    const sha = hex();
    const answer = await submit(10, { kind: "pdf", sha, text: "Invoice INV-7\nTotal 1250.50 USDC" });
    expect(answer).toEqual({ draftId: expect.any(String), linkId: id, orgId: orgA, counterpartyId: vendor, orgName: "acme", payeeName: "Linh Tran Design" });

    const draft = (
      await db.query<Record<string, unknown>>(
        `select state, source, connection_id, payee_link_id, counterparty_id, supplier_name, invoice_number, amount, currency,
                to_char(due_date, 'YYYY-MM-DD') as due, document_kind, document_sha256, raw_text, read, captured_by, sent_at is not null as sent
           from public.invoice_drafts where id = $1`,
        [answer.draftId]
      )
    ).rows[0];
    expect(draft).toMatchObject({
      state: "sent",
      source: "payee_link",
      connection_id: null,
      payee_link_id: id,
      counterparty_id: vendor,
      supplier_name: "Linh Tran Design",
      invoice_number: "INV-7",
      amount: "1250.50",
      currency: "USDC",
      due: day(14),
      document_kind: "pdf",
      document_sha256: sha,
      raw_text: "Invoice INV-7\nTotal 1250.50 USDC",
      captured_by: null,
      sent: true,
    });
    expect(draft.read).toMatchObject({ via: "payee_link", reader: null, counterpartyName: "Linh Tran Design", note: "Design work for October", extracted: { counterpartyId: vendor, amount: "1250.50", dueDate: day(14) } });
    expect((await linkRow(id)).invoice_at).not.toBeNull();
  });

  it("takes one invoice per link", async () => {
    const id = await link(orgA, await payee(orgA, "Once"), 11);
    await options(orgA, id, true, false);
    await submit(11);
    await expect(submit(11, { number: "INV-8" })).rejects.toThrow(/payee_invoice_sent/);
    expect((await db.query("select id from public.invoice_drafts where payee_link_id = $1", [id])).rows).toHaveLength(1);
  });

  it("refuses a link that does not ask for an invoice", async () => {
    await link(orgA, await payee(orgA, "Not asked"), 12);
    await expect(submit(12)).rejects.toThrow(/payee_invoice_not_asked/);
  });

  it("refuses a revoked link, an expired unused one and one used more than 30 days ago, and takes one used within 30 days", async () => {
    const vendor = await payee(orgA, "Windows");
    const revoked = await link(orgA, vendor, 13);
    await options(orgA, revoked, true, false);
    await db.query("select public.revoke_payee_link($1, $2, $3)", [orgA, revoked, user]);
    await expect(submit(13)).rejects.toThrow(/payee_invoice_link_dead/);

    const expired = await link(orgA, vendor, 14, "2020-01-01T00:00:00Z");
    await db.query("update public.payee_links set asks_invoice = true where id = $1", [expired]);
    await expect(submit(14)).rejects.toThrow(/payee_invoice_link_dead/);

    const stale = await link(orgA, vendor, 15);
    await options(orgA, stale, true, false);
    await db.query("update public.payee_links set used_at = now() - interval '31 days', expires_at = now() - interval '24 days' where id = $1", [stale]);
    await expect(submit(15)).rejects.toThrow(/payee_invoice_link_dead/);

    const recent = await link(orgA, vendor, 16);
    await options(orgA, recent, true, false);
    await db.query("update public.payee_links set used_at = now() - interval '29 days', expires_at = now() - interval '22 days' where id = $1", [recent]);
    expect((await submit(16)).linkId).toBe(recent);
  });

  it("refuses an unknown token", async () => {
    await expect(submit(999)).rejects.toThrow(/payee_invoice_link_dead/);
  });

  it("checks the fields itself: number, amount, due day and note", async () => {
    const vendor = await payee(orgA, "Fields");
    const id = await link(orgA, vendor, 17);
    await options(orgA, id, true, false);
    await expect(submit(17, { number: "  " })).rejects.toThrow(/payee_invoice_invalid: the invoice number/);
    await expect(submit(17, { number: "x".repeat(101) })).rejects.toThrow(/payee_invoice_invalid: the invoice number/);
    await expect(submit(17, { amount: "0" })).rejects.toThrow(/payee_invoice_invalid: the amount/);
    await expect(submit(17, { amount: "1.1234567" })).rejects.toThrow(/payee_invoice_invalid: the amount/);
    await expect(submit(17, { amount: "-5" })).rejects.toThrow(/payee_invoice_invalid: the amount/);
    await expect(submit(17, { due: day(-1) })).rejects.toThrow(/payee_invoice_invalid: the due date/);
    await expect(submit(17, { due: day(370) })).rejects.toThrow(/payee_invoice_invalid: the due date/);
    await expect(submit(17, { note: "n".repeat(501) })).rejects.toThrow(/payee_invoice_invalid: the note/);
    // Nothing was written by a refusal, so the link still takes its invoice.
    expect((await linkRow(id)).invoice_at).toBeNull();
    expect((await submit(17, { due: day(0), note: null })).linkId).toBe(id);
  });

  it("runs for the service role, and for no browser or tenant role", async () => {
    await asServiceRole(db, (tx) => tx.query("select public.set_payee_link_options($1, $2, false, false)", [orgA, crypto.randomUUID()]));
    for (const role of ["anon", "authenticated"] as const) {
      await expect(asRole(db, role, (tx) => tx.query("select public.submit_payee_invoice($1, 'n', '1', current_date, null, null, null, null, $2)", [hash(1), hex()]))).rejects.toThrow(/permission denied/);
      await expect(asRole(db, role, (tx) => tx.query("select public.set_payee_link_options($1, $2, true, true)", [orgA, crypto.randomUUID()]))).rejects.toThrow(/permission denied/);
    }
    await expect(asTenant(db, orgA, (tx) => tx.query("select public.submit_payee_invoice($1, 'n', '1', current_date, null, null, null, null, $2)", [hash(1), hex()]))).rejects.toThrow(/permission denied/);
    await expect(asTenant(db, orgA, (tx) => tx.query("select public.set_payee_link_options($1, $2, true, true)", [orgA, crypto.randomUUID()]))).rejects.toThrow(/permission denied/);
  });
});

describe("invoice_drafts with a payee link source (0133)", () => {
  const insert = (values: { source: string; connection: string | null; link: string | null }) =>
    db.query(
      `insert into public.invoice_drafts (org_id, state, source, connection_id, payee_link_id, idempotency_key, request_sha256)
       values ($1, 'sent', $2, $3, $4, $5, $6)`,
      [orgA, values.source, values.connection, values.link, crypto.randomUUID(), hex()]
    );

  it("needs an extension connection for anything but a payee link, and a link exactly for one", async () => {
    await expect(insert({ source: "selection", connection: null, link: null })).rejects.toThrow(/invoice_drafts_connection_check/);
    await expect(insert({ source: "payee_link", connection: null, link: null })).rejects.toThrow(/invoice_drafts_payee_link_check/);
    await expect(insert({ source: "file", connection: crypto.randomUUID(), link: crypto.randomUUID() })).rejects.toThrow(/invoice_drafts_payee_link_check/);
    await expect(insert({ source: "email", connection: crypto.randomUUID(), link: null })).rejects.toThrow(/invoice_drafts_source_check/);
    await insert({ source: "file", connection: crypto.randomUUID(), link: null });
  });

  it("keeps one draft per payee link", async () => {
    const id = crypto.randomUUID();
    await insert({ source: "payee_link", connection: null, link: id });
    await expect(insert({ source: "payee_link", connection: null, link: id })).rejects.toThrow(/invoice_drafts_payee_link_key/);
  });

  it("never changes the link a draft came through, and decides it like any sent draft", async () => {
    const id = await link(orgA, await payee(orgA, "Guarded"), 20);
    await options(orgA, id, true, false);
    const { draftId } = await submit(20);
    await expect(db.query("update public.invoice_drafts set payee_link_id = $2 where id = $1", [draftId, crypto.randomUUID()])).rejects.toThrow(/invoice_draft_fixed/);
    await expect(db.query("update public.invoice_drafts set amount = '1.00' where id = $1", [draftId])).rejects.toThrow(/invoice_draft_sent/);
    await db.query("update public.invoice_drafts set state = 'discarded', raw_text = null where id = $1", [draftId]);
  });

  it("is a workspace's own, as every draft is", async () => {
    const id = await link(orgA, await payee(orgA, "Isolated"), 21);
    await options(orgA, id, true, false);
    const { draftId } = await submit(21);
    expect((await asTenant(db, orgB, (tx) => tx.query("select id from public.invoice_drafts where id = $1", [draftId]))).rows).toEqual([]);
    expect((await asTenant(db, orgA, (tx) => tx.query("select id from public.invoice_drafts where id = $1", [draftId]))).rows).toHaveLength(1);
  });
});

describe("payee_link_status (0133)", () => {
  it("says what the link asks, whether its invoice arrived, and keeps the rest of 0078's answer", async () => {
    const vendor = await payee(orgA, "Status");
    const id = await link(orgA, vendor, 30);
    expect(await status(30)).toMatchObject({ asksInvoice: false, offersChain: false, invoiceSent: false, chainOpen: false, linkState: "open", orgName: "acme", payeeName: "Status" });
    await options(orgA, id, true, true);
    expect(await status(30)).toMatchObject({ asksInvoice: true, offersChain: true, invoiceSent: false, chainOpen: true });
    await submit(30);
    expect(await status(30)).toMatchObject({ invoiceSent: true });
  });

  it("lets the payee choose its chain only while the link is unused, for a vendor with no address and no payment", async () => {
    const open = async (n: number) => (await status(n))?.chainOpen;

    const contractor = await payee(orgA, "A contractor", "contractor");
    await options(orgA, await link(orgA, contractor, 31), false, true);
    expect(await open(31)).toBe(false);

    const addressed = await payee(orgA, "Has an address");
    await db.query("update public.counterparties set address = $2 where id = $1", [addressed, ADDRESS]);
    await options(orgA, await link(orgA, addressed, 32), false, true);
    expect(await open(32)).toBe(false);

    const paid = await payee(orgA, "Paid once");
    const invoice = (
      await db.query<{ id: string }>(
        "insert into public.invoices (org_id, counterparty_id, direction, amount, currency, due_date, status) values ($1, $2, 'payable', 10, 'USDC', now(), 'paid') returning id",
        [orgA, paid]
      )
    ).rows[0].id;
    await options(orgA, await link(orgA, paid, 33), false, true);
    expect(await open(33)).toBe(true);
    await db.query(
      "insert into public.payment_intents (org_id, source_type, source_id, idempotency_key, provider, amount, destination, status) values ($1, 'invoice', $2, $3, 'simulate', 10, '0x1', 'confirmed')",
      [orgA, invoice, crypto.randomUUID()]
    );
    expect(await open(33)).toBe(false);

    const used = await payee(orgA, "Used link");
    await options(orgA, await link(orgA, used, 34), false, true);
    await db.query("select * from public.claim_payee_link($1)", [hash(34)]);
    expect(await open(34)).toBe(false);
  });

  it("is still the service role's alone", async () => {
    for (const role of ["anon", "authenticated"] as const) {
      await expect(asRole(db, role, (tx) => tx.query("select public.payee_link_status($1)", [hash(30)]))).rejects.toThrow(/permission denied/);
    }
    await expect(asTenant(db, orgA, (tx) => tx.query("select public.payee_link_status($1)", [hash(30)]))).rejects.toThrow(/permission denied/);
  });
});

describe("re-running the migrations (0133)", () => {
  it("keeps the options, the drafts and 0133's guard and status after 0039, 0078, 0121 and 0133 run again", async () => {
    const vendor = await payee(orgA, "Re-run");
    const id = await link(orgA, vendor, 40);
    await options(orgA, id, true, true);
    const { draftId } = await submit(40);

    await applyMigrations(db, (file) => ["0039_", "0078_", "0121_", "0133_"].some((prefix) => file.startsWith(prefix)));

    expect(await linkRow(id)).toMatchObject({ asks_invoice: true, offers_chain: true, invoice_at: expect.anything() });
    expect((await db.query("select source from public.invoice_drafts where id = $1", [draftId])).rows).toEqual([{ source: "payee_link" }]);
    await expect(db.query("update public.invoice_drafts set payee_link_id = $2 where id = $1", [draftId, crypto.randomUUID()])).rejects.toThrow(/invoice_draft_fixed/);
    expect(await status(40)).toMatchObject({ asksInvoice: true, invoiceSent: true });
    await expect(submit(40)).rejects.toThrow(/payee_invoice_sent/);
  });
});
